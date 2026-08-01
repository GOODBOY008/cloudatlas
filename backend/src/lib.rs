// lib.rs — re-exports all modules so integration tests can link against them
pub mod config;
pub mod crypto;
pub mod db;
pub mod error;
pub mod metrics;
pub mod middleware;
pub mod modules;
pub mod routes;
pub mod state;
pub mod utils;

pub use error::{AppError, AppResult};
