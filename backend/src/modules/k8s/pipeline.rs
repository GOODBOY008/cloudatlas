//! K8s rightsizing pipeline: persists discovered cluster/workload data,
//! records usage samples and recomputes P95 recommendations + savings.
//!
//! Design: fetch happens in the kubernetes cloud adapter (`discover_nodes` /
//! `discover_workloads`); this module is pure persistence + math so it is
//! integration-testable with fixture structs (see spec 2026-08-17 §4.3).

use std::collections::HashMap;

use chrono::{Duration, Utc};
use serde_json::Value;
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

use crate::error::AppResult;
use crate::modules::cloud::adapters::{
    kubernetes::{K8sNodeInfo, K8sWorkload, K8sWorkloadInventory, KubernetesAdapter},
    AnyAdapter,
};

/// Nearest-rank percentile over a sorted slice (0.0..=1.0).
fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

/// Compute (p95_cpu_m, p95_mem_mi, rec_cpu_m, rec_mem_mi, monthly_cost, savings).
/// <5 samples -> latest sample instead of percentile. rec floors: 10 mCPU / 16 MiB.
pub fn compute_recommendation(
    cpu_request_m: i64,
    mem_request_mi: i64,
    cpu_samples: &[f64],
    mem_samples: &[f64],
    cpu_rate: f64,
    mem_rate: f64,
) -> (f64, f64, i64, i64, f64, f64) {
    let mut cs = cpu_samples.to_vec();
    cs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mut ms = mem_samples.to_vec();
    ms.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    let p95_cpu = if cs.len() < 5 {
        cs.last().copied().unwrap_or(0.0)
    } else {
        percentile(&cs, 0.95)
    };
    let p95_mem = if ms.len() < 5 {
        ms.last().copied().unwrap_or(0.0)
    } else {
        percentile(&ms, 0.95)
    };

    let rec_cpu = (p95_cpu.ceil().max(10.0)) as i64;
    let rec_mem = (p95_mem.ceil().max(16.0)) as i64;

    let monthly_cost = (cpu_request_m as f64 / 1000.0 * cpu_rate
        + mem_request_mi as f64 / 1024.0 * mem_rate)
        * 730.0;
    let savings = ((cpu_request_m as f64 - rec_cpu as f64).max(0.0) / 1000.0 * cpu_rate
        + (mem_request_mi as f64 - rec_mem as f64).max(0.0) / 1024.0 * mem_rate)
        * 730.0;

    (p95_cpu, p95_mem, rec_cpu, rec_mem, monthly_cost, savings)
}

/// Nodes that count toward cluster capacity — excludes serverless
/// `virtual-kubelet` nodes whose pooled (near-infinite) capacity would overflow
/// the NUMERIC(10,2) capacity columns and misrepresent real cluster resources.
fn real_capacity_nodes(nodes: &[K8sNodeInfo]) -> Vec<&K8sNodeInfo> {
    nodes
        .iter()
        .filter(|n| !n.name.contains("virtual-kubelet"))
        .collect()
}

/// Upsert the cluster row; returns its id.
pub async fn upsert_cluster(
    db: &PgPool,
    org_id: Uuid,
    account_id: Uuid,
    name: &str,
    nodes: &[K8sNodeInfo],
    cpu_rate: f64,
    mem_rate: f64,
) -> AppResult<Uuid> {
    let real_nodes = real_capacity_nodes(nodes);
    let node_count = real_nodes.len() as i32;
    let total_vcpu: f64 = real_nodes.iter().map(|n| n.cpu_cores).sum();
    let total_memory_gb: f64 = real_nodes.iter().map(|n| n.memory_gb).sum();
    let region = real_nodes.iter().find_map(|n| n.region.clone());
    let provider = real_nodes
        .iter()
        .map(|n| n.provider.as_str())
        .find(|p| *p != "on-prem")
        .unwrap_or("on-prem");
    let monthly_cost = real_nodes
        .iter()
        .map(|n| (n.cpu_cores * cpu_rate + n.memory_gb * mem_rate) * 730.0)
        .sum::<f64>();

    let meta = serde_json::json!({
        "nodes": nodes.iter().map(|n| serde_json::json!({
            "name": n.name, "cpu_cores": n.cpu_cores, "memory_gb": n.memory_gb,
            "region": n.region, "provider": n.provider,
        })).collect::<Vec<_>>()
    });

    let row = sqlx::query_as::<_, (Uuid,)>(
        r#"
        INSERT INTO k8s_clusters
            (organization_id, cloud_account_id, name, region, provider,
             node_count, total_vcpu, total_memory_gb, monthly_cost, meta, last_synced_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
        ON CONFLICT (organization_id, name) DO UPDATE SET
            cloud_account_id = EXCLUDED.cloud_account_id,
            region = COALESCE(EXCLUDED.region, k8s_clusters.region),
            provider = EXCLUDED.provider,
            node_count = EXCLUDED.node_count,
            total_vcpu = EXCLUDED.total_vcpu,
            total_memory_gb = EXCLUDED.total_memory_gb,
            monthly_cost = EXCLUDED.monthly_cost,
            meta = EXCLUDED.meta,
            last_synced_at = NOW(),
            updated_at = NOW()
        RETURNING id
        "#,
    )
    .bind(org_id)
    .bind(account_id)
    .bind(name)
    .bind(region)
    .bind(provider)
    .bind(node_count)
    .bind(total_vcpu)
    .bind(total_memory_gb)
    .bind(monthly_cost)
    .bind(meta)
    .fetch_one(db)
    .await?;

    Ok(row.0)
}

/// Upsert workload rows; returns workload ids keyed by (namespace, name).
pub async fn upsert_workloads(
    db: &PgPool,
    org_id: Uuid,
    cluster_id: Uuid,
    workloads: &[K8sWorkload],
) -> AppResult<HashMap<(String, String), Uuid>> {
    let mut ids = HashMap::new();
    for wl in workloads {
        let row = sqlx::query_as::<_, (Uuid,)>(
            r#"
            INSERT INTO k8s_workload_metrics
                (organization_id, cluster_id, namespace, workload_name, workload_type,
                 container_name, cpu_request_m, mem_request_mi, cpu_limit_m, mem_limit_mi)
            VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9)
            ON CONFLICT (organization_id, cluster_id, namespace, workload_name, COALESCE(container_name, ''))
            DO UPDATE SET
                workload_type = EXCLUDED.workload_type,
                cpu_request_m = EXCLUDED.cpu_request_m,
                mem_request_mi = EXCLUDED.mem_request_mi,
                cpu_limit_m = EXCLUDED.cpu_limit_m,
                mem_limit_mi = EXCLUDED.mem_limit_mi,
                updated_at = NOW()
            RETURNING id
            "#,
        )
        .bind(org_id)
        .bind(cluster_id)
        .bind(&wl.namespace)
        .bind(&wl.name)
        .bind(&wl.kind)
        .bind(wl.cpu_request_m)
        .bind(wl.mem_request_mi)
        .bind(wl.cpu_limit_m)
        .bind(wl.mem_limit_mi)
        .fetch_one(db)
        .await?;
        ids.insert((wl.namespace.clone(), wl.name.clone()), row.0);
    }
    Ok(ids)
}

/// Record one usage sample per workload with current usage; prune old samples.
pub async fn record_samples(
    db: &PgPool,
    org_id: Uuid,
    cluster_id: Uuid,
    workloads: &[K8sWorkload],
    workload_ids: &HashMap<(String, String), Uuid>,
) -> AppResult<u32> {
    let mut inserted = 0u32;
    for wl in workloads {
        let Some((cpu, mem)) = wl.usage else { continue };
        if !workload_ids.contains_key(&(wl.namespace.clone(), wl.name.clone())) {
            continue;
        }
        sqlx::query(
            r#"
            INSERT INTO k8s_usage_samples
                (organization_id, cluster_id, namespace, workload_name, workload_type,
                 cpu_usage_m, mem_usage_mi, sample_time)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
            "#,
        )
        .bind(org_id)
        .bind(cluster_id)
        .bind(&wl.namespace)
        .bind(&wl.name)
        .bind(&wl.kind)
        .bind(cpu)
        .bind(mem)
        .execute(db)
        .await?;
        inserted += 1;
    }

    // Prune samples older than 60 days.
    sqlx::query("DELETE FROM k8s_usage_samples WHERE sample_time < NOW() - INTERVAL '60 days'")
        .execute(db)
        .await?;

    Ok(inserted)
}

/// Recompute P95 / recommendations / savings for every workload from the
/// samples of the last `observation_days` (cluster_id is globally unique).
pub async fn recompute_recommendations(
    db: &PgPool,
    cluster_id: Uuid,
    workloads: &[K8sWorkload],
    workload_ids: &HashMap<(String, String), Uuid>,
    cpu_rate: f64,
    mem_rate: f64,
    observation_days: i64,
) -> AppResult<u32> {
    let mut updated = 0u32;
    let cutoff = Utc::now() - Duration::days(observation_days);
    for wl in workloads {
        let Some(&wl_id) = workload_ids.get(&(wl.namespace.clone(), wl.name.clone())) else {
            continue;
        };
        let samples = sqlx::query_as::<_, (f64, f64)>(
            r#"
            SELECT cpu_usage_m::float8, mem_usage_mi::float8 FROM k8s_usage_samples
            WHERE cluster_id = $1 AND namespace = $2 AND workload_name = $3
              AND sample_time >= $4
            ORDER BY sample_time
            "#,
        )
        .bind(cluster_id)
        .bind(&wl.namespace)
        .bind(&wl.name)
        .bind(cutoff)
        .fetch_all(db)
        .await?;

        if samples.is_empty() {
            continue; // no usage data (metrics-server absent or no pods)
        }
        let cpu_samples: Vec<f64> = samples.iter().map(|(c, _)| *c).collect();
        let mem_samples: Vec<f64> = samples.iter().map(|(_, m)| *m).collect();

        let (p95_cpu, p95_mem, rec_cpu, rec_mem, monthly_cost, savings) = compute_recommendation(
            wl.cpu_request_m,
            wl.mem_request_mi,
            &cpu_samples,
            &mem_samples,
            cpu_rate,
            mem_rate,
        );

        sqlx::query(
            r#"
            UPDATE k8s_workload_metrics
            SET cpu_p95_m = $2, mem_p95_mi = $3, cpu_rec_m = $4, mem_rec_mi = $5,
                monthly_cost = $6, potential_savings = $7,
                observation_days = $8, evaluated_at = NOW()
            WHERE id = $1
            "#,
        )
        .bind(wl_id)
        .bind(p95_cpu)
        .bind(p95_mem)
        .bind(rec_cpu)
        .bind(rec_mem)
        .bind(monthly_cost)
        .bind(savings)
        .bind(observation_days)
        .execute(db)
        .await?;
        updated += 1;
    }
    Ok(updated)
}

/// Full sync for a kubernetes account: cluster -> workloads -> samples -> recompute.
pub async fn sync_account(
    db: &PgPool,
    org_id: Uuid,
    account_id: Uuid,
    adapter: &AnyAdapter,
    config: &Value,
) -> AppResult<()> {
    let AnyAdapter::Kubernetes(k) = adapter else {
        return Ok(());
    };

    let cluster_name = configured_cluster_name(k, config);
    sync_cluster(db, org_id, account_id, k, &cluster_name, config).await
}

pub(crate) fn configured_cluster_name(adapter: &KubernetesAdapter, config: &Value) -> String {
    config
        .get("cluster_name")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| adapter.server_host())
}

/// Sync one k8s cluster's nodes + workloads into the rightsizing tables.
///
/// Shared by direct `kubernetes` accounts and by per-ACK-cluster discovery,
/// which builds a [`KubernetesAdapter`] from each cluster's kubeconfig.
pub async fn sync_cluster(
    db: &PgPool,
    org_id: Uuid,
    account_id: Uuid,
    k: &KubernetesAdapter,
    cluster_name: &str,
    config: &Value,
) -> AppResult<()> {
    let cpu_rate = config
        .get("cpu_hourly_cost")
        .and_then(Value::as_f64)
        .unwrap_or(0.04);
    let mem_rate = config
        .get("memory_hourly_cost")
        .and_then(Value::as_f64)
        .unwrap_or(0.005);

    let nodes = k.discover_nodes().await?;
    let inventory = k.discover_workloads().await?;
    let workloads = &inventory.workloads;
    let cluster_id = upsert_cluster(
        db,
        org_id,
        account_id,
        cluster_name,
        &nodes,
        cpu_rate,
        mem_rate,
    )
    .await?;

    let workload_ids = upsert_workloads(db, org_id, cluster_id, workloads).await?;
    let inserted = record_samples(db, org_id, cluster_id, workloads, &workload_ids).await?;
    let updated = recompute_recommendations(
        db,
        cluster_id,
        workloads,
        &workload_ids,
        cpu_rate,
        mem_rate,
        14,
    )
    .await?;

    let cis_created =
        sync_k8s_cis(db, org_id, account_id, cluster_name, &nodes, &inventory).await?;

    tracing::info!(
        account_id = %account_id,
        cluster = %cluster_name,
        nodes = nodes.len(),
        workloads = workloads.len(),
        pods = inventory.pods.len(),
        samples = inserted,
        recomputed = updated,
        cis_created = cis_created,
        "Kubernetes pipeline sync complete"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentile_nearest_rank() {
        assert_eq!(percentile(&[1.0, 2.0, 3.0, 4.0], 0.95), 4.0);
        assert_eq!(percentile(&[1.0, 2.0, 3.0], 0.5), 2.0);
        assert_eq!(percentile(&[], 0.95), 0.0);
    }

    #[test]
    fn compute_recommendation_p95_and_floors() {
        let samples = vec![100.0, 200.0, 300.0, 400.0, 500.0, 600.0];
        let (p95_cpu, _p95_mem, rec_cpu, rec_mem, cost, savings) =
            compute_recommendation(1000, 1024, &samples, &samples, 0.04, 0.005);
        assert_eq!(p95_cpu, 600.0);
        assert_eq!(rec_cpu, 600);
        assert_eq!(rec_mem, 600);
        // cost = (1.0 * 0.04 + 1.0 * 0.005) * 730
        assert!((cost - 32.85).abs() < 1e-9);
        // savings = ((1.0 - 0.6) * 0.04 + (1.0 - 0.586) * 0.005) * 730
        assert!(savings > 10.0 && savings < 15.0, "got {savings}");
    }

    #[test]
    fn compute_recommendation_few_samples_uses_latest() {
        let samples = vec![10.0, 700.0];
        let (p95_cpu, _, rec_cpu, _, _, _) =
            compute_recommendation(1000, 1024, &samples, &samples, 0.04, 0.005);
        assert_eq!(p95_cpu, 700.0);
        assert_eq!(rec_cpu, 700);
    }

    #[test]
    fn compute_recommendation_zero_usage_keeps_floors() {
        let (_, _, rec_cpu, rec_mem, _, savings) =
            compute_recommendation(500, 512, &[0.0], &[0.0], 0.04, 0.005);
        assert_eq!(rec_cpu, 10);
        assert_eq!(rec_mem, 16);
        assert!(savings > 0.0); // request 500m/512Mi vs rec 10m/16Mi
    }

    #[test]
    fn real_capacity_nodes_excludes_virtual_kubelet() {
        fn node(name: &str, cpu: f64, mem: f64) -> K8sNodeInfo {
            K8sNodeInfo {
                name: name.into(),
                cpu_cores: cpu,
                memory_gb: mem,
                region: None,
                provider: "on-prem".into(),
            }
        }
        let nodes = vec![
            node("node-worker-1", 16.0, 125.0),
            node("virtual-kubelet-cn-hongkong-b", 0.0, 65536000.0),
            node("virtual-kubelet-cn-hongkong-c", 0.0, 65536000.0),
        ];
        let real = real_capacity_nodes(&nodes);
        assert_eq!(real.len(), 1);
        assert_eq!(real[0].name, "node-worker-1");
        let total_mem: f64 = real.iter().map(|n| n.memory_gb).sum();
        assert!(total_mem < 10.0 * 1e8, "must stay under NUMERIC(10,2) cap");
    }
}
// ─── K8s → CMDB CI sync (gap closure T15) ────────────────────────────────────

/// Builtin k8s CI type ids (migration 035).
pub(crate) const K8S_TYPE_CLUSTER: Uuid = uuid::uuid!("20000000-0000-0000-0000-000000000011");
const K8S_TYPE_NAMESPACE: Uuid = uuid::uuid!("20000000-0000-0000-0000-000000000012");
const K8S_TYPE_NODE: Uuid = uuid::uuid!("20000000-0000-0000-0000-000000000013");
const K8S_TYPE_WORKLOAD: Uuid = uuid::uuid!("20000000-0000-0000-0000-000000000014");
pub(crate) const K8S_TYPE_POD: Uuid = uuid::uuid!("20000000-0000-0000-0000-000000000015");

pub(crate) fn cluster_ci_resource_id(cluster: &str) -> String {
    format!("k8s/cluster/{cluster}")
}

pub(crate) fn pod_ci_resource_id(cluster: &str, namespace: &str, pod: &str) -> String {
    format!("k8s/pod/{cluster}/{namespace}/{pod}")
}

pub(crate) async fn audit_ci_creation(
    connection: &mut PgConnection,
    org_id: Uuid,
    ci_id: Uuid,
    resource_id: &str,
    via: &str,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO ci_audit_logs (ci_id, organization_id, operation, field_changes, source)
         VALUES ($1, $2, 'create', $3, 'discovery')",
    )
    .bind(ci_id)
    .bind(org_id)
    .bind(serde_json::json!({ "via": via, "resource": resource_id }))
    .execute(connection)
    .await?;
    Ok(())
}

/// Upsert one CI row keyed by cloud_resource_id; returns (id, created).
/// Created rows get a discovery-source audit entry.
#[allow(clippy::too_many_arguments)]
async fn upsert_k8s_ci(
    connection: &mut PgConnection,
    org_id: Uuid,
    account_id: Uuid,
    ci_type_id: Uuid,
    cloud_resource_id: &str,
    name: &str,
    region: Option<&str>,
    meta: Value,
) -> AppResult<(Uuid, bool)> {
    let row = sqlx::query(
        r#"
        INSERT INTO cis
            (organization_id, ci_type_id, cloud_account_id, cloud_resource_id,
             cloud_region, name, meta, tags, lifecycle_state, discovered_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, 'active', NOW())
        ON CONFLICT (organization_id, cloud_account_id, cloud_resource_id) DO UPDATE SET
            name = EXCLUDED.name,
            cloud_region = COALESCE(EXCLUDED.cloud_region, cis.cloud_region),
            meta = cis.meta || EXCLUDED.meta,
            discovered_at = NOW(),
            updated_at = NOW()
        RETURNING id, (xmax = 0) AS created
        "#,
    )
    .bind(org_id)
    .bind(ci_type_id)
    .bind(account_id)
    .bind(cloud_resource_id)
    .bind(region)
    .bind(name)
    .bind(&meta)
    .fetch_one(&mut *connection)
    .await?;

    let id: Uuid = sqlx::Row::get(&row, "id");
    let created: bool = sqlx::Row::get(&row, "created");
    if created {
        audit_ci_creation(connection, org_id, id, cloud_resource_id, "k8s_pipeline").await?;
    }
    Ok((id, created))
}

/// Link two CIs through a builtin object association (idempotent).
async fn link_k8s_cis(
    connection: &mut PgConnection,
    org_id: Uuid,
    src: Uuid,
    dst: Uuid,
    src_type: Uuid,
    dst_type: Uuid,
    kind_id: Uuid,
) -> AppResult<()> {
    let obj_assoc: Option<Uuid> = sqlx::query_scalar(
        r#"SELECT id FROM ci_object_associations
           WHERE organization_id IS NULL AND src_ci_type_id = $1
             AND association_kind_id = $2 AND dst_ci_type_id = $3"#,
    )
    .bind(src_type)
    .bind(kind_id)
    .bind(dst_type)
    .fetch_optional(&mut *connection)
    .await?;

    let Some(obj_assoc) = obj_assoc else {
        return Ok(());
    };
    sqlx::query(
        r#"INSERT INTO ci_instance_associations
           (id, organization_id, src_ci_id, object_association_id, dst_ci_id, meta, source)
           VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, 'discovery')
           ON CONFLICT (src_ci_id, object_association_id, dst_ci_id) DO NOTHING"#,
    )
    .bind(Uuid::new_v4())
    .bind(org_id)
    .bind(src)
    .bind(obj_assoc)
    .bind(dst)
    .execute(connection)
    .await?;
    Ok(())
}

const KIND_CONTAINS: Uuid = uuid::uuid!("30000000-0000-0000-0000-000000000005");
const KIND_RUN_ON: Uuid = uuid::uuid!("30000000-0000-0000-0000-000000000002");

/// Mirror a cluster's inventory and discovered relationships together.
async fn sync_k8s_cis(
    db: &PgPool,
    org_id: Uuid,
    account_id: Uuid,
    cluster_name: &str,
    nodes: &[K8sNodeInfo],
    inventory: &K8sWorkloadInventory,
) -> AppResult<usize> {
    let real_nodes = real_capacity_nodes(nodes);
    let mut transaction = db.begin().await?;
    let mut created = 0;
    let cluster_resource = cluster_ci_resource_id(cluster_name);

    let (cluster_ci, is_new) = upsert_k8s_ci(
        &mut transaction, org_id, account_id, K8S_TYPE_CLUSTER, &cluster_resource, cluster_name,
        nodes.iter().find_map(|n| n.region.as_deref()),
        serde_json::json!({
            "region": nodes.iter().find_map(|n| n.region.as_deref()),
            "provider": real_nodes.iter().map(|n| n.provider.as_str()).find(|p| *p != "on-prem").unwrap_or("on-prem"),
            "node_count": real_nodes.len(),
            "total_vcpu": real_nodes.iter().map(|n| n.cpu_cores).sum::<f64>(),
            "total_memory_gb": real_nodes.iter().map(|n| n.memory_gb).sum::<f64>(),
        }),
    )
    .await?;
    created += usize::from(is_new);

    let mut node_cis = HashMap::new();
    for node in nodes {
        let (node_ci, is_new) = upsert_k8s_ci(
            &mut transaction,
            org_id,
            account_id,
            K8S_TYPE_NODE,
            &format!("k8s/node/{cluster_name}/{}", node.name),
            &node.name,
            node.region.as_deref(),
            serde_json::json!({
                "cpu_cores": node.cpu_cores,
                "memory_gb": node.memory_gb,
                "region": node.region,
                "provider": node.provider,
            }),
        )
        .await?;
        created += usize::from(is_new);
        node_cis.insert(node.name.as_str(), node_ci);
    }

    let mut namespaces: Vec<&str> = inventory
        .namespaces
        .iter()
        .map(String::as_str)
        .chain(inventory.workloads.iter().map(|w| w.namespace.as_str()))
        .chain(inventory.pods.iter().map(|p| p.namespace.as_str()))
        .collect();
    namespaces.sort_unstable();
    namespaces.dedup();
    let mut namespace_cis = HashMap::new();
    for namespace in namespaces {
        let (namespace_ci, is_new) = upsert_k8s_ci(
            &mut transaction,
            org_id,
            account_id,
            K8S_TYPE_NAMESPACE,
            &format!("k8s/ns/{cluster_name}/{namespace}"),
            namespace,
            None,
            serde_json::json!({ "cluster_name": cluster_name }),
        )
        .await?;
        created += usize::from(is_new);
        namespace_cis.insert(namespace, namespace_ci);
        link_k8s_cis(
            &mut transaction,
            org_id,
            cluster_ci,
            namespace_ci,
            K8S_TYPE_CLUSTER,
            K8S_TYPE_NAMESPACE,
            KIND_CONTAINS,
        )
        .await?;
    }

    let mut workload_cis = HashMap::new();
    for workload in &inventory.workloads {
        let (workload_ci, is_new) = upsert_k8s_ci(
            &mut transaction,
            org_id,
            account_id,
            K8S_TYPE_WORKLOAD,
            &format!(
                "k8s/wl/{cluster_name}/{}/{}/{}",
                workload.namespace, workload.name, workload.kind
            ),
            &workload.name,
            None,
            serde_json::json!({
                "workload_type": workload.kind,
                "namespace": workload.namespace,
                "replicas": workload.pod_names.len(),
                "cpu_request_m": workload.cpu_request_m,
                "mem_request_mi": workload.mem_request_mi,
                "cpu_limit_m": workload.cpu_limit_m,
                "mem_limit_mi": workload.mem_limit_mi,
            }),
        )
        .await?;
        created += usize::from(is_new);
        workload_cis.insert(
            (
                workload.namespace.as_str(),
                workload.kind.as_str(),
                workload.name.as_str(),
            ),
            workload_ci,
        );
        link_k8s_cis(
            &mut transaction,
            org_id,
            namespace_cis[workload.namespace.as_str()],
            workload_ci,
            K8S_TYPE_NAMESPACE,
            K8S_TYPE_WORKLOAD,
            KIND_CONTAINS,
        )
        .await?;
    }

    for pod in &inventory.pods {
        let workload_ci = pod
            .workload
            .as_ref()
            .and_then(|(kind, name)| {
                workload_cis.get(&(pod.namespace.as_str(), kind.as_str(), name.as_str()))
            })
            .copied();
        let node_ci = pod
            .node_name
            .as_deref()
            .and_then(|name| node_cis.get(name))
            .copied();
        let (pod_ci, is_new) = upsert_k8s_ci(
            &mut transaction,
            org_id,
            account_id,
            K8S_TYPE_POD,
            &pod_ci_resource_id(cluster_name, &pod.namespace, &pod.name),
            &pod.name,
            None,
            serde_json::json!({
                "namespace": pod.namespace,
                "workload_name": pod.workload.as_ref().map(|(_, name)| name),
                "node": pod.node_name,
            }),
        )
        .await?;
        created += usize::from(is_new);

        // A replacement Pod with the same name can have a different owner or node.
        sqlx::query(
            r#"DELETE FROM ci_instance_associations a
               USING ci_object_associations o
               WHERE a.organization_id = $1 AND a.source = 'discovery'
                 AND a.object_association_id = o.id AND o.organization_id IS NULL
                 AND ((a.dst_ci_id = $2 AND o.src_ci_type_id = $3 AND o.association_kind_id = $4
                       AND a.src_ci_id IS DISTINCT FROM $5)
                   OR (a.src_ci_id = $2 AND o.dst_ci_type_id = $6 AND o.association_kind_id = $7
                       AND a.dst_ci_id IS DISTINCT FROM $8))"#,
        )
        .bind(org_id)
        .bind(pod_ci)
        .bind(K8S_TYPE_WORKLOAD)
        .bind(KIND_CONTAINS)
        .bind(workload_ci)
        .bind(K8S_TYPE_NODE)
        .bind(KIND_RUN_ON)
        .bind(node_ci)
        .execute(&mut *transaction)
        .await?;

        if let Some(workload_ci) = workload_ci {
            link_k8s_cis(
                &mut transaction,
                org_id,
                workload_ci,
                pod_ci,
                K8S_TYPE_WORKLOAD,
                K8S_TYPE_POD,
                KIND_CONTAINS,
            )
            .await?;
        }
        if let Some(node_ci) = node_ci {
            link_k8s_cis(
                &mut transaction,
                org_id,
                pod_ci,
                node_ci,
                K8S_TYPE_POD,
                K8S_TYPE_NODE,
                KIND_RUN_ON,
            )
            .await?;
        }
    }

    // Retain prior CIs for history while dropping discovery links to objects absent in this snapshot.
    let prefixes: Vec<String> = ["node", "ns", "wl", "pod"]
        .iter()
        .map(|group| format!("k8s/{group}/{cluster_name}/"))
        .collect();
    sqlx::query(
        r#"WITH cluster_cis AS (
               SELECT c.id, c.discovered_at
               FROM cis c WHERE c.organization_id = $1 AND c.cloud_account_id = $2
                 AND (c.cloud_resource_id = $3 OR EXISTS (
                   SELECT 1 FROM unnest($4::text[]) AS prefix WHERE starts_with(c.cloud_resource_id, prefix)
                 ))
           )
           DELETE FROM ci_instance_associations a
           USING cluster_cis src, cluster_cis dst, ci_object_associations o
           WHERE a.organization_id = $1 AND a.source = 'discovery'
             AND a.src_ci_id = src.id AND a.dst_ci_id = dst.id
             AND a.object_association_id = o.id AND o.organization_id IS NULL
             AND o.association_kind_id IN ($5, $6)
             AND (src.discovered_at < NOW() OR dst.discovered_at < NOW())"#,
    )
    .bind(org_id)
    .bind(account_id)
    .bind(&cluster_resource)
    .bind(&prefixes)
    .bind(KIND_CONTAINS)
    .bind(KIND_RUN_ON)
    .execute(&mut *transaction)
    .await?;

    transaction.commit().await?;
    Ok(created)
}
