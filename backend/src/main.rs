use cloudatlas_lib::{config, crypto, db, modules, routes, state};
use std::net::SocketAddr;
use tracing::{info, warn};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Load .env if present (dev mode)
    let _ = dotenvy::dotenv();

    // Initialize tracing
    let subscriber = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,cloudatlas=debug".into()),
        )
        .with_target(true)
        .json()
        .finish();
    tracing::subscriber::set_global_default(subscriber)?;

    // Load configuration
    let cfg = config::Config::from_env()?;

    // Optional error tracking (G7): SENTRY_DSN enables Sentry ingestion.
    let _sentry_guard = if let Some(dsn) = &cfg.sentry_dsn {
        let guard = sentry::init((
            dsn.clone(),
            sentry::ClientOptions {
                release: sentry::release_name!(),
                environment: Some(cfg.app_env.clone().into()),
                ..Default::default()
            },
        ));
        tracing::info!("Sentry error tracking enabled");
        Some(guard)
    } else {
        None
    };

    // Verify at-rest credential key before starting: a wrong/missing
    // ENCRYPTION_KEY would silently make all stored credentials undecryptable.
    if crypto::key_from_hex(&cfg.encryption_key).is_none() {
        anyhow::bail!(
            "ENCRYPTION_KEY must be exactly 64 hexadecimal characters (openssl rand -hex 32); refusing to start with undecryptable credentials"
        );
    }
    if cfg.encryption_key.chars().all(|c| c == '0') {
        warn!(
            "ENCRYPTION_KEY is all zeros — safe for local dev, DO NOT use in production"
        );
    }

    // Refuse weak JWT secrets: rotation is supported by restarting with a new
    // JWT_SECRET (existing sessions expire on their natural TTL).
    if cfg.jwt_secret.len() < 32 {
        anyhow::bail!(
            "JWT_SECRET must be at least 32 characters (openssl rand -hex 32); refusing to start with a weak signing key"
        );
    }
    if cfg.jwt_secret.chars().all(|c| c == '0') {
        warn!("JWT_SECRET is all zeros — safe for local dev, DO NOT use in production");
    }

    info!(
        app = %cfg.app_name,
        env = %cfg.app_env,
        host = %cfg.host,
        port = cfg.port,
        "Starting CloudAtlas"
    );

    // Connect to PostgreSQL
    let pool = db::create_pool(
        &cfg.database_url,
        cfg.db_max_connections,
        cfg.db_min_connections,
        cfg.db_idle_timeout_secs,
        cfg.db_max_lifetime_secs,
        cfg.db_acquire_timeout_secs,
    )
    .await?;
    info!("Database connected");

    // Run migrations
    db::run_migrations(&pool).await?;
    info!("Migrations applied");

    // Build app state
    let state = state::AppState::new(pool, cfg.clone());

    // Start background scheduler
    let scheduler_state = state.clone();
    tokio::spawn(async move {
        modules::scheduler::start(scheduler_state).await;
    });

    // Build Axum router
    let app = routes::build_router(state);

    // Bind and serve
    let addr: SocketAddr = format!("{}:{}", cfg.host, cfg.port).parse()?;
    info!("Listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
