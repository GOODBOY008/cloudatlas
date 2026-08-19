//! Kubernetes adapter — discovers cluster workloads via the kube-apiserver
//! REST API (token + server URL). Compatible with any cluster exposing a
//! bearer-token service account, or a kubeconfig (client-certificate auth);
//! the rightsizing analysis lives in `modules/k8s`.
//!
//! Credentials: `{"server": "https://...", "token": "..."}`; optional config
//! `{"namespace": "..."}` to scope discovery.
//!
//! Alibaba ACK clusters are reached the same way: `parse_kubeconfig` turns a
//! fetched kubeconfig into a [`Kubeconfig`], then [`KubernetesAdapter::from_kubeconfig`]
//! builds a client with the cluster CA + client certificate (or bearer token).

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde_json::{json, Value};
use yaml_rust2::{Yaml, YamlLoader};

use super::{CloudAdapter, DiscoveredResource};
use crate::error::{AppError, AppResult};

/// Parsed kubeconfig — enough to reach a cluster's apiserver.
///
/// Only the fields CloudAtlas needs to connect are extracted: the api-server
/// URL, the cluster CA, and either a bearer token or a client certificate
/// pair. ACK kubeconfigs typically carry a single cluster + user, so the first
/// cluster and first user are used (resolve-to-current-context is overkill).
#[derive(Debug, Clone)]
pub struct Kubeconfig {
    pub server: String,
    /// Decoded `certificate-authority-data` PEM.
    pub ca_cert_pem: Option<String>,
    /// Decoded `client-certificate-data` PEM.
    pub client_cert_pem: Option<String>,
    /// Decoded `client-key-data` PEM.
    pub client_key_pem: Option<String>,
    /// `token` from the user section (temporary kubeconfigs).
    pub token: Option<String>,
}

/// Parse a kubeconfig YAML string into a [`Kubeconfig`].
///
/// Handles both the classic x509 client-certificate form and the temporary
/// bearer-token form that ACK's `DescribeClusterUserKubeconfig` returns.
pub fn parse_kubeconfig(yaml: &str) -> AppResult<Kubeconfig> {
    let docs = YamlLoader::load_from_str(yaml)
        .map_err(|e| AppError::Validation(format!("invalid kubeconfig: {e}")))?;
    let root = docs
        .first()
        .ok_or_else(|| AppError::Validation("kubeconfig is empty".into()))?;

    let clusters: &[Yaml] = root["clusters"]
        .as_vec()
        .map(|v| v.as_slice())
        .unwrap_or(&[]);
    let cluster = clusters
        .first()
        .and_then(|c| c["cluster"].as_hash().map(|_| &c["cluster"]))
        .unwrap_or(&Yaml::BadValue);

    let server = cluster["server"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::Validation("kubeconfig missing cluster.server".into()))?
        .to_string();

    let ca_cert_pem = decode_b64_data(cluster, "certificate-authority-data")?;

    // ACK kubeconfigs embed the CA inline; some clusters use `insecure-skip-tls-verify`.
    let users: &[Yaml] = root["users"].as_vec().map(|v| v.as_slice()).unwrap_or(&[]);
    let user = users
        .first()
        .and_then(|u| u["user"].as_hash().map(|_| &u["user"]))
        .unwrap_or(&Yaml::BadValue);

    let token = user["token"].as_str().map(str::to_string);
    let client_cert_pem = decode_b64_data(user, "client-certificate-data")?;
    let client_key_pem = decode_b64_data(user, "client-key-data")?;

    if token.is_none() && client_cert_pem.is_none() {
        return Err(AppError::Validation(
            "kubeconfig user has neither token nor client certificate".into(),
        ));
    }

    Ok(Kubeconfig {
        server,
        ca_cert_pem,
        client_cert_pem,
        client_key_pem,
        token,
    })
}

/// Decode a base64 `*-data` field from a kubeconfig node into a PEM string.
fn decode_b64_data(node: &Yaml, key: &str) -> AppResult<Option<String>> {
    let Some(raw) = node[key].as_str().filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let bytes = BASE64
        .decode(raw)
        .map_err(|e| AppError::Validation(format!("kubeconfig {key} is not valid base64: {e}")))?;
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

pub struct KubernetesAdapter {
    server: String,
    token: Option<String>,
    namespace: Option<String>,
    /// Prebuilt client so CA + client identity are applied once.
    http: reqwest::Client,
}

impl KubernetesAdapter {
    pub fn from_credentials(creds: &Value, config: &Value) -> AppResult<Self> {
        let server = creds["server"]
            .as_str()
            .filter(|s| s.starts_with("https://") || s.starts_with("http://"))
            .ok_or_else(|| {
                AppError::Validation("Kubernetes credentials missing valid 'server' URL".into())
            })?
            .to_string();
        let token = creds["token"]
            .as_str()
            .ok_or_else(|| AppError::Validation("Kubernetes credentials missing 'token'".into()))?
            .to_string();
        let namespace = config
            .get("namespace")
            .and_then(Value::as_str)
            .map(String::from);

        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .map_err(|e| AppError::Cloud(format!("Kubernetes client build failed: {e}")))?;

        Ok(Self {
            server: server.trim_end_matches('/').to_string(),
            token: Some(token),
            namespace,
            http,
        })
    }

    /// Build an adapter from a parsed kubeconfig (used for ACK clusters).
    /// Applies the cluster CA (if present) and the client certificate identity.
    pub fn from_kubeconfig(kc: &Kubeconfig, namespace: Option<String>) -> AppResult<Self> {
        let mut builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(20));

        if let Some(ca) = kc.ca_cert_pem.as_ref() {
            let cert = reqwest::tls::Certificate::from_pem(ca.as_bytes())
                .map_err(|e| AppError::Validation(format!("invalid kubeconfig CA cert: {e}")))?;
            builder = builder.add_root_certificate(cert);
        }
        if let (Some(cert), Some(key)) = (kc.client_cert_pem.as_ref(), kc.client_key_pem.as_ref()) {
            let pem = format!("{cert}\n{key}");
            let identity = reqwest::Identity::from_pem(pem.as_bytes()).map_err(|e| {
                AppError::Validation(format!("invalid kubeconfig client cert: {e}"))
            })?;
            builder = builder.identity(identity);
        }

        let http = builder
            .build()
            .map_err(|e| AppError::Cloud(format!("Kubernetes client build failed: {e}")))?;

        Ok(Self {
            server: kc.server.trim_end_matches('/').to_string(),
            token: kc.token.clone(),
            namespace,
            http,
        })
    }

    async fn get(&self, path: &str) -> AppResult<Value> {
        let mut req = self.http.get(format!("{}{}", self.server, path));
        if let Some(tok) = &self.token {
            req = req.bearer_auth(tok);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| AppError::Cloud(format!("Kubernetes API request failed: {e}")))?;

        let status = resp.status();
        let body: Value = resp
            .json()
            .await
            .map_err(|e| AppError::Cloud(format!("Kubernetes API parse failed: {e}")))?;

        if !status.is_success() {
            return Err(AppError::Cloud(format!(
                "Kubernetes API error (HTTP {status}): {}",
                body["message"].as_str().unwrap_or("unknown")
            )));
        }
        Ok(body)
    }
}

impl CloudAdapter for KubernetesAdapter {
    async fn test_connection(&self) -> AppResult<(bool, String, i32)> {
        match self.get("/version").await {
            Ok(body) => {
                let version = body["gitVersion"].as_str().unwrap_or("unknown");
                Ok((true, format!("Kubernetes {version} reachable"), 1))
            }
            Err(AppError::Cloud(msg)) => Ok((false, msg, 0)),
            Err(e) => Err(e),
        }
    }

    async fn discover_resources(
        &self,
        _region: Option<&str>,
    ) -> AppResult<Vec<DiscoveredResource>> {
        let ns = self
            .namespace
            .as_deref()
            .map(|n| format!("/namespaces/{n}"))
            .unwrap_or_default();
        let body = self.get(&format!("/api/v1{ns}/pods?limit=500")).await?;

        let mut resources = Vec::new();
        if let Some(items) = body["items"].as_array() {
            for pod in items {
                let name = pod["metadata"]["name"].as_str().unwrap_or("pod");
                let namespace = pod["metadata"]["namespace"].as_str().unwrap_or("default");
                let node = pod["spec"]["nodeName"].as_str().unwrap_or("");

                let mut container_meta = Vec::new();
                if let Some(containers) = pod["spec"]["containers"].as_array() {
                    for c in containers {
                        container_meta.push(json!({
                            "name": c["name"].as_str().unwrap_or(""),
                            "image": c["image"].as_str().unwrap_or(""),
                            "cpu_request": c["resources"]["requests"]["cpu"].as_str().unwrap_or(""),
                            "memory_request": c["resources"]["requests"]["memory"].as_str().unwrap_or(""),
                        }));
                    }
                }

                resources.push(DiscoveredResource {
                    cloud_resource_id: pod["metadata"]["uid"].as_str().unwrap_or(name).to_string(),
                    resource_name: name.to_string(),
                    resource_type: "k8s_pod".into(),
                    region: Some(node.to_string()),
                    tags: pod["metadata"]["labels"].clone(),
                    meta: json!({
                        "namespace": namespace,
                        "node": node,
                        "phase": pod["status"]["phase"].as_str().unwrap_or(""),
                        "containers": container_meta,
                    }),
                });
            }
        }

        Ok(resources)
    }

    async fn list_regions(&self) -> AppResult<Vec<String>> {
        let body = self.get("/api/v1/namespaces?limit=200").await?;
        let namespaces = body["items"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|n| n["metadata"]["name"].as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        Ok(namespaces)
    }
}

impl KubernetesAdapter {
    pub(crate) fn server_host(&self) -> String {
        self.server
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .trim_end_matches('/')
            .to_string()
    }

    /// Nodes -> cluster capacity + topology.
    pub async fn discover_nodes(&self) -> AppResult<Vec<K8sNodeInfo>> {
        let body = self.get("/api/v1/nodes?limit=500").await?;
        Ok(parse_nodes(&body))
    }

    /// Workloads of all five kinds, pods attributed via owner chain, and
    /// per-workload current usage from metrics-server (None if unavailable).
    pub async fn discover_workloads(&self) -> AppResult<Vec<K8sWorkload>> {
        let ns = self
            .namespace
            .as_deref()
            .map(|n| format!("/namespaces/{n}"))
            .unwrap_or_default();

        // ReplicaSet -> (kind, workload) map for owner-chain resolution.
        let rs_body = self
            .get(&format!("/apis/apps/v1{ns}/replicasets?limit=500"))
            .await?;
        let mut rs_map = std::collections::HashMap::new();
        if let Some(items) = rs_body["items"].as_array() {
            for rs in items {
                if let Some((kind, wl_name)) = owner_ref(rs) {
                    if let Some(rs_name) = rs["metadata"]["name"].as_str() {
                        rs_map.insert(rs_name.to_string(), (kind, wl_name));
                    }
                }
            }
        }

        // Pods -> attribute to workloads.
        let pods_body = self.get(&format!("/api/v1{ns}/pods?limit=500")).await?;
        let mut pod_workload: std::collections::HashMap<String, (String, String)> =
            std::collections::HashMap::new();
        if let Some(items) = pods_body["items"].as_array() {
            for pod in items {
                if let Some(pod_name) = pod["metadata"]["name"].as_str() {
                    if let Some(wl) = resolve_workload(pod, &rs_map) {
                        pod_workload.insert(pod_name.to_string(), wl);
                    }
                }
            }
        }

        // Current usage (metrics-server); degrade to None on 404/403.
        let usage: Option<Vec<(String, f64, f64)>> = match self
            .get(&format!("/apis/metrics.k8s.io/v1beta1{ns}/pods"))
            .await
        {
            Ok(body) => Some(parse_pod_usage(&body)),
            Err(AppError::Cloud(msg)) => {
                tracing::warn!(error = %msg, "metrics-server unavailable — k8s P95/rightsizing disabled");
                None
            }
            Err(e) => return Err(e),
        };
        let usage_map: std::collections::HashMap<String, (f64, f64)> = usage
            .unwrap_or_default()
            .into_iter()
            .map(|(n, c, m)| (n, (c, m)))
            .collect();

        // Fetch + parse all five kinds.
        let mut workloads = Vec::new();
        for (path, kind) in [
            ("/apis/apps/v1{ns}/deployments?limit=500", "Deployment"),
            ("/apis/apps/v1{ns}/statefulsets?limit=500", "StatefulSet"),
            ("/apis/apps/v1{ns}/daemonsets?limit=500", "DaemonSet"),
            ("/apis/batch/v1{ns}/jobs?limit=500", "Job"),
            ("/apis/batch/v1{ns}/cronjobs?limit=500", "CronJob"),
        ] {
            let path = path.replace("{ns}", &ns);
            match self.get(&path).await {
                Ok(body) => workloads.extend(parse_workloads(&body, kind)),
                Err(e) => tracing::warn!(kind, error = %e, "workload discovery failed"),
            }
        }

        // Attach pod names + usage.
        for wl in &mut workloads {
            wl.pod_names = pod_workload
                .iter()
                .filter(|(_, (k, n))| k == &wl.kind && n == &wl.name)
                .map(|(p, _)| p.clone())
                .collect();
            let usage_sum = wl
                .pod_names
                .iter()
                .filter_map(|p| usage_map.get(p))
                .fold((0.0f64, 0.0f64), |acc, (c, m)| (acc.0 + c, acc.1 + m));
            if wl.pod_names.iter().any(|p| usage_map.contains_key(p)) {
                wl.usage = Some(usage_sum);
            }
        }

        Ok(workloads)
    }
}

impl Default for KubernetesAdapter {
    fn default() -> Self {
        KubernetesAdapter {
            server: String::new(),
            token: None,
            namespace: None,
            http: reqwest::Client::new(),
        }
    }
}

// ── Discovered k8s data (typed, testable) ────────────────────────────────────

#[derive(Debug, Clone)]
pub struct K8sNodeInfo {
    pub name: String,
    pub cpu_cores: f64,
    pub memory_gb: f64,
    pub region: Option<String>,
    pub provider: String,
}

#[derive(Debug, Clone)]
pub struct K8sWorkload {
    pub namespace: String,
    pub name: String,
    /// Deployment | StatefulSet | DaemonSet | Job | CronJob
    pub kind: String,
    pub cpu_request_m: i64,
    pub mem_request_mi: i64,
    pub cpu_limit_m: Option<i64>,
    pub mem_limit_mi: Option<i64>,
    /// Pod names attributed to this workload via ownerReferences.
    pub pod_names: Vec<String>,
    /// Current usage from metrics-server (None when metrics-server absent).
    pub usage: Option<(f64, f64)>, // (cpu_m, mem_mi)
}

// ── Unit parsers ─────────────────────────────────────────────────────────────

/// "100m" -> 100, "1" -> 1000, "1.5" -> 1500, "123456789n" -> 123
pub fn parse_cpu_millicores(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let (num, mult): (&str, f64) = if let Some(v) = s.strip_suffix('n') {
        (v, 1.0 / 1_000_000.0)
    } else if let Some(v) = s.strip_suffix('u') {
        (v, 1.0 / 1_000.0)
    } else if let Some(v) = s.strip_suffix('m') {
        (v, 1.0)
    } else {
        (s, 1000.0)
    };
    let value: f64 = num.trim().parse().ok()?;
    Some((value * mult).round() as i64)
}

/// "512Mi" -> 512, "1Gi" -> 1024, "134217728" -> 128, "1.5Gi" -> 1536
pub fn parse_memory_mib(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    const SUFFIXES: [(&str, f64); 8] = [
        ("Ti", 1024.0 * 1024.0),
        ("Gi", 1024.0),
        ("Mi", 1.0),
        ("Ki", 1.0 / 1024.0),
        ("T", 1024.0 * 1024.0),
        ("G", 1024.0),
        ("M", 1.0),
        ("K", 1.0 / 1024.0),
    ];
    for (suf, mult) in SUFFIXES {
        if let Some(v) = s.strip_suffix(suf) {
            let value: f64 = v.trim().parse().ok()?;
            return Some((value * mult).round() as i64);
        }
    }
    let bytes: f64 = s.parse().ok()?;
    Some((bytes / (1024.0 * 1024.0)).round() as i64)
}

/// First ownerReference of a k8s object: (kind, name).
fn owner_ref(item: &Value) -> Option<(String, String)> {
    let refs = item["metadata"]["ownerReferences"].as_array()?;
    let first = refs.first()?;
    let kind = first["kind"].as_str()?.to_string();
    let name = first["name"].as_str()?.to_string();
    Some((kind, name))
}

/// Resolve a pod to its workload (kind, name) via the owner chain:
/// ReplicaSet -> Deployment/StatefulSet/DaemonSet; Job/CronJob direct.
/// `rs_map` maps ReplicaSet name -> (kind, workload name).
fn resolve_workload(
    pod: &Value,
    rs_map: &std::collections::HashMap<String, (String, String)>,
) -> Option<(String, String)> {
    let (kind, name) = owner_ref(pod)?;
    match kind.as_str() {
        "ReplicaSet" => rs_map.get(&name).cloned(),
        "Job" | "CronJob" => Some((kind, name)),
        _ => None,
    }
}

/// Provider from `spec.providerID` prefix (aws:// -> aws, azure:// -> azure,
/// gce:// -> gcp, aliyun:// -> alibaba, otherwise on-prem).
fn provider_from_provider_id(provider_id: &str) -> String {
    if provider_id.starts_with("aws://") {
        "aws".into()
    } else if provider_id.starts_with("azure://") {
        "azure".into()
    } else if provider_id.starts_with("gce://") {
        "gcp".into()
    } else if provider_id.starts_with("aliyun://") {
        "alibaba".into()
    } else {
        "on-prem".into()
    }
}

// ── Response parsers ─────────────────────────────────────────────────────────

fn parse_nodes(body: &Value) -> Vec<K8sNodeInfo> {
    let empty = vec![];
    let items = body["items"].as_array().unwrap_or(&empty);
    items
        .iter()
        .filter_map(|n| {
            let name = n["metadata"]["name"].as_str()?.to_string();
            let cpu = n["status"]["capacity"]["cpu"]
                .as_str()
                .and_then(parse_cpu_millicores)
                .map(|m| m as f64 / 1000.0)
                .unwrap_or(0.0);
            let memory_gb = n["status"]["capacity"]["memory"]
                .as_str()
                .and_then(parse_memory_mib)
                .map(|mi| mi as f64 / 1024.0)
                .unwrap_or(0.0);
            let region = n["metadata"]["labels"]["topology.kubernetes.io/region"]
                .as_str()
                .or_else(|| {
                    n["metadata"]["labels"]["failure-domain.beta.kubernetes.io/region"].as_str()
                })
                .map(str::to_string);
            let provider =
                provider_from_provider_id(n["spec"]["providerID"].as_str().unwrap_or(""));
            Some(K8sNodeInfo {
                name,
                cpu_cores: cpu,
                memory_gb,
                region,
                provider,
            })
        })
        .collect()
}

/// Shared parse for Deployment/StatefulSet/DaemonSet (apps/v1) and
/// Job/CronJob (batch/v1) list bodies. CronJob templates live under
/// `spec.jobTemplate.spec.template`; the rest under `spec.template`.
fn parse_workloads(body: &Value, kind: &str) -> Vec<K8sWorkload> {
    let empty = vec![];
    let items = body["items"].as_array().unwrap_or(&empty);
    items
        .iter()
        .filter_map(|w| {
            let name = w["metadata"]["name"].as_str()?.to_string();
            let namespace = w["metadata"]["namespace"]
                .as_str()
                .unwrap_or("default")
                .to_string();
            let template = if kind == "CronJob" {
                &w["spec"]["jobTemplate"]["spec"]["template"]
            } else {
                &w["spec"]["template"]
            };
            let mut cpu_request_m = 0i64;
            let mut mem_request_mi = 0i64;
            let mut cpu_limit_m: Option<i64> = None;
            let mut mem_limit_mi: Option<i64> = None;
            if let Some(containers) = template["spec"]["containers"].as_array() {
                for c in containers {
                    if let Some(v) = c["resources"]["requests"]["cpu"]
                        .as_str()
                        .and_then(parse_cpu_millicores)
                    {
                        cpu_request_m += v;
                    }
                    if let Some(v) = c["resources"]["requests"]["memory"]
                        .as_str()
                        .and_then(parse_memory_mib)
                    {
                        mem_request_mi += v;
                    }
                    if let Some(v) = c["resources"]["limits"]["cpu"]
                        .as_str()
                        .and_then(parse_cpu_millicores)
                    {
                        *cpu_limit_m.get_or_insert(0) += v;
                    }
                    if let Some(v) = c["resources"]["limits"]["memory"]
                        .as_str()
                        .and_then(parse_memory_mib)
                    {
                        *mem_limit_mi.get_or_insert(0) += v;
                    }
                }
            }
            Some(K8sWorkload {
                namespace,
                name,
                kind: kind.to_string(),
                cpu_request_m,
                mem_request_mi,
                cpu_limit_m,
                mem_limit_mi,
                pod_names: Vec::new(),
                usage: None,
            })
        })
        .collect()
}

/// metrics-server pod list -> per-pod (name, cpu_m, mem_mi) usage.
fn parse_pod_usage(body: &Value) -> Vec<(String, f64, f64)> {
    let empty = vec![];
    let items = body["items"].as_array().unwrap_or(&empty);
    items
        .iter()
        .filter_map(|p| {
            let name = p["metadata"]["name"].as_str()?.to_string();
            let mut cpu_m = 0.0f64;
            let mut mem_mi = 0.0f64;
            if let Some(containers) = p["containers"].as_array() {
                for c in containers {
                    if let Some(v) = c["usage"]["cpu"].as_str().and_then(parse_cpu_millicores) {
                        cpu_m += v as f64;
                    }
                    if let Some(v) = c["usage"]["memory"].as_str().and_then(parse_memory_mib) {
                        mem_mi += v as f64;
                    }
                }
            }
            Some((name, cpu_m, mem_mi))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_cpu_millicores_handles_suffixes() {
        assert_eq!(parse_cpu_millicores("100m"), Some(100));
        assert_eq!(parse_cpu_millicores("1"), Some(1000));
        assert_eq!(parse_cpu_millicores("1.5"), Some(1500));
        assert_eq!(parse_cpu_millicores("123456789n"), Some(123));
        assert_eq!(parse_cpu_millicores("250u"), Some(0));
        assert_eq!(parse_cpu_millicores(""), None);
        assert_eq!(parse_cpu_millicores("abc"), None);
    }

    #[test]
    fn parse_memory_mib_handles_suffixes() {
        assert_eq!(parse_memory_mib("512Mi"), Some(512));
        assert_eq!(parse_memory_mib("1Gi"), Some(1024));
        assert_eq!(parse_memory_mib("1.5Gi"), Some(1536));
        assert_eq!(parse_memory_mib("134217728"), Some(128));
        assert_eq!(parse_memory_mib("2Ki"), Some(0));
        assert_eq!(parse_memory_mib(""), None);
    }

    #[test]
    fn parse_nodes_extracts_capacity_and_topology() {
        let body = json!({
            "items": [{
                "metadata": {
                    "name": "node-1",
                    "labels": { "topology.kubernetes.io/region": "cn-hangzhou" }
                },
                "spec": { "providerID": "aliyun://i-bp1abc" },
                "status": { "capacity": { "cpu": "8", "memory": "32Gi" } }
            }, {
                "metadata": { "name": "node-2" },
                "spec": { "providerID": "aws:///us-east-1a/i-0xyz" },
                "status": { "capacity": { "cpu": "2", "memory": "8Gi" } }
            }]
        });
        let nodes = parse_nodes(&body);
        assert_eq!(nodes.len(), 2);
        assert_eq!(nodes[0].name, "node-1");
        assert_eq!(nodes[0].cpu_cores, 8.0);
        assert_eq!(nodes[0].memory_gb, 32.0);
        assert_eq!(nodes[0].region.as_deref(), Some("cn-hangzhou"));
        assert_eq!(nodes[0].provider, "alibaba"); // aliyun:// mapped
        assert_eq!(nodes[1].provider, "aws");
    }

    #[test]
    fn parse_workloads_sums_container_requests_and_limits() {
        let body = json!({
            "items": [{
                "metadata": { "name": "web", "namespace": "prod" },
                "spec": { "template": { "spec": { "containers": [
                    { "name": "app", "resources": {
                        "requests": { "cpu": "500m", "memory": "512Mi" },
                        "limits": { "cpu": "1", "memory": "1Gi" }
                    }},
                    { "name": "sidecar", "resources": {
                        "requests": { "cpu": "100m", "memory": "64Mi" }
                    }}
                ]}}}
            }]
        });
        let wl = parse_workloads(&body, "Deployment");
        assert_eq!(wl.len(), 1);
        assert_eq!(wl[0].cpu_request_m, 600);
        assert_eq!(wl[0].mem_request_mi, 576);
        assert_eq!(wl[0].cpu_limit_m, Some(1000));
        assert_eq!(wl[0].mem_limit_mi, Some(1024));
        assert_eq!(wl[0].kind, "Deployment");
    }

    #[test]
    fn parse_workloads_cronjob_template_path() {
        let body = json!({
            "items": [{
                "metadata": { "name": "backup", "namespace": "ops" },
                "spec": { "jobTemplate": { "spec": { "template": { "spec": { "containers": [
                    { "name": "job", "resources": { "requests": { "cpu": "200m", "memory": "128Mi" } } }
                ]}}}}}
            }]
        });
        let wl = parse_workloads(&body, "CronJob");
        assert_eq!(wl[0].cpu_request_m, 200);
        assert_eq!(wl[0].kind, "CronJob");
    }

    #[test]
    fn parse_pod_usage_sums_containers() {
        let body = json!({
            "items": [{
                "metadata": { "name": "web-7d8f9-abc12" },
                "containers": [
                    { "name": "app", "usage": { "cpu": "123456789n", "memory": "134217728" } },
                    { "name": "sidecar", "usage": { "cpu": "10m", "memory": "16Mi" } }
                ]
            }]
        });
        let usage = parse_pod_usage(&body);
        assert_eq!(usage.len(), 1);
        assert_eq!(usage[0].0, "web-7d8f9-abc12");
        assert_eq!(usage[0].1, 133.0); // 123m + 10m
        assert_eq!(usage[0].2, 144.0); // 128Mi + 16Mi
    }

    #[test]
    fn resolve_workload_owner_chain() {
        let mut rs_map = std::collections::HashMap::new();
        rs_map.insert("web-7d8f9".into(), ("Deployment".into(), "web".into()));

        let pod_rs = json!({ "metadata": { "name": "web-7d8f9-abc12", "ownerReferences": [
            { "kind": "ReplicaSet", "name": "web-7d8f9" }
        ]}});
        assert_eq!(
            resolve_workload(&pod_rs, &rs_map),
            Some(("Deployment".into(), "web".into()))
        );

        let pod_job =
            json!({ "metadata": { "ownerReferences": [ { "kind": "Job", "name": "backup-1" } ] }});
        assert_eq!(
            resolve_workload(&pod_job, &rs_map),
            Some(("Job".into(), "backup-1".into()))
        );

        let pod_bare = json!({ "metadata": { "ownerReferences": [] }});
        assert_eq!(resolve_workload(&pod_bare, &rs_map), None);
    }

    #[test]
    fn provider_from_provider_id_maps_prefixes() {
        assert_eq!(provider_from_provider_id("aws:///us-east-1a/i-0"), "aws");
        assert_eq!(
            provider_from_provider_id("azure:///subscriptions/x"),
            "azure"
        );
        assert_eq!(provider_from_provider_id("gce:///project/zone/inst"), "gcp");
        assert_eq!(provider_from_provider_id("aliyun://i-bp1abc"), "alibaba");
        assert_eq!(provider_from_provider_id(""), "on-prem");
    }

    #[test]
    fn parse_kubeconfig_extracts_client_cert_auth() {
        let yaml = r#"apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: Y2VydA==
    server: https://test-cluster.grpc.cn-hangzhou.alicontainer.example.com:6443
  name: kubernetes
contexts:
- context:
    cluster: kubernetes
    user: kubernetes-admin
  name: kubernetes-admin@kubernetes
current-context: kubernetes-admin@kubernetes
kind: Config
preferences: {}
users:
- name: kubernetes-admin
  user:
    client-certificate-data: Y2VydA==
    client-key-data: a2V5
"#;
        let kc = parse_kubeconfig(yaml).unwrap();
        assert_eq!(
            kc.server,
            "https://test-cluster.grpc.cn-hangzhou.alicontainer.example.com:6443"
        );
        assert_eq!(kc.ca_cert_pem.as_deref(), Some("cert"));
        assert_eq!(kc.client_cert_pem.as_deref(), Some("cert"));
        assert_eq!(kc.client_key_pem.as_deref(), Some("key"));
        assert!(kc.token.is_none());
    }

    #[test]
    fn parse_kubeconfig_extracts_token_auth() {
        let yaml = r#"apiVersion: v1
clusters:
- cluster:
    server: https://192.168.1.10:6443
  name: kubernetes
users:
- name: kubelet
  user:
    token: eyJhbGciOiJSUzI1NiJ9.abc
"#;
        let kc = parse_kubeconfig(yaml).unwrap();
        assert_eq!(kc.server, "https://192.168.1.10:6443");
        assert_eq!(kc.token.as_deref(), Some("eyJhbGciOiJSUzI1NiJ9.abc"));
        assert!(kc.ca_cert_pem.is_none());
        assert!(kc.client_cert_pem.is_none());
    }

    #[test]
    fn parse_kubeconfig_rejects_missing_server() {
        let yaml = "apiVersion: v1\nclusters:\n- cluster:\n    name: x\n";
        assert!(parse_kubeconfig(yaml).is_err());
    }

    #[test]
    fn parse_kubeconfig_rejects_no_auth() {
        let yaml = "apiVersion: v1\nclusters:\n- cluster:\n    server: https://x:6443\n";
        assert!(parse_kubeconfig(yaml).is_err());
    }

    #[test]
    fn parse_kubeconfig_rejects_invalid_base64() {
        let yaml = r#"apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: '!!!not-base64!!!'
    server: https://x:6443
users:
- name: u
  user:
    token: tok
"#;
        assert!(parse_kubeconfig(yaml).is_err());
    }

    #[test]
    fn from_kubeconfig_applies_server_and_token() {
        let kc = Kubeconfig {
            server: "https://127.0.0.1:6443/".into(),
            ca_cert_pem: None,
            client_cert_pem: None,
            client_key_pem: None,
            token: Some("tok123".into()),
        };
        let adapter = KubernetesAdapter::from_kubeconfig(&kc, Some("prod".into())).unwrap();
        assert_eq!(adapter.server, "https://127.0.0.1:6443");
        assert_eq!(adapter.token.as_deref(), Some("tok123"));
        assert_eq!(adapter.namespace.as_deref(), Some("prod"));
    }
}
