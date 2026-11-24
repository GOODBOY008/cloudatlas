//! Upload complete bucket/prefix snapshots. The PostgreSQL transaction is the job
//! lease: a process crash rolls back both output and claim, leaving a retriable job.
use super::{bucket_name, currency};
use crate::{
    error::{AppError, AppResult},
    middleware::rbac::{require_permission, Permission},
    modules::auth::service::Claims,
    state::AppState,
};
use axum::{
    extract::{Extension, Multipart, Path, State},
    http::StatusCode,
    Json,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use std::{
    collections::{BTreeMap, HashMap},
    io::Read,
};
use uuid::Uuid;

const EXPANDED_LIMIT: usize = 96 * 1024 * 1024;
type Parts = BTreeMap<String, Vec<u8>>;
#[derive(Deserialize, Serialize)]
struct Rate {
    storage_class: String,
    currency: String,
    per_gib_month: f64,
    source: String,
}
#[derive(Default, Deserialize)]
struct Metadata {
    #[serde(default)]
    prefix: String,
    captured_at: Option<DateTime<Utc>>,
    rate: Option<Rate>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    source_bucket: String,
    file_format: String,
    file_schema: String,
    creation_timestamp: Value,
    files: Vec<ManifestFile>,
}
#[derive(Deserialize)]
struct ManifestFile {
    key: String,
    size: u64,
    #[serde(rename = "MD5checksum", alias = "MD5Checksum")]
    md5: String,
}
fn invalid(msg: &str) -> AppError {
    AppError::Validation(msg.to_owned())
}

fn verify_manifest(m: &Manifest, bucket: &str, parts: &Parts) -> AppResult<DateTime<Utc>> {
    let source = m
        .source_bucket
        .rsplit(":::")
        .next()
        .unwrap_or(&m.source_bucket);
    if source != bucket || !m.file_format.eq_ignore_ascii_case("CSV") {
        return Err(invalid("The CSV manifest must belong to this bucket"));
    }
    if m.file_schema.split(',').any(|s| {
        s.trim().eq_ignore_ascii_case("RecordType")
            || s.trim().eq_ignore_ascii_case("SequenceNumber")
    }) {
        return Err(invalid(
            "A complete inventory is required; incremental event logs cannot replace a snapshot",
        ));
    }
    let columns = csv::StringRecord::from(m.file_schema.split(',').collect::<Vec<_>>());
    let header = fields(&columns).map_err(AppError::Validation)?;
    if !header.contains_key("bucket") {
        return Err(invalid("Provider inventory needs a Bucket field"));
    }
    if m.files.len() != parts.len() {
        return Err(invalid("Upload every CSV shard listed by the manifest"));
    }
    let mut seen = std::collections::HashSet::new();
    for f in &m.files {
        let filename = f.key.rsplit('/').next().unwrap_or("");
        let bytes = parts
            .get(filename)
            .ok_or_else(|| invalid("A manifest shard is missing"))?;
        if !seen.insert(filename)
            || bytes.len() as u64 != f.size
            || !hex::encode(md5::Md5::digest(bytes)).eq_ignore_ascii_case(&f.md5)
        {
            return Err(invalid("Manifest shard name, size or checksum mismatch"));
        }
    }
    let val = &m.creation_timestamp;
    if let Some(ms) = val
        .as_i64()
        .or_else(|| val.as_str().and_then(|s| s.parse().ok()))
    {
        let time = if (0..10_000_000_000).contains(&ms) {
            DateTime::from_timestamp(ms, 0)
        } else {
            DateTime::from_timestamp_millis(ms)
        };
        if let Some(date) = time {
            return Ok(date);
        }
    }
    val.as_str()
        .and_then(|v| v.parse::<DateTime<Utc>>().ok())
        .ok_or_else(|| invalid("Invalid manifest creationTimestamp"))
}
#[utoipa::path(post,path="/api/v1/orgs/{org_id}/object-storage/buckets/{id}/inventories",tag="object-storage",security(("bearer_auth"=[])),responses((status=202,description="Inventory queued; repeated batches return the existing ID")))]
pub async fn upload(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    mut form: Multipart,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user = claims.user_id()?;
    require_permission(&state.db, user, org, Permission::ManageCloudAccounts).await?;
    let bucket = bucket_name(&state.db, org, id).await?;
    let mut parts = Parts::new();
    let mut meta = None;
    let mut manifest = None;
    while let Some(field) = form
        .next_field()
        .await
        .map_err(|_| invalid("Invalid multipart inventory or upload exceeds 32 MiB"))?
    {
        match field.name() {
            Some("metadata") if meta.is_none() => {
                let raw = field
                    .bytes()
                    .await
                    .map_err(|_| invalid("Invalid metadata"))?;
                meta = Some(
                    serde_json::from_slice::<Metadata>(&raw)
                        .map_err(|_| invalid("Invalid inventory metadata"))?,
                )
            }
            Some("manifest") if manifest.is_none() => {
                let raw = field
                    .bytes()
                    .await
                    .map_err(|_| invalid("Invalid manifest"))?;
                manifest = Some(
                    serde_json::from_slice::<Manifest>(&raw)
                        .map_err(|_| invalid("Invalid inventory manifest JSON"))?,
                )
            }
            Some("file") => {
                let name = field
                    .file_name()
                    .ok_or_else(|| invalid("Inventory file needs a filename"))?
                    .rsplit('/')
                    .next()
                    .unwrap_or("")
                    .to_owned();
                let data = field
                    .bytes()
                    .await
                    .map_err(|_| invalid("Invalid file or upload exceeds 32 MiB"))?;
                if name.is_empty()
                    || name.len() > 512
                    || parts.len() >= 256
                    || parts.insert(name, data.to_vec()).is_some()
                {
                    return Err(invalid("Invalid or duplicate shard filename"));
                }
            }
            _ => return Err(invalid("Unexpected inventory form field")),
        }
    }
    let m = meta.unwrap_or_default();
    if m.prefix.len() > 1024 || m.prefix.contains('\0') {
        return Err(invalid("Invalid inventory prefix"));
    }
    let (captured, schema, source) = if let Some(man) = manifest {
        let capture = verify_manifest(&man, &bucket, &parts)?;
        (capture, Some(man.file_schema), "provider_manifest")
    } else {
        if parts.len() != 1 {
            return Err(invalid(
                "Upload one complete headered CSV, or a manifest with all its CSV shards",
            ));
        }
        (
            m.captured_at
                .ok_or_else(|| invalid("Inventory capture time is required"))?,
            None,
            "uploaded_csv",
        )
    };
    if captured > Utc::now() + chrono::Duration::minutes(5) {
        return Err(invalid("Inventory capture time is in the future"));
    }
    if let Some(ref rate) = m.rate {
        if !rate.per_gib_month.is_finite()
            || rate.per_gib_month < 0.0
            || rate.per_gib_month > 1_000_000.0
            || rate.source.trim().is_empty()
            || rate.source.len() > 512
            || rate.storage_class.trim().is_empty()
            || rate.storage_class.len() > 128
            || rate.currency != currency(&state.db, org).await?
        {
            return Err(invalid("Supply a documented class-specific rate in the workspace currency per GiB per month"));
        }
    }
    let mut digest = Sha256::new();
    digest.update(json!([source, schema, m.rate]).to_string());
    for (name, bytes) in &parts {
        if schema.is_some() {
            digest.update((name.len() as u64).to_be_bytes());
            digest.update(name);
        }
        digest.update(Sha256::digest(bytes));
    }
    let fingerprint = hex::encode(digest.finalize());
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT id FROM resources WHERE id=$1 AND organization_id=$2 AND active AND resource_type='bucket' FOR UPDATE")
        .bind(id).bind(org).fetch_optional(&mut *tx).await?.ok_or_else(||AppError::NotFound("Bucket no longer active".into()))?;
    if let Some((existing,hash,status))=sqlx::query_as::<_,(Uuid,String,String)>("SELECT id,fingerprint,status FROM storage_inventory_imports WHERE bucket_id=$1 AND prefix=$2 AND captured_at=$3")
        .bind(id).bind(&m.prefix).bind(captured).fetch_optional(&mut *tx).await?{
        if hash==fingerprint{return Ok((StatusCode::ACCEPTED,Json(json!({"data":{"id":existing,"status":status,"reused":true}}))))}
        if status!="failed"{return Err(AppError::Conflict("A different snapshot already exists for this scope and capture time".into()))}
        sqlx::query("DELETE FROM storage_inventory_imports WHERE id=$1 AND status='failed'").bind(existing).execute(&mut *tx).await?;
    }
    let rate = m.rate.as_ref();
    let job:Uuid=sqlx::query_scalar("INSERT INTO storage_inventory_imports(bucket_id,prefix,captured_at,submitted_by,fingerprint,source,schema_fields,rate_gib_month,rate_currency,rate_class,rate_source)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::float8::numeric,$9,$10,$11) RETURNING id").bind(id).bind(m.prefix).bind(captured).bind(user).bind(fingerprint).bind(source).bind(schema)
        .bind(rate.map(|r|r.per_gib_month)).bind(rate.map(|r|r.currency.as_str())).bind(rate.map(|r|r.storage_class.trim())).bind(rate.map(|r|r.source.trim())).fetch_one(&mut *tx).await?;
    for (name, bytes) in parts {
        sqlx::query("INSERT INTO storage_inventory_parts VALUES ($1,$2,$3)")
            .bind(job)
            .bind(name)
            .bind(bytes)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({"data":{"id":job,"status":"pending","reused":false}})),
    ))
}

struct Object {
    key: String,
    version: String,
    size: Option<i64>,
    etag: Option<String>,
    sha: Option<String>,
    class: Option<String>,
}
fn fields(headers: &csv::StringRecord) -> Result<HashMap<String, usize>, String> {
    let mut out = HashMap::new();
    for (i, col) in headers.iter().enumerate() {
        let name = col
            .trim_start_matches('\u{feff}')
            .trim()
            .to_ascii_lowercase()
            .replace('_', "");
        if out.insert(name, i).is_some() {
            return Err("Duplicate CSV header".into());
        }
    }
    if !out.contains_key("key") {
        return Err("CSV must contain the key column".into());
    }
    if out.contains_key("versionid") && !out.contains_key("islatest") {
        return Err("Versioned inventories require is_latest".into());
    }
    if out.contains_key("recordtype") || out.contains_key("sequencenumber") {
        return Err("Incremental inventories are not complete snapshots".into());
    }
    Ok(out)
}
fn flag(v: Option<&str>, default: bool) -> Result<bool, String> {
    match v.map(str::to_ascii_lowercase).as_deref() {
        None => Ok(default),
        Some("true" | "1") => Ok(true),
        Some("false" | "0") => Ok(false),
        _ => Err("Invalid version flag".into()),
    }
}
fn parse_parts(
    parts: Vec<Vec<u8>>,
    schema: Option<String>,
    bucket: &str,
    prefix: &str,
) -> Result<Vec<Object>, String> {
    let mut objects = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut remaining = EXPANDED_LIMIT;
    for raw in parts {
        let plain = if raw.starts_with(&[0x1f, 0x8b]) {
            let mut buf = Vec::new();
            flate2::read::MultiGzDecoder::new(raw.as_slice())
                .take(remaining as u64 + 1)
                .read_to_end(&mut buf)
                .map_err(|_| "Invalid gzip inventory")?;
            buf
        } else {
            raw
        };
        remaining = remaining
            .checked_sub(plain.len())
            .ok_or("Expanded inventory exceeds 96 MiB")?;
        let mut reader = csv::ReaderBuilder::new()
            .has_headers(schema.is_none())
            .from_reader(plain.as_slice());
        let headers = match &schema {
            Some(s) => csv::StringRecord::from(s.split(',').collect::<Vec<_>>()),
            None => reader.headers().map_err(|_| "Invalid CSV header")?.clone(),
        };
        let cols = fields(&headers)?;
        for (index, record) in reader.records().enumerate() {
            let row = record.map_err(|_| format!("Invalid CSV at row {}", index + 1))?;
            if row.len() != headers.len() {
                return Err(format!("Column count mismatch at row {}", index + 1));
            }
            let get = |k: &str| {
                cols.get(k)
                    .and_then(|i| row.get(*i))
                    .filter(|v| !v.is_empty())
            };
            if schema.is_some() && get("bucket").is_none()
                || get("bucket").is_some_and(|s| s != bucket)
            {
                return Err(format!("Wrong bucket at row {}", index + 1));
            }
            let raw_key = get("key").ok_or("Missing object key")?;
            let key = if schema.is_some() {
                percent_encoding::percent_decode_str(raw_key)
                    .decode_utf8()
                    .map_err(|_| "Invalid encoded key")?
                    .into_owned()
            } else {
                raw_key.into()
            };
            if key.len() > 1024 || key.contains('\0') || !key.starts_with(prefix) {
                return Err(format!(
                    "Invalid key or key outside selected prefix at row {}",
                    index + 1
                ));
            }
            if cols.contains_key("islatest") && get("islatest").is_none() {
                return Err("Missing is_latest".into());
            }
            if !flag(get("islatest"), true)? {
                continue;
            }
            if !seen.insert(key.clone()) {
                return Err(format!(
                    "Multiple current rows for an object at row {}",
                    index + 1
                ));
            }
            if seen.len() > 250_000 {
                return Err("Inventory exceeds 250000 current keys per batch".into());
            }
            if flag(get("isdeletemarker"), false)? {
                continue;
            }
            let size = get("size")
                .map(str::parse::<i64>)
                .transpose()
                .map_err(|_| "Invalid object size")?;
            if size.is_some_and(|v| v < 0) {
                return Err("Negative object size".into());
            }
            let digest = get("fullsha256").or_else(|| {
                if get("checksumtype") == Some("FULL_OBJECT") {
                    get("checksumsha256")
                } else {
                    None
                }
            });
            let sha = digest
                .map(|v| {
                    let bytes = if v.len() == 64 && v.bytes().all(|c| c.is_ascii_hexdigit()) {
                        hex::decode(v).ok()
                    } else {
                        STANDARD.decode(v).ok()
                    };
                    bytes
                        .filter(|s| s.len() == 32)
                        .map(hex::encode)
                        .ok_or("Invalid full-object SHA-256")
                })
                .transpose()?;
            let version = get("versionid").unwrap_or("");
            let etag = get("etag")
                .map(|s| s.trim_matches('"'))
                .filter(|s| !s.is_empty());
            let class = get("storageclass");
            if [Some(version), etag, class]
                .into_iter()
                .flatten()
                .any(|v| v.len() > 1024 || v.contains('\0'))
            {
                return Err("Invalid inventory metadata".into());
            }
            objects.push(Object {
                key,
                version: version.into(),
                size,
                etag: etag.map(str::to_owned),
                sha,
                class: class.map(str::to_owned),
            });
        }
    }
    Ok(objects)
}
pub async fn process_next(db: &PgPool) -> AppResult<bool> {
    let mut tx = db.begin().await?;
    let Some(row)=sqlx::query("SELECT i.id,i.prefix,i.schema_fields,storage_native_bucket_id(a.provider::text,r.cloud_resource_id) AS bucket FROM storage_inventory_imports i JOIN resources r ON r.id=i.bucket_id JOIN cloud_accounts a ON a.id=r.cloud_account_id AND a.organization_id=r.organization_id WHERE i.status='pending' ORDER BY i.created_at,i.id LIMIT 1 FOR UPDATE OF i SKIP LOCKED").fetch_optional(&mut *tx).await? else{return Ok(false)};
    let id: Uuid = row.try_get("id")?;
    let parts = sqlx::query_scalar::<_, Vec<u8>>(
        "SELECT payload FROM storage_inventory_parts WHERE import_id=$1 ORDER BY filename",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    let schema = row.try_get("schema_fields")?;
    let bucket: String = row.try_get("bucket")?;
    let prefix: String = row.try_get("prefix")?;
    let parsed = tokio::task::spawn_blocking(move || parse_parts(parts, schema, &bucket, &prefix))
        .await
        .map_err(|e| AppError::Internal(e.into()))?;
    match parsed {
        Err(reason) => {
            sqlx::query(
                "UPDATE storage_inventory_imports SET status='failed',error=$2 WHERE id=$1",
            )
            .bind(id)
            .bind(reason)
            .execute(&mut *tx)
            .await?;
        }
        Ok(objects) => {
            for chunk in objects.chunks(1000) {
                sqlx::query("INSERT INTO storage_inventory_objects(import_id,object_key,version_id,bytes,etag,sha256,storage_class)
                    SELECT $1,* FROM unnest($2::text[],$3::text[],$4::bigint[],$5::text[],$6::text[],$7::text[])")
                    .bind(id).bind(chunk.iter().map(|o|o.key.as_str()).collect::<Vec<_>>()).bind(chunk.iter().map(|o|o.version.as_str()).collect::<Vec<_>>())
                    .bind(chunk.iter().map(|o|o.size).collect::<Vec<_>>()).bind(chunk.iter().map(|o|o.etag.as_deref()).collect::<Vec<_>>())
                    .bind(chunk.iter().map(|o|o.sha.as_deref()).collect::<Vec<_>>()).bind(chunk.iter().map(|o|o.class.as_deref()).collect::<Vec<_>>()).execute(&mut *tx).await?;
            }
            sqlx::query("UPDATE storage_inventory_imports SET status='complete',object_count=t.n,size_bytes=t.bytes FROM
              (SELECT count(*) n,CASE WHEN count(bytes)=count(*) THEN coalesce(sum(bytes),0) END bytes FROM storage_inventory_objects WHERE import_id=$1) t WHERE id=$1").bind(id).execute(&mut *tx).await?;
        }
    }
    sqlx::query("DELETE FROM storage_inventory_parts WHERE import_id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(true)
}
pub async fn worker(db: PgPool) {
    loop {
        match process_next(&db).await {
            Ok(true) => continue,
            Ok(false) => (),
            Err(error) => tracing::error!(%error,"Inventory import worker failed"),
        }
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    }
}
