# Development backend with cargo-watch for hot reload
# Rolling stable — sqlx 0.9 MSRV is 1.94; do not pin below it.
FROM rust:1-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    libssl-dev \
    pkg-config \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install cargo-watch for hot reload
RUN cargo install cargo-watch --locked

WORKDIR /app

# Pre-download dependencies layer (will be rebuilt when Cargo.toml changes)
COPY backend/Cargo.toml backend/Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && touch src/lib.rs && cargo build 2>/dev/null || true
RUN rm -rf src

EXPOSE 8080

# Hot reload: recompile and restart on source changes
CMD ["cargo", "watch", "-x", "run", "--no-vcs-ignores"]
