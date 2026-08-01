/// Unit tests for the billing import modules.
/// Tests mock data generation for AWS CUR and Aliyun BSS importers.

use cloudatlas_lib::modules::billing::{aws_cur, aliyun_bss};

// ─── AWS CUR mock data ────────────────────────────────────────────────────────

#[test]
fn test_aws_cur_mock_generates_expected_count() {
    let days: i64 = 7;
    let items = aws_cur::generate_mock_cur_data(days);
    // 5 services × 7 days = 35 line items
    assert_eq!(items.len(), 5 * days as usize);
}

#[test]
fn test_aws_cur_mock_has_positive_cost() {
    let items = aws_cur::generate_mock_cur_data(1);
    for item in &items {
        assert!(item.cost_usd > 0.0, "cost_usd should be positive: {}", item.cost_usd);
    }
}

#[test]
fn test_aws_cur_mock_currency_usd() {
    let items = aws_cur::generate_mock_cur_data(1);
    for item in &items {
        assert_eq!(item.currency, "USD");
    }
}

#[test]
fn test_aws_cur_mock_different_services() {
    let items = aws_cur::generate_mock_cur_data(1);
    let services: std::collections::HashSet<&str> =
        items.iter().map(|i| i.service_name.as_str()).collect();
    assert!(services.len() >= 2, "expected multiple services, got {}", services.len());
}

// ─── Aliyun BSS mock data ─────────────────────────────────────────────────────

#[test]
fn test_aliyun_bss_mock_generates_expected_count() {
    let days: i64 = 5;
    let items = aliyun_bss::generate_mock_bss_data(days);
    // 7 products × 5 days = 35 line items
    assert_eq!(items.len(), 7 * days as usize);
}

#[test]
fn test_aliyun_bss_mock_has_positive_cost() {
    let items = aliyun_bss::generate_mock_bss_data(1);
    for item in &items {
        assert!(item.pretax_amount > 0.0);
    }
}

#[test]
fn test_aliyun_bss_mock_currency_cny() {
    let items = aliyun_bss::generate_mock_bss_data(1);
    for item in &items {
        assert_eq!(item.currency, "CNY");
    }
}
