# Migration runner (runs sqlx migrate, then exits 0)
FROM rust:1-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    libssl-dev \
    pkg-config \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN cargo install sqlx-cli --no-default-features --features postgres --locked

WORKDIR /app
COPY backend/migrations ./migrations

CMD ["sqlx", "migrate", "run", "--source", "./migrations"]
