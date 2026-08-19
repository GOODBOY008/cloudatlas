//! Currency FX helpers: per-org static exchange-rate table with USD-pivot
//! resolution. Rates are admin-editable (`exchange_rates` table); conversion
//! happens at ingest so all stored `expenses.cost` values are in the org
//! display currency. Missing rates never fail an import — the caller stores
//! the amount unconverted and logs a warning (D5).

use sqlx::{PgPool, Row};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Debug, Clone, Default)]
pub struct FxTable {
    /// (from, to) -> rate; amount_in_to = amount_in_from * rate
    rates: HashMap<(String, String), f64>,
}

impl FxTable {
    pub fn insert(&mut self, from: &str, to: &str, rate: f64) {
        self.rates
            .insert((from.to_uppercase(), to.to_uppercase()), rate);
    }

    /// Convert `amount` from one currency to another.
    /// Returns None when no direct rate and no USD pivot exists.
    pub fn convert(&self, amount: f64, from: &str, to: &str) -> Option<f64> {
        let from = from.to_uppercase();
        let to = to.to_uppercase();
        if from == to {
            return Some(amount);
        }
        if let Some(r) = self.rates.get(&(from.clone(), to.clone())) {
            return Some(amount * r);
        }
        // Pivot through USD when both legs exist.
        if let (Some(r1), Some(r2)) = (
            self.rates.get(&(from.clone(), "USD".into())),
            self.rates.get(&("USD".into(), to.clone())),
        ) {
            return Some(amount * r1 * r2);
        }
        None
    }

    pub fn is_identity(&self, from: &str, to: &str) -> bool {
        from.eq_ignore_ascii_case(to)
    }
}

/// Load the org's rate table. Any DB error degrades to an empty table
/// (imports then store unconverted amounts with warnings, per D5).
pub async fn load_rates(db: &PgPool, org_id: Uuid) -> FxTable {
    let mut table = FxTable::default();
    let rows = sqlx::query(
        r#"SELECT from_currency, to_currency, rate::float8 AS rate
           FROM exchange_rates WHERE organization_id = $1"#,
    )
    .bind(org_id)
    .fetch_all(db)
    .await;
    if let Ok(rows) = rows {
        for r in rows {
            let from: String = r.get("from_currency");
            let to: String = r.get("to_currency");
            let rate: f64 = r.get("rate");
            table.insert(from.trim(), to.trim(), rate);
        }
    }
    table
}

/// Org display currency from settings JSON; USD when unset.
pub async fn org_currency(db: &PgPool, org_id: Uuid) -> String {
    sqlx::query_scalar::<_, String>(
        r#"SELECT COALESCE(settings->>'currency', 'USD')
           FROM organizations WHERE id = $1"#,
    )
    .bind(org_id)
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
    .unwrap_or_else(|| "USD".into())
}

/// Convert and report: (converted_amount, converted?) — callers warn on false.
pub fn convert_or_warn(
    table: &FxTable,
    amount: f64,
    from: &str,
    to: &str,
    warn_ctx: &str,
) -> (f64, bool) {
    match table.convert(amount, from, to) {
        Some(v) => (v, true),
        None => {
            tracing::warn!(
                context = warn_ctx,
                from = from,
                to = to,
                amount = amount,
                "FX rate missing — storing unconverted amount"
            );
            (amount, false)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> FxTable {
        let mut t = FxTable::default();
        t.insert("USD", "CNY", 7.25);
        t.insert("CNY", "USD", 0.1379);
        t.insert("EUR", "USD", 1.087);
        t
    }

    #[test]
    fn identity_is_passthrough() {
        let t = table();
        assert_eq!(t.convert(123.45, "USD", "USD"), Some(123.45));
        assert_eq!(t.convert(1.0, "usd", "USD"), Some(1.0)); // case-insensitive
        assert!(t.is_identity("cny", "CNY"));
    }

    #[test]
    fn direct_rate_converts() {
        let t = table();
        let v = t.convert(1000.0, "CNY", "USD").unwrap();
        assert!((v - 137.9).abs() < 0.01);
    }

    #[test]
    fn usd_pivot_resolves_cross_pair() {
        let t = table();
        // No direct EUR->CNY; pivot EUR->USD->CNY = 1.087 * 7.25
        let v = t.convert(100.0, "EUR", "CNY").unwrap();
        assert!((v - 100.0 * 1.087 * 7.25).abs() < 1e-6);
    }

    #[test]
    fn missing_rate_returns_none() {
        let t = table();
        assert_eq!(t.convert(5.0, "JPY", "CNY"), None);
        assert_eq!(FxTable::default().convert(5.0, "USD", "CNY"), None);
    }

    #[test]
    fn convert_or_warn_reports_unconverted() {
        let t = table();
        let (v, ok) = convert_or_warn(&t, 50.0, "CNY", "USD", "test");
        assert!(ok);
        assert!((v - 6.895).abs() < 0.01);
        let (v, ok) = convert_or_warn(&t, 50.0, "JPY", "CNY", "test");
        assert!(!ok);
        assert_eq!(v, 50.0);
    }
}
