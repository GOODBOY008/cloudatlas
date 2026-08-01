# ────────────────────────────────────────────────────────────────────────────
# Stage 1: Build dependencies (layer-cached)
# ────────────────────────────────────────────────────────────────────────────
FROM rust:1-bookworm AS deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Copy manifests only for dependency caching
COPY backend/Cargo.toml backend/Cargo.lock ./
# Create dummy main and lib to build deps
RUN mkdir -p src && echo 'fn main() {}' > src/main.rs && touch src/lib.rs
RUN cargo build --release && rm -rf src

# ────────────────────────────────────────────────────────────────────────────
# Stage 2: Build application
# ────────────────────────────────────────────────────────────────────────────
FROM deps AS builder
COPY backend/src ./src
COPY backend/migrations ./migrations
# Touch main.rs and lib.rs to force rebuild of our code (not cached deps)
RUN touch src/main.rs src/lib.rs
RUN cargo build --release --bin cloudatlas

# ────────────────────────────────────────────────────────────────────────────
# Stage 5: Runtime (minimal image)
# ────────────────────────────────────────────────────────────────────────────
FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    libssl3 \
    ca-certificates \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Non-root user
RUN useradd -m -u 1001 cloudatlas
USER cloudatlas
WORKDIR /app

COPY --from=builder /app/target/release/cloudatlas /app/cloudatlas

EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
    CMD wget -qO- http://localhost:8080/health || exit 1

CMD ["/app/cloudatlas"]
