/// Unit tests for the expense module DTOs, pool response, and query structures.
/// Tests are pure unit tests and do not require a live database.

use cloudatlas_lib::modules::expense::dto::{
    CreatePoolRequest, ExpenseQuery, PoolResponse, RegionCost, ServiceCost,
    TopResourceEntry, TrendPoint, UpdatePoolRequest,
};
use chrono::Utc;
use uuid::Uuid;

// ─── ExpenseQuery defaults ────────────────────────────────────────────────────

#[test]
fn test_expense_query_default_is_empty() {
    let q = ExpenseQuery::default();
    assert!(q.start_date.is_none());
    assert!(q.end_date.is_none());
    assert!(q.cloud_account_id.is_none());
    assert!(q.pool_id.is_none());
    assert!(q.resource_type.is_none());
    assert!(q.cloud_region.is_none());
    assert!(q.page.page.is_none());
    assert!(q.page.per_page.is_none());
    assert!(q.page.limit.is_none());
    assert!(q.page.offset.is_none());
}

#[test]
fn test_expense_query_with_date_range() {
    let q = ExpenseQuery {
        start_date: Some("2024-01-01".into()),
        end_date: Some("2024-01-31".into()),
        page: cloudatlas_lib::utils::pagination::PageQuery {
            limit: Some("100".into()),
            ..Default::default()
        },
        ..Default::default()
    };
    assert_eq!(q.start_date.as_deref(), Some("2024-01-01"));
    assert_eq!(q.end_date.as_deref(), Some("2024-01-31"));
    assert_eq!(q.page.limit.as_deref(), Some("100"));
}

// ─── ServiceCost ──────────────────────────────────────────────────────────────

#[test]
fn test_service_cost_fields() {
    let sc = ServiceCost {
        service_name: "Amazon EC2".into(),
        cost: 1234.56,
        percentage: 45.2,
    };
    assert_eq!(sc.service_name, "Amazon EC2");
    assert!((sc.cost - 1234.56).abs() < 1e-9);
    assert!((sc.percentage - 45.2).abs() < 1e-9);
}

#[test]
fn test_region_cost_fields() {
    let rc = RegionCost {
        region: "us-east-1".into(),
        cost: 500.0,
        percentage: 22.5,
    };
    assert_eq!(rc.region, "us-east-1");
    assert!((rc.cost - 500.0).abs() < 1e-9);
}

// ─── TrendPoint ───────────────────────────────────────────────────────────────

#[test]
fn test_trend_point_date_format() {
    let point = TrendPoint {
        date: "2024-06-15".into(),
        cost: 299.99,
    };
    assert_eq!(point.date.len(), 10, "date should be YYYY-MM-DD");
    assert!(point.date.contains('-'));
    assert!(point.cost > 0.0);
}

#[test]
fn test_trend_points_are_sortable() {
    let mut points = vec![
        TrendPoint { date: "2024-03-03".into(), cost: 100.0 },
        TrendPoint { date: "2024-03-01".into(), cost: 80.0 },
        TrendPoint { date: "2024-03-02".into(), cost: 90.0 },
    ];
    points.sort_by(|a, b| a.date.cmp(&b.date));
    assert_eq!(points[0].date, "2024-03-01");
    assert_eq!(points[2].date, "2024-03-03");
}

// ─── TopResourceEntry ─────────────────────────────────────────────────────────

#[test]
fn test_top_resource_entry_optional_pool() {
    let entry = TopResourceEntry {
        cloud_resource_id: "i-0abc123def456".into(),
        resource_name: Some("web-server-01".into()),
        resource_type: "instance".into(),
        total_cost: 789.0,
        pool_name: None,
    };
    assert!(entry.pool_name.is_none());
    assert_eq!(entry.resource_type, "instance");
    assert!(entry.total_cost > 0.0);
}

// ─── CreatePoolRequest ────────────────────────────────────────────────────────

#[test]
fn test_create_pool_request_with_budget() {
    let req = CreatePoolRequest {
        name: "Engineering".into(),
        description: Some("Engineering cloud spend".into()),
        parent_id: None,
        pool_type: "default".into(),
        owner_id: None,
        monthly_budget: Some(10_000.0),
    };
    assert_eq!(req.name, "Engineering");
    assert_eq!(req.monthly_budget, Some(10_000.0));
    assert!(req.parent_id.is_none());
}

#[test]
fn test_create_pool_request_without_budget() {
    let req = CreatePoolRequest {
        name: "Uncategorized".into(),
        description: None,
        parent_id: None,
        pool_type: "default".into(),
        owner_id: None,
        monthly_budget: None,
    };
    assert!(req.monthly_budget.is_none());
    assert!(req.description.is_none());
}

// ─── UpdatePoolRequest ────────────────────────────────────────────────────────

#[test]
fn test_update_pool_request_partial() {
    let req = UpdatePoolRequest {
        name: Some("Renamed Pool".into()),
        description: None,
        owner_id: None,
        monthly_budget: Some(25_000.0),
    };
    assert_eq!(req.name.as_deref(), Some("Renamed Pool"));
    assert!(req.description.is_none());
    assert_eq!(req.monthly_budget, Some(25_000.0));
}

// ─── PoolResponse From<Pool> conversion ──────────────────────────────────────

#[test]
fn test_pool_response_from_model() {
    let org_id = Uuid::new_v4();
    let pool_id = Uuid::new_v4();
    let model = cloudatlas_lib::modules::expense::models::Pool {
        id: pool_id,
        organization_id: org_id,
        parent_id: None,
        name: "Engineering".into(),
        description: Some("Engineering spend".into()),
        pool_type: "default".into(),
        owner_id: None,
        monthly_budget: Some(5000.0),
        created_at: Utc::now(),
        updated_at: Utc::now(),
    };

    let resp = PoolResponse::from(model);
    assert_eq!(resp.id, pool_id);
    assert_eq!(resp.organization_id, org_id);
    assert_eq!(resp.name, "Engineering");
    assert_eq!(resp.monthly_budget, Some(5000.0));
    assert!(resp.parent_id.is_none());
}

// ─── Pool budget assertions ───────────────────────────────────────────────────

#[test]
fn test_budget_percentage_calculation() {
    let budget = 10_000.0_f64;
    let spend = 7_500.0_f64;
    let pct = (spend / budget * 100.0).round();
    assert_eq!(pct, 75.0);
}

#[test]
fn test_budget_overspend_capped_at_100() {
    let budget = 1_000.0_f64;
    let spend = 1_500.0_f64;
    let pct = f64::min((spend / budget) * 100.0, 100.0);
    assert_eq!(pct, 100.0);
}
