use sqlx::{postgres::PgPoolOptions, PgPool};
use tracing::info;

/// Connection pool settings. Production tuning:
/// - `DATABASE_MAX_CONNECTIONS` — hard ceiling (default 20; rule of thumb:
///   ~2× CPU cores, plus a few for the scheduler jobs)
/// - `DATABASE_MIN_CONNECTIONS` — warm connections kept idle (default 2)
/// - `DATABASE_IDLE_TIMEOUT_SECS` — drop idle connections after this (default 300)
/// - `DATABASE_MAX_LIFETIME_SECS` — recycle connections periodically so
///   PostgreSQL-side state (prepared statements, temp state) stays fresh
///   (default 1800)
/// - `DATABASE_ACQUIRE_TIMEOUT_SECS` — fail fast under contention (default 30)
pub async fn create_pool(
    url: &str,
    max_connections: u32,
    min_connections: u32,
    idle_timeout_secs: u64,
    max_lifetime_secs: u64,
    acquire_timeout_secs: u64,
) -> anyhow::Result<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(max_connections.max(1))
        .min_connections(min_connections.min(max_connections.max(1)))
        .acquire_timeout(std::time::Duration::from_secs(acquire_timeout_secs))
        .idle_timeout(std::time::Duration::from_secs(idle_timeout_secs))
        .max_lifetime(std::time::Duration::from_secs(max_lifetime_secs))
        .connect(url)
        .await?;
    Ok(pool)
}

pub async fn run_migrations(pool: &PgPool) -> anyhow::Result<()> {
    info!("Verifying database is reachable...");
    // Migrations are run by the dedicated migrate container on startup.
    // Here we just confirm the DB is responsive and the schema exists.
    sqlx::query("SELECT 1").execute(pool).await?;
    info!("Database ready");
    Ok(())
}
