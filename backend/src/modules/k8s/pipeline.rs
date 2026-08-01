//! K8s rightsizing pipeline: persists discovered cluster/workload data,
//! records usage samples and recomputes P95 recommendations + savings.
//!
//! Design: fetch happens in the kubernetes cloud adapter (`discover_nodes` /
//! `discover_workloads`); this module is pure persistence + math so it is
//! integration-testable with fixture structs (see spec 2026-08-17 §4.3).

use std::collections::HashMap;

use chrono::{Duration, Utc};
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::AppResult;
use crate::modules::cloud::adapters::{
    kubernetes::{K8sNodeInfo, K8sWorkload, KubernetesAdapter},
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

    let p95_cpu = if cs.len() < 5 { cs.last().copied().unwrap_or(0.0) } else { percentile(&cs, 0.95) };
    let p95_mem = if ms.len() < 5 { ms.last().copied().unwrap_or(0.0) } else { percentile(&ms, 0.95) };

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
    sqlx::query(
        "DELETE FROM k8s_usage_samples WHERE sample_time < NOW() - INTERVAL '60 days'",
    )
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

        let (p95_cpu, p95_mem, rec_cpu, rec_mem, monthly_cost, savings) =
            compute_recommendation(
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

    let cluster_name = config
        .get("cluster_name")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| k.server_host());

    sync_cluster(db, org_id, account_id, k, &cluster_name, config).await
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
    let cpu_rate = config.get("cpu_hourly_cost").and_then(Value::as_f64).unwrap_or(0.04);
    let mem_rate = config.get("memory_hourly_cost").and_then(Value::as_f64).unwrap_or(0.005);

    let nodes = k.discover_nodes().await?;
    let cluster_id =
        upsert_cluster(db, org_id, account_id, cluster_name, &nodes, cpu_rate, mem_rate).await?;

    let workloads = k.discover_workloads().await?;
    let workload_ids = upsert_workloads(db, org_id, cluster_id, &workloads).await?;
    let inserted = record_samples(db, org_id, cluster_id, &workloads, &workload_ids).await?;
    let updated =
        recompute_recommendations(db, cluster_id, &workloads, &workload_ids, cpu_rate, mem_rate, 14)
            .await?;

    // T15: mirror the cluster into CMDB CIs (failure must not break the
    // rightsizing pipeline — log and continue).
    let cis_created = match sync_k8s_cis(db, org_id, account_id, cluster_name, &nodes, &workloads).await {
        Ok(n) => n,
        Err(e) => {
            tracing::warn!(cluster = %cluster_name, error = %e, "K8s → CMDB CI sync failed");
            0
        }
    };

    tracing::info!(
        account_id = %account_id,
        cluster = %cluster_name,
        nodes = nodes.len(),
        workloads = workloads.len(),
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
const K8S_TYPE_CLUSTER: Uuid = uuid::uuid!("20000000-0000-0000-0000-000000000011");
const K8S_TYPE_NAMESPACE: Uuid = uuid::uuid!("20000000-0000-0000-0000-000000000012");
const K8S_TYPE_NODE: Uuid = uuid::uuid!("20000000-0000-0000-0000-000000000013");
const K8S_TYPE_WORKLOAD: Uuid = uuid::uuid!("20000000-0000-0000-0000-000000000014");
const K8S_TYPE_POD: Uuid = uuid::uuid!("20000000-0000-0000-0000-000000000015");

/// Upsert one CI row keyed by cloud_resource_id; returns (id, created).
/// Created rows get a discovery-source audit entry.
#[allow(clippy::too_many_arguments)]
async fn upsert_k8s_ci(
    db: &PgPool,
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
            meta = EXCLUDED.meta,
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
    .fetch_one(db)
    .await?;

    let id: Uuid = sqlx::Row::get(&row, "id");
    let created: bool = sqlx::Row::get(&row, "created");
    if created {
        let _ = sqlx::query(
            r#"INSERT INTO ci_audit_logs (id, ci_id, organization_id, operation, field_changes, source, created_at)
               VALUES ($1, $2, $3, 'create', $4, 'discovery', NOW())"#,
        )
        .bind(Uuid::new_v4())
        .bind(id)
        .bind(org_id)
        .bind(serde_json::json!({ "via": "k8s_pipeline", "resource": cloud_resource_id }))
        .execute(db)
        .await;
    }
    Ok((id, created))
}

/// Link two CIs through a builtin object association (idempotent).
async fn link_k8s_cis(
    db: &PgPool,
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
    .fetch_optional(db)
    .await?;

    let Some(obj_assoc) = obj_assoc else { return Ok(()) };
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
    .execute(db)
    .await?;
    Ok(())
}

const KIND_CONTAINS: Uuid = uuid::uuid!("30000000-0000-0000-0000-000000000005");
const KIND_RUN_ON: Uuid = uuid::uuid!("30000000-0000-0000-0000-000000000002");

/// Mirror one cluster sync into CMDB CIs: cluster → namespaces → nodes →
/// workloads → pods with `contains`/`run_on` associations (T15).
pub async fn sync_k8s_cis(
    db: &PgPool,
    org_id: Uuid,
    account_id: Uuid,
    cluster_name: &str,
    nodes: &[K8sNodeInfo],
    workloads: &[K8sWorkload],
) -> AppResult<usize> {
    let real_nodes = real_capacity_nodes(nodes);
    let mut created = 0usize;

    // Cluster CI.
    let (cluster_ci, c) = upsert_k8s_ci(
        db,
        org_id,
        account_id,
        K8S_TYPE_CLUSTER,
        &format!("k8s/cluster/{cluster_name}"),
        cluster_name,
        nodes.iter().find_map(|n| n.region.clone()).as_deref(),
        serde_json::json!({
            "region": nodes.iter().find_map(|n| n.region.clone()),
            "provider": real_nodes.iter().map(|n| n.provider.as_str()).find(|p| *p != "on-prem").unwrap_or("on-prem"),
            "node_count": real_nodes.len(),
            "total_vcpu": real_nodes.iter().map(|n| n.cpu_cores).sum::<f64>(),
            "total_memory_gb": real_nodes.iter().map(|n| n.memory_gb).sum::<f64>(),
        }),
    )
    .await?;
    created += c as usize;

    // Node CIs (linked run-inverse: node belongs to cluster via contains from
    // cluster is not typed — use run_on is pod→node; nodes attach via contains
    // cluster→node? No builtin assoc for that; keep nodes standalone CIs).
    let mut node_ci_ids: std::collections::HashMap<String, Uuid> = std::collections::HashMap::new();
    for n in nodes {
        let (node_ci, c) = upsert_k8s_ci(
            db,
            org_id,
            account_id,
            K8S_TYPE_NODE,
            &format!("k8s/node/{cluster_name}/{}", n.name),
            &n.name,
            n.region.as_deref(),
            serde_json::json!({
                "cpu_cores": n.cpu_cores,
                "memory_gb": n.memory_gb,
                "region": n.region,
                "provider": n.provider,
            }),
        )
        .await?;
        created += c as usize;
        node_ci_ids.insert(n.name.clone(), node_ci);
    }

    // Namespaces (derived from workload namespaces).
    let mut ns_cis: std::collections::HashMap<String, Uuid> = std::collections::HashMap::new();
    let mut namespaces: Vec<&str> = workloads.iter().map(|w| w.namespace.as_str()).collect();
    namespaces.sort_unstable();
    namespaces.dedup();
    for ns in namespaces {
        let (ns_ci, c) = upsert_k8s_ci(
            db,
            org_id,
            account_id,
            K8S_TYPE_NAMESPACE,
            &format!("k8s/ns/{cluster_name}/{ns}"),
            ns,
            None,
            serde_json::json!({ "cluster_name": cluster_name }),
        )
        .await?;
        created += c as usize;
        ns_cis.insert(ns.to_string(), ns_ci);
        // cluster contains namespace
        link_k8s_cis(db, org_id, cluster_ci, ns_ci, K8S_TYPE_CLUSTER, K8S_TYPE_NAMESPACE, KIND_CONTAINS).await?;
    }

    // Workloads (+ pods).
    for wl in workloads {
        let (wl_ci, c) = upsert_k8s_ci(
            db,
            org_id,
            account_id,
            K8S_TYPE_WORKLOAD,
            &format!("k8s/wl/{cluster_name}/{}/{}/{}", wl.namespace, wl.name, wl.kind),
            &wl.name,
            None,
            serde_json::json!({
                "workload_type": wl.kind,
                "namespace": wl.namespace,
                "replicas": wl.pod_names.len(),
                "cpu_request_m": wl.cpu_request_m,
                "mem_request_mi": wl.mem_request_mi,
                "cpu_limit_m": wl.cpu_limit_m,
                "mem_limit_mi": wl.mem_limit_mi,
            }),
        )
        .await?;
        created += c as usize;

        if let Some(ns_ci) = ns_cis.get(&wl.namespace) {
            link_k8s_cis(db, org_id, *ns_ci, wl_ci, K8S_TYPE_NAMESPACE, K8S_TYPE_WORKLOAD, KIND_CONTAINS).await?;
        }

        for pod in &wl.pod_names {
            let (pod_ci, c) = upsert_k8s_ci(
                db,
                org_id,
                account_id,
                K8S_TYPE_POD,
                &format!("k8s/pod/{cluster_name}/{}/{pod}", wl.namespace),
                pod,
                None,
                serde_json::json!({
                    "namespace": wl.namespace,
                    "workload_name": wl.name,
                }),
            )
            .await?;
            created += c as usize;
            link_k8s_cis(db, org_id, wl_ci, pod_ci, K8S_TYPE_WORKLOAD, K8S_TYPE_POD, KIND_CONTAINS).await?;
            // pod run_on node: k8s pod names embed the node name in some
            // providers; without scheduling data we skip the link unless the
            // pod name resolves to a known node prefix.
            if let Some(node_ci) = node_ci_ids
                .keys()
                .find(|n| pod.starts_with(n.split('.').next().unwrap_or(n)))
                .and_then(|n| node_ci_ids.get(n))
            {
                link_k8s_cis(db, org_id, pod_ci, *node_ci, K8S_TYPE_POD, K8S_TYPE_NODE, KIND_RUN_ON).await?;
            }
        }
    }

    Ok(created)
}
