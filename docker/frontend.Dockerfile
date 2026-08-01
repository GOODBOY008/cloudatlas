# ────────────────────────────────────────────────────────────────────────────
# Stage 1: Build React app
# ────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

# Install deps first (better layer caching)
COPY frontend/package*.json ./
RUN npm ci

# Copy source and build
COPY frontend/ .
ARG VITE_API_BASE_URL=/api/v1
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build

# ────────────────────────────────────────────────────────────────────────────
# Stage 2: Serve with nginx
# ────────────────────────────────────────────────────────────────────────────
FROM nginx:alpine AS runtime

COPY --from=builder /app/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
HEALTHCHECK --interval=10s --timeout=5s \
    CMD curl -sf http://localhost/health.txt || exit 1

CMD ["nginx", "-g", "daemon off;"]
