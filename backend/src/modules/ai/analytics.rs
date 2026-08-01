//! In-process time-series analytics: Holt-Winters triple exponential smoothing
//! forecasting and z-score anomaly detection. No external services required.

/// Triple exponential smoothing forecast (additive trend + additive seasonality).
///
/// Returns `h` forecasted values continuing `series`. When the series is too
/// short for seasonality, falls back to a simple level+trend (Holt) model.
pub fn holt_winters_forecast(series: &[f64], h: usize, season: usize) -> Vec<f64> {
    if series.is_empty() {
        return vec![0.0; h];
    }
    if series.len() < 2 * season.min(series.len()).max(2) {
        // Too short for seasonality — plain Holt linear trend.
        let n = series.len() as f64;
        let mean = series.iter().sum::<f64>() / n;
        let slope = if n > 1.0 {
            let mut num = 0.0;
            let mut den = 0.0;
            let mid = (n - 1.0) / 2.0;
            for (i, y) in series.iter().enumerate() {
                let x = i as f64 - mid;
                num += x * y;
                den += x * x;
            }
            if den.abs() > 1e-12 { num / den } else { 0.0 }
        } else {
            0.0
        };
        return (1..=h).map(|i| mean + slope * i as f64).collect();
    }

    let (alpha, beta, gamma) = fit_holt_winters(series, season);
    let m = season as f64;

    // Initialize level/trend/seasonal from the first season.
    let first_season: f64 = series[..season].iter().sum::<f64>() / season as f64;
    let mut level = first_season;
    let mut trend = (series[season.min(series.len() - 1)] - first_season) / m;
    let mut seasonal: Vec<f64> = series[..season]
        .iter()
        .map(|y| y - first_season)
        .collect();

    let mut last = level + trend + seasonal[0];
    for (i, y) in series.iter().enumerate() {
        let s_idx = i % season;
        let prev_level = level;
        level = alpha * (y - seasonal[s_idx]) + (1.0 - alpha) * (prev_level + trend);
        trend = beta * (level - prev_level) + (1.0 - beta) * trend;
        seasonal[s_idx] = gamma * (y - level) + (1.0 - gamma) * seasonal[s_idx];
        last = *y;
    }

    let mut out = Vec::with_capacity(h);
    for i in 1..=h {
        let s_idx = (series.len() - season + i) % season;
        let v = last + trend * i as f64 + seasonal[s_idx];
        out.push(v.max(0.0));
    }
    out
}

/// Grid-search alpha/beta/gamma minimizing one-step-ahead SSE.
fn fit_holt_winters(series: &[f64], season: usize) -> (f64, f64, f64) {
    let candidates = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
    let mut best = (0.5, 0.1, 0.1);
    let mut best_sse = f64::MAX;

    for &alpha in &candidates {
        for &beta in &candidates {
            for &gamma in &candidates {
                let sse = one_step_sse(series, season, alpha, beta, gamma);
                if sse < best_sse {
                    best_sse = sse;
                    best = (alpha, beta, gamma);
                }
            }
        }
    }
    best
}

fn one_step_sse(series: &[f64], season: usize, alpha: f64, beta: f64, gamma: f64) -> f64 {
    let first_season: f64 = series[..season].iter().sum::<f64>() / season as f64;
    let mut level = first_season;
    let mut trend = (series[season.min(series.len() - 1)] - first_season) / season as f64;
    let mut seasonal: Vec<f64> = series[..season]
        .iter()
        .map(|y| y - first_season)
        .collect();

    let mut sse = 0.0;
    for (i, y) in series.iter().enumerate() {
        let s_idx = i % season;
        let prev_level = level;
        level = alpha * (y - seasonal[s_idx]) + (1.0 - alpha) * (prev_level + trend);
        trend = beta * (level - prev_level) + (1.0 - beta) * trend;
        seasonal[s_idx] = gamma * (y - level) + (1.0 - gamma) * seasonal[s_idx];
        if i >= season {
            let pred = prev_level + trend + seasonal[s_idx];
            sse += (y - pred).powi(2);
        }
    }
    sse
}

/// Z-score anomaly detection on a daily series. Flags points whose |z| exceeds
/// `threshold` and whose absolute deviation exceeds `min_delta` (guards against
/// flagging tiny wobbles in near-zero series).
pub fn zscore_anomalies(
    series: &[(chrono::NaiveDate, f64)],
    threshold: f64,
    min_delta: f64,
) -> Vec<(chrono::NaiveDate, f64, f64, String)> {
    if series.len() < 4 {
        return Vec::new();
    }
    let values: Vec<f64> = series.iter().map(|(_, v)| *v).collect();
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let variance = values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / values.len() as f64;
    let std = variance.sqrt();
    if std < 1e-9 {
        return Vec::new();
    }

    let mut out = Vec::new();
    for (date, v) in series {
        let z = (v - mean) / std;
        if z.abs() >= threshold && (v - mean).abs() >= min_delta {
            let direction = if *v > mean { "spike" } else { "drop" };
            out.push((*date, *v, z, direction.to_string()));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forecast_continues_trend() {
        // Perfect linear series 10, 20, 30, ... — forecast must continue.
        let series: Vec<f64> = (1..=30).map(|i| i as f64 * 10.0).collect();
        let fc = holt_winters_forecast(&series, 3, 7);
        assert_eq!(fc.len(), 3);
        assert!(fc[0] > 300.0, "forecast continues upward: {fc:?}");
        assert!(fc[2] > fc[0]);
    }

    #[test]
    fn forecast_short_series_falls_back_to_trend() {
        let series = vec![5.0, 6.0, 7.0, 8.0];
        let fc = holt_winters_forecast(&series, 2, 7);
        assert_eq!(fc.len(), 2);
        // Least-squares slope 1.0 anchored at the mean (6.5) → next ≈ 7.5.
        assert!(fc[0] > 7.0, "continues upward: {fc:?}");
        assert!(fc[1] > fc[0]);
    }

    #[test]
    fn zscore_detects_spike() {
        let mut series: Vec<(chrono::NaiveDate, f64)> = Vec::new();
        let base = chrono::NaiveDate::from_ymd_opt(2026, 8, 1).unwrap();
        for i in 0..30 {
            series.push((base + chrono::Duration::days(i), 100.0));
        }
        series[15] = (base + chrono::Duration::days(15), 500.0); // spike

        let anomalies = zscore_anomalies(&series, 2.5, 10.0);
        assert_eq!(anomalies.len(), 1);
        assert_eq!(anomalies[0].3, "spike");
        assert!(anomalies[0].2.abs() > 2.5);
    }

    #[test]
    fn zscore_flat_series_no_anomalies() {
        let base = chrono::NaiveDate::from_ymd_opt(2026, 8, 1).unwrap();
        let series: Vec<(chrono::NaiveDate, f64)> = (0..20)
            .map(|i| (base + chrono::Duration::days(i), 50.0))
            .collect();
        assert!(zscore_anomalies(&series, 2.5, 10.0).is_empty());
    }
}
