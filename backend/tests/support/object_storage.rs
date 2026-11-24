use super::{
    setup,
    workspace_environment::{identity, organization, reader, request},
};
use axum::{
    body::{to_bytes, Body},
    http::{Method, Request, StatusCode},
    Router,
};
use cloudatlas_lib::{
    config::Config,
    modules::{
        billing::ingest::{self, BillingLine},
        object_storage::inventory::process_next,
    },
    state::AppState,
};
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

async fn account(db: &PgPool, org: Uuid) -> Uuid {
    sqlx::query_scalar("INSERT INTO cloud_accounts(organization_id,name,provider,credentials_enc) VALUES ($1,$2,'alibaba','') RETURNING id")
        .bind(org).bind(format!("account-{org}-{}",Uuid::new_v4())).fetch_one(db).await.unwrap()
}
async fn bucket(db: &PgPool, org: Uuid, account: Uuid, name: &str) -> (Uuid, Uuid) {
    let ci:Uuid=sqlx::query_scalar("INSERT INTO cis(organization_id,cloud_account_id,cloud_resource_id,ci_type_id,name) SELECT $1,$2,$3,id,$3 FROM ci_types WHERE name='cloud_bucket' AND is_builtin LIMIT 1 RETURNING id")
        .bind(org).bind(account).bind(name).fetch_one(db).await.unwrap();
    let id=sqlx::query_scalar("INSERT INTO resources(organization_id,cloud_account_id,cloud_resource_id,resource_type,name,ci_id) VALUES ($1,$2,$3,'bucket',$3,$4) RETURNING id")
        .bind(org).bind(account).bind(name).bind(ci).fetch_one(db).await.unwrap();
    (id, ci)
}
async fn upload(
    app: &Router,
    path: &str,
    token: &str,
    meta: Value,
    files: &[(&str, &str, Vec<u8>)],
    expected: StatusCode,
) -> Value {
    let mut data = format!(
        "--boundary\r\nContent-Disposition: form-data; name=\"metadata\"\r\n\r\n{meta}\r\n"
    )
    .into_bytes();
    for (field, name, content) in files {
        data.extend(format!("--boundary\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{name}\"\r\n\r\n").as_bytes());
        data.extend(content);
        data.extend(b"\r\n");
    }
    data.extend(b"--boundary--\r\n");
    let req = Request::builder()
        .method(Method::POST)
        .uri(path)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "multipart/form-data; boundary=boundary")
        .body(Body::from(data))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let v: Value =
        serde_json::from_slice(&to_bytes(res.into_body(), 1024 * 1024).await.unwrap()).unwrap();
    assert_eq!(status, expected, "{v}");
    v["data"].clone()
}
async fn run_queue(db: &PgPool) {
    while process_next(db).await.unwrap() {}
}
fn line(id: &str, amount: f64, item: &str) -> BillingLine {
    BillingLine {
        resource_id: id.into(),
        resource_name: None,
        resource_type: "bucket".into(),
        region: None,
        service: "oss".into(),
        date: "2026-10-12".parse().unwrap(),
        amount,
        currency: "CNY".into(),
        tags: json!({}),
        evidence: json!({"billing_item":item}),
    }
}

#[tokio::test]
async fn unified_inventory_ownership_and_billing() {
    let Some((app, db)) = setup().await else {
        return;
    };
    let (steward, token) = identity(&app).await;
    let (_, prod_token) = identity(&app).await;
    let org = organization(&app, &token).await;
    let prod = organization(&app, &prod_token).await;
    let (view_user, view_token) = identity(&app).await;
    reader(&db, org, view_user).await;
    sqlx::query("UPDATE organizations SET settings='{\"currency\":\"CNY\"}' WHERE id=$1")
        .bind(org)
        .execute(&db)
        .await
        .unwrap();
    let ws: Uuid =
        sqlx::query_scalar("INSERT INTO business_workspaces(name) VALUES ($1) RETURNING id")
            .bind(org.to_string())
            .fetch_one(&db)
            .await
            .unwrap();
    sqlx::query("INSERT INTO workspace_environments(workspace_id,organization_id,environment) VALUES ($1,$2,'pre'),($1,$3,'prod')").bind(ws).bind(org).bind(prod).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO workspace_catalog_editors VALUES ($1,$2)")
        .bind(ws)
        .bind(steward)
        .execute(&db)
        .await
        .unwrap();
    let a = account(&db, org).await;
    let a2 = account(&db, org).await;
    let ap = account(&db, prod).await;
    let (id, ci) = bucket(&db, org, a, "reports-data").await;
    let (other, _) = bucket(&db, org, a2, "reports-data").await;
    let (foreign, _) = bucket(&db, prod, ap, "reports-data").await;
    for kind in ["volume", "snapshot"] {
        sqlx::query("INSERT INTO resources(organization_id,cloud_account_id,cloud_resource_id,resource_type,service_name) VALUES ($1,$2,$3,$3::text::resource_type,'Storage')").bind(org).bind(a).bind(kind).execute(&db).await.unwrap();
    }
    let root = format!("/api/v1/orgs/{org}");
    let base = format!("{root}/object-storage");
    let period = "start_date=2026-10-01&end_date=2026-10-31";
    let overview = || request(&app, Method::GET, &base, &token, None, StatusCode::OK);
    let v = overview().await;
    assert_eq!(v["bucket_count"], 2);
    assert_eq!(v["unclaimed_count"], 2);
    assert!(v["period_cost"].is_null());
    let detail = format!("{base}/buckets/{id}?{period}");
    let v = request(
        &app,
        Method::GET,
        &detail,
        &view_token,
        None,
        StatusCode::OK,
    )
    .await;
    assert!(v["usage"]["object_count"].is_null());
    request(
        &app,
        Method::GET,
        &format!("{base}/buckets/{foreign}"),
        &token,
        None,
        StatusCode::NOT_FOUND,
    )
    .await;
    request(
        &app,
        Method::GET,
        &base,
        &prod_token,
        None,
        StatusCode::FORBIDDEN,
    )
    .await;
    let state = AppState::new(db.clone(), Config::from_env().unwrap());
    for (acct, lines) in [
        (
            a,
            vec![
                line("reports-data", 8.0, "TimedStorage"),
                line("reports-data", 2.0, "Requests"),
                line("unmatched-charge", 4.0, "Traffic"),
            ],
        ),
        (a2, vec![line("reports-data", 0.0, "Retrieval")]),
    ] {
        ingest::import_daily(&state, org, acct, lines, None)
            .await
            .unwrap();
        ingest::aggregate(&state, org, acct).await.unwrap();
    }
    sqlx::query("INSERT INTO expenses(organization_id,cloud_account_id,cloud_resource_id,resource_type,date,cost,currency) VALUES($1,$2,'foreign-currency','bucket','2026-10-12',999,'USD')").bind(org).bind(a).execute(&db).await.unwrap();
    let url = format!("{base}?{period}");
    let v = request(&app, Method::GET, &url, &token, None, StatusCode::OK).await;
    assert_eq!(v["period_cost"].as_f64(), Some(14.0));
    assert_eq!(v["billed_count"], 2);
    assert_eq!(v["excluded_currency_rows"], 1);
    let other = v["buckets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["id"] == other.to_string())
        .unwrap();
    assert_eq!(other["cost"].as_f64(), Some(0.0));
    let mut services = vec![];
    for name in ["Reporting", "Analytics"] {
        let svc = request(
            &app,
            Method::POST,
            &format!("{root}/catalog/services"),
            &token,
            Some(json!({"name":name,"system_name":"BI"})),
            StatusCode::CREATED,
        )
        .await;
        let sid = svc["id"].as_str().unwrap().to_owned();
        let bind = format!("{root}/catalog/services/{sid}/cis");
        request(
            &app,
            Method::POST,
            &bind,
            &view_token,
            Some(json!({"ci_id":ci})),
            StatusCode::FORBIDDEN,
        )
        .await;
        let deployed = request(
            &app,
            Method::POST,
            &bind,
            &token,
            Some(json!({"ci_id":ci})),
            StatusCode::CREATED,
        )
        .await;
        let reverse = request(
            &app,
            Method::GET,
            &format!(
                "{root}/services/{}/cis",
                deployed["deployment_id"].as_str().unwrap()
            ),
            &token,
            None,
            StatusCode::OK,
        )
        .await;
        assert_eq!(reverse[0]["ci_id"], ci.to_string());
        services.push(sid);
        let v = request(&app, Method::GET, &url, &token, None, StatusCode::OK).await;
        assert_eq!(
            v["allocated_cost"].as_f64(),
            Some(if services.len() == 1 { 10.0 } else { 0.0 })
        );
        assert_eq!(v["period_cost"].as_f64(), Some(14.0));
    }
    let filtered = request(
        &app,
        Method::GET,
        &format!("{url}&service_id={}", services[0]),
        &token,
        None,
        StatusCode::OK,
    )
    .await;
    assert_eq!(filtered["buckets"].as_array().unwrap().len(), 1);
    let allocate = format!("{base}/buckets/{id}/allocations");
    let rule = json!({"effective_from":"2026-10-01","weights":{(services[0].as_str()):6000,(services[1].as_str()):4000}});
    request(
        &app,
        Method::PUT,
        &allocate,
        &view_token,
        Some(rule.clone()),
        StatusCode::FORBIDDEN,
    )
    .await;
    request(
        &app,
        Method::PUT,
        &allocate,
        &token,
        Some(rule),
        StatusCode::NO_CONTENT,
    )
    .await;
    let v = request(&app, Method::GET, &url, &token, None, StatusCode::OK).await;
    assert_eq!(v["allocated_cost"].as_f64(), Some(10.0));
    assert_eq!(v["unallocated_cost"].as_f64(), Some(4.0));
    let v = request(&app, Method::GET, &detail, &token, None, StatusCode::OK).await;
    assert_eq!(v["owners"].as_array().unwrap().len(), 2);
    assert_eq!(v["trend"][0]["cost"].as_f64(), Some(10.0));
    let mut shares: Vec<_> = v["service_costs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["cost"].as_f64().unwrap() as i64)
        .collect();
    shares.sort();
    assert_eq!(shares, [4, 6]);
    assert_eq!(v["breakdown"].as_array().unwrap().len(), 2);
    let bills = request(
        &app,
        Method::GET,
        &format!("{base}/bills?{period}&bucket_id={id}"),
        &token,
        None,
        StatusCode::OK,
    )
    .await;
    assert_eq!(bills.as_array().unwrap().len(), 2);
    assert!(bills[0]["raw_id"].is_string());
    assert_eq!(bills[0]["original_currency"], "CNY");
    let unassigned = request(
        &app,
        Method::GET,
        &format!("{base}/bills?{period}&allocation=unmatched"),
        &token,
        None,
        StatusCode::OK,
    )
    .await;
    assert_eq!(unassigned.as_array().unwrap().len(), 1);
    // Previously imported native-currency line items still break down when they reconcile.
    sqlx::query("UPDATE raw_expenses SET cloud_specific=jsonb_build_object('line_items',$3::jsonb) WHERE organization_id=$1 AND cloud_account_id=$2 AND cloud_resource_id='reports-data'")
        .bind(org).bind(a).bind(json!([{"product_code":"oss","currency":"CNY","pretax_amount":12,"billing_item":"Storage"},{"product_code":"oss","currency":"CNY","pretax_amount":-2,"billing_item":"Requests"}])).execute(&db).await.unwrap();
    let breakdown = request(&app, Method::GET, &detail, &token, None, StatusCode::OK).await;
    assert_eq!(breakdown["breakdown"].as_array().unwrap().len(), 2);
    assert!(breakdown["breakdown"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["category"] == "requests" && v["cost"].as_f64() == Some(-2.0)));
    let third = request(
        &app,
        Method::POST,
        &format!("{root}/catalog/services"),
        &token,
        Some(json!({"name":"New owner"})),
        StatusCode::CREATED,
    )
    .await;
    request(
        &app,
        Method::POST,
        &format!(
            "{root}/catalog/services/{}/cis",
            third["id"].as_str().unwrap()
        ),
        &token,
        Some(json!({"ci_id":ci})),
        StatusCode::CREATED,
    )
    .await;
    let changed = request(&app, Method::GET, &url, &token, None, StatusCode::OK).await;
    assert_eq!(changed["allocated_cost"].as_f64(), Some(0.0));
    assert_eq!(changed["unallocated_cost"].as_f64(), Some(14.0));
}

#[tokio::test]
async fn imports_content_proof_versions_retries_and_scope() {
    let Some((app, db)) = setup().await else {
        return;
    };
    let (_, token) = identity(&app).await;
    let org = organization(&app, &token).await;
    let a = account(&db, org).await;
    let (_, other_token) = identity(&app).await;
    let other_org = organization(&app, &other_token).await;
    let (viewer, vtoken) = identity(&app).await;
    reader(&db, org, viewer).await;
    let (id, _) = bucket(&db, org, a, "reports-east").await;
    let (peer, _) = bucket(&db, org, a, "reports-west").await;
    let (foreign, _) = bucket(
        &db,
        other_org,
        account(&db, other_org).await,
        "reports-east",
    )
    .await;
    let path = |org, id| format!("/api/v1/orgs/{org}/object-storage/buckets/{id}");
    let root = path(org, id);
    let url = format!("{root}/inventories");
    let hash = "ab".repeat(32);
    let other_hash = "cd".repeat(32);
    let head = "key,size,version_id,is_latest,is_delete_marker,etag,full_sha256,storage_class\n";
    let rows=format!("{head}a/data,1073741824,v2,true,false,aaa,{hash},STD\na/data,1073741824,v1,false,false,old,{hash},STD\nz/file,9,,true,false,etag,,STD\nb/same,3,,true,false,1,{other_hash},STD\nremoved,1,v3,true,true,xxx,,STD\n");
    let files = [("file", "input.csv", rows.as_bytes().to_vec())];
    let metadata = json!({"captured_at":"2025-02-01T00:00:00Z","rate":{"storage_class":"STD","currency":"USD","per_gib_month":0.5,"source":"fixture schedule v1"}});
    upload(
        &app,
        &url,
        &vtoken,
        metadata.clone(),
        &files,
        StatusCode::FORBIDDEN,
    )
    .await;
    upload(
        &app,
        &url,
        &other_token,
        metadata.clone(),
        &files,
        StatusCode::FORBIDDEN,
    )
    .await;
    let job = upload(
        &app,
        &url,
        &token,
        metadata.clone(),
        &files,
        StatusCode::ACCEPTED,
    )
    .await;
    let retry = upload(
        &app,
        &url,
        &token,
        metadata.clone(),
        &files,
        StatusCode::ACCEPTED,
    )
    .await;
    assert_eq!(retry["id"], job["id"]);
    assert_eq!(retry["reused"], true);
    let rows=format!("{head}p/copy,1073741824,,true,false,other,{hash},STD\nq/file,9,,true,false,etag,,STD\nq/unrelated-key,9,,true,false,different,,STD\nc/same,3,,true,false,2,{hash},STD\n");
    let peers = [("file", "other.csv", rows.into_bytes())];
    upload(
        &app,
        &format!("{}/inventories", path(org, peer)),
        &token,
        metadata.clone(),
        &peers,
        StatusCode::ACCEPTED,
    )
    .await;
    upload(
        &app,
        &format!("{}/inventories", path(other_org, foreign)),
        &other_token,
        metadata.clone(),
        &files,
        StatusCode::ACCEPTED,
    )
    .await;
    run_queue(&db).await;
    let detail = request(&app, Method::GET, &root, &token, None, StatusCode::OK).await;
    assert_eq!(detail["usage"]["object_count"], 3);
    assert_eq!(detail["imports"][0]["status"], "complete");
    let ops = format!("{root}/opportunities");
    let v = request(&app, Method::GET, &ops, &token, None, StatusCode::OK).await;
    let groups = v["groups"].as_array().unwrap();
    let proven = groups.iter().find(|x| x["kind"] == "verified").unwrap();
    assert_eq!(proven["copies"], 2);
    assert_eq!(proven["potential_bytes"], 1_073_741_824_i64);
    assert_eq!(proven["potential_monthly"].as_f64(), Some(0.5));
    assert!(groups
        .iter()
        .any(|g| g["kind"] == "etag" && g["potential_monthly"].is_null()));
    let size_only = groups.iter().find(|g| g["kind"] == "size").unwrap();
    assert_eq!(size_only["copies"], 3);
    assert!(size_only["potential_bytes"].is_null() && size_only["potential_monthly"].is_null());
    assert!(!groups
        .iter()
        .any(|g| g["kind"] == "name" && g["val"] == "same"));
    let bad = [("file", "invalid.csv", b"key,size\nwrong,9\n".to_vec())];
    upload(
        &app,
        &url,
        &token,
        metadata.clone(),
        &bad,
        StatusCode::CONFLICT,
    )
    .await;
    upload(
        &app,
        &url,
        &token,
        json!({"captured_at":"2025-02-03T00:00:00Z","prefix":"a/"}),
        &bad,
        StatusCode::ACCEPTED,
    )
    .await;
    run_queue(&db).await;
    let d = request(&app, Method::GET, &root, &token, None, StatusCode::OK).await;
    assert_eq!(d["imports"][0]["status"], "failed");
    assert_eq!(d["usage"]["object_count"], 3);
    // A newer empty prefix removes its keys. Reimporting an older full snapshot cannot resurrect them.
    upload(
        &app,
        &url,
        &token,
        json!({"captured_at":"2025-02-03T00:00:00Z","prefix":"a/"}),
        &[("file", "empty.csv", b"key,size\n".to_vec())],
        StatusCode::ACCEPTED,
    )
    .await;
    upload(
        &app,
        &url,
        &token,
        json!({"captured_at":"2025-01-01T00:00:00Z"}),
        &files,
        StatusCode::ACCEPTED,
    )
    .await;
    run_queue(&db).await;
    let d = request(&app, Method::GET, &root, &token, None, StatusCode::OK).await;
    assert_eq!(d["usage"]["object_count"], 2);
    let v = request(&app, Method::GET, &ops, &token, None, StatusCode::OK).await;
    assert!(!v["groups"]
        .as_array()
        .unwrap()
        .iter()
        .any(|x| x["kind"] == "verified"));
    // Native inventory: validate every compressed shard; provider ETags and algorithm-only fields stay weak.
    use md5::Digest;
    use std::io::Write;
    let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    gzip.write_all(b"reports-east,a%2Fhello,23,opaque,SHA256\n")
        .unwrap();
    let data = gzip.finish().unwrap();
    let manifest = json!({"sourceBucket":"reports-east","fileFormat":"CSV","creationTimestamp":"1740787200","fileSchema":"Bucket,Key,Size,ETag,ChecksumAlgorithm","files":[{"key":"data/p.csv.gz","size":data.len(),"MD5checksum":hex::encode(md5::Md5::digest(&data))}]});
    upload(
        &app,
        &url,
        &token,
        json!({"prefix":"a/"}),
        &[(
            "manifest",
            "manifest.json",
            manifest.to_string().into_bytes(),
        )],
        StatusCode::UNPROCESSABLE_ENTITY,
    )
    .await;
    upload(
        &app,
        &url,
        &token,
        json!({"prefix":"a/"}),
        &[
            (
                "manifest",
                "manifest.json",
                manifest.to_string().into_bytes(),
            ),
            ("file", "p.csv.gz", data),
        ],
        StatusCode::ACCEPTED,
    )
    .await;
    run_queue(&db).await;
    let row:(String,Option<String>)=sqlx::query_as("SELECT object_key,sha256 FROM storage_current_objects WHERE bucket_id=$1 AND object_key='a/hello'").bind(id).fetch_one(&db).await.unwrap();
    assert!(row.1.is_none());
    let (partial, _) = bucket(&db, org, a, "new-coverage").await;
    let partial_root = path(org, partial);
    let import_url = format!("{partial_root}/inventories");
    upload(
        &app,
        &import_url,
        &token,
        json!({"captured_at":"2025-04-01T00:00:00Z","prefix":"p/"}),
        &[("file", "keys.csv", b"key\np/a\np/nested/a\n".to_vec())],
        StatusCode::ACCEPTED,
    )
    .await;
    run_queue(&db).await;
    let usage = request(
        &app,
        Method::GET,
        &partial_root,
        &token,
        None,
        StatusCode::OK,
    )
    .await;
    assert_eq!(usage["usage"]["covered_objects"], 2);
    assert!(usage["usage"]["covered_bytes"].is_null());
    assert!(usage["usage"]["object_count"].is_null());
    assert!(usage["usage"]["size_bytes"].is_null());
    let clues = request(
        &app,
        Method::GET,
        &format!("{partial_root}/opportunities"),
        &token,
        None,
        StatusCode::OK,
    )
    .await;
    assert!(clues["groups"].as_array().unwrap().iter().any(|g| {
        g["kind"] == "name"
            && g["copies"] == 2
            && g["bytes"].is_null()
            && g["potential_monthly"].is_null()
    }));
    upload(
        &app,
        &import_url,
        &token,
        json!({"captured_at":"2025-04-02T00:00:00Z"}),
        &[("file", "empty.csv", b"key,size\n".to_vec())],
        StatusCode::ACCEPTED,
    )
    .await;
    run_queue(&db).await;
    let usage = request(
        &app,
        Method::GET,
        &partial_root,
        &token,
        None,
        StatusCode::OK,
    )
    .await;
    assert_eq!(usage["usage"]["object_count"], 0);
    assert_eq!(usage["usage"]["size_bytes"], 0);

    request(
        &app,
        Method::GET,
        &path(org, foreign),
        &token,
        None,
        StatusCode::NOT_FOUND,
    )
    .await;
}
