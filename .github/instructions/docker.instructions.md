---
description: "Use when writing Dockerfiles, docker-compose files, or nginx config for CloudAtlas. Covers multi-stage Rust builds with cargo-chef, nginx SPA config, health checks, and compose service definitions."
applyTo: ["docker/**", "docker-compose*.yml", "**/Dockerfile*"]
---

# Docker & Deployment Patterns

## Backend Dockerfile (Multi-Stage + cargo-chef)

```dockerfile
# Stage 1: Dependency caching with cargo-chef
FROM rust:1.78-bookworm AS chef
RUN cargo install cargo-chef --locked
WORKDIR /app

FROM chef AS planner
COPY backend/ .
RUN cargo chef prepare --recipe-path recipe.json

# Stage 2: Build dependencies (cached layer)
FROM chef AS builder
COPY --from=planner /app/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json
# Now copy source and build (only recompiles changed code)
COPY backend/ .
RUN cargo build --release --bin cloudatlas

# Stage 3: Minimal runtime image
FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y ca-certificates wget && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/target/release/cloudatlas ./cloudatlas
COPY --from=builder /app/migrations ./migrations
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
  CMD wget -qO- http://localhost:8080/health || exit 1
ENV RUST_LOG=info
CMD ["./cloudatlas"]
```

## Frontend Dockerfile (Multi-Stage + nginx)

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci --frozen-lockfile
COPY frontend/ .
ARG VITE_API_BASE_URL=/api/v1
RUN npm run build

FROM nginx:1.25-alpine AS runtime
COPY --from=builder /app/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://localhost/health.txt || exit 1
```

## nginx.conf (SPA + API Proxy)

```nginx
server {
  listen 80;
  root /usr/share/nginx/html;
  index index.html;
  gzip on;
  gzip_types text/plain text/css application/json application/javascript;

  # Health check endpoint for container orchestration
  location /health.txt {
    return 200 "ok\n";
    add_header Content-Type text/plain;
  }

  # Proxy API requests to backend
  location /api/ {
    proxy_pass http://api:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 60s;
  }

  # SPA fallback — all non-file requests serve index.html
  location / {
    try_files $uri $uri/ /index.html;
  }
}
```

## Migration Dockerfile

```dockerfile
FROM rust:1.78-bookworm AS builder
RUN cargo install sqlx-cli --features postgres --no-default-features --locked

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y libssl-dev ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /usr/local/cargo/bin/sqlx /usr/local/bin/sqlx
COPY backend/migrations /migrations
WORKDIR /migrations
CMD ["sqlx", "migrate", "run", "--source", "/migrations"]
```

## docker-compose.yml (Production Stack)

```yaml
services:
  postgres:
    image: postgres:15-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: ${POSTGRES_DB:-cloudatlas}
      POSTGRES_USER: ${POSTGRES_USER:-cloudatlas}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-cloudatlas}"]
      interval: 5s
      timeout: 3s
      retries: 10

  migrate:
    build:
      context: .
      dockerfile: docker/migrate.Dockerfile
    environment:
      DATABASE_URL: ${DATABASE_URL}
    depends_on:
      postgres:
        condition: service_healthy
    restart: on-failure

  api:
    build:
      context: .
      dockerfile: docker/backend.Dockerfile
    restart: unless-stopped
    environment:
      DATABASE_URL: ${DATABASE_URL}
      JWT_SECRET: ${JWT_SECRET}
      ENCRYPTION_KEY: ${ENCRYPTION_KEY}
      RUST_LOG: ${RUST_LOG:-info}
    depends_on:
      migrate:
        condition: service_completed_successfully
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8080/health"]
      interval: 10s
      timeout: 5s
      retries: 5

  web:
    build:
      context: .
      dockerfile: docker/frontend.Dockerfile
      args:
        VITE_API_BASE_URL: /api/v1
    restart: unless-stopped
    ports:
      - "${APP_PORT:-3000}:80"
    depends_on:
      api:
        condition: service_healthy

volumes:
  pgdata:
```

## Dev Compose (PostgreSQL Only)

```yaml
# docker-compose.dev.yml — run postgres locally, start backend/frontend natively
services:
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: cloudatlas
      POSTGRES_USER: cloudatlas
      POSTGRES_PASSWORD: cloudatlas
    ports:
      - "5432:5432"
    volumes:
      - pgdata_dev:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U cloudatlas"]
      interval: 5s
      timeout: 3s
      retries: 10

  pgadmin:
    image: dpage/pgadmin4:latest
    profiles: [tools]
    environment:
      PGADMIN_DEFAULT_EMAIL: admin@cloudatlas.dev
      PGADMIN_DEFAULT_PASSWORD: admin
    ports:
      - "5050:80"

volumes:
  pgdata_dev:
```

## Security Conventions

- **Secrets**: never hardcode in Dockerfile or compose. Use `${VAR}` from `.env` file.
- **`.env` is gitignored**. Only `.env.example` is committed.
- Non-root user: add `USER appuser` in runtime stages.
- **Credential encryption**: cloud credentials stored as AES-256-GCM encrypted text in DB. `ENCRYPTION_KEY` is 64 hex chars (`openssl rand -hex 32`).
- `JWT_SECRET`: minimum 64 hex chars (`openssl rand -hex 64`).
