//! Invitation redemption regressions against disposable PostgreSQL state.
//! Set TEST_DATABASE_URL (and DATABASE_URL/JWT_SECRET for Config) explicitly.

use axum::{extract::State, Extension, Json};
use cloudatlas_lib::{
    config::Config,
    modules::auth::{
        org_handlers::{accept_invite, AcceptInviteRequest},
        service::Claims,
    },
    state::AppState,
    AppError, AppResult,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

struct Fixture {
    state: AppState,
    org: Uuid,
    user: Uuid,
    other_user: Uuid,
    invite: Uuid,
    member_role: Uuid,
    owner_role: Uuid,
    token: String,
}

impl Fixture {
    async fn new() -> Option<Self> {
        let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
            eprintln!("SKIP: set TEST_DATABASE_URL to a disposable DB for invitation regressions");
            return None;
        };
        let db = sqlx::PgPool::connect(&url).await.expect("test database");
        sqlx::migrate!("./migrations")
            .run(&db)
            .await
            .expect("migrations");
        let state = AppState::new(db, Config::from_env().expect("test config"));
        let org = sqlx::query_scalar::<_, Uuid>(
            "INSERT INTO organizations (name, slug) VALUES ('Invitation test', $1) RETURNING id",
        )
        .bind(Uuid::new_v4().to_string())
        .fetch_one(&state.db)
        .await
        .unwrap();
        let email = format!("Recipient-{}@example.test", Uuid::new_v4());
        let mut users = Vec::new();
        for email in [&email, &format!("other-{}@example.test", Uuid::new_v4())] {
            users.push(sqlx::query_scalar::<_, Uuid>(
                "INSERT INTO users (email, display_name, password_hash) VALUES ($1, 'Test', 'not-a-password') RETURNING id",
            ).bind(email).fetch_one(&state.db).await.unwrap());
        }
        let mut roles = Vec::new();
        for name in ["Member", "Owner"] {
            roles.push(
                sqlx::query_scalar::<_, Uuid>(
                    "INSERT INTO roles (organization_id, name) VALUES ($1, $2) RETURNING id",
                )
                .bind(org)
                .bind(name)
                .fetch_one(&state.db)
                .await
                .unwrap(),
            );
        }
        let token = Uuid::new_v4().to_string();
        let token_hash = hex::encode(Sha256::digest(token.as_bytes()));
        let invite = sqlx::query_scalar::<_, Uuid>(
            "INSERT INTO invites (organization_id, email, role_name, token_hash, expires_at)
             VALUES ($1, $2, 'member', $3, NOW() + INTERVAL '1 day') RETURNING id",
        )
        .bind(org)
        .bind(email.to_uppercase())
        .bind(token_hash)
        .fetch_one(&state.db)
        .await
        .unwrap();
        Some(Self {
            state,
            org,
            user: users[0],
            other_user: users[1],
            invite,
            member_role: roles[0],
            owner_role: roles[1],
            token,
        })
    }

    async fn accept(&self, user: Uuid) -> AppResult<Json<Value>> {
        // Deliberately stale/unrelated claim email: authorization must use the
        // current users table record, not this cached field or request data.
        accept_invite(
            State(self.state.clone()),
            Extension(Claims::new_access(user, "untrusted-claim@example.test", 60)),
            Json(AcceptInviteRequest {
                token: self.token.clone(),
            }),
        )
        .await
    }

    async fn status(&self) -> String {
        sqlx::query_scalar("SELECT status FROM invites WHERE id = $1")
            .bind(self.invite)
            .fetch_one(&self.state.db)
            .await
            .unwrap()
    }

    async fn member_count(&self) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM organization_members WHERE organization_id = $1")
            .bind(self.org)
            .fetch_one(&self.state.db)
            .await
            .unwrap()
    }

    async fn roles(&self) -> Vec<Uuid> {
        sqlx::query_scalar(
            "SELECT role_id FROM user_roles WHERE organization_id = $1 AND user_id = $2",
        )
        .bind(self.org)
        .bind(self.user)
        .fetch_all(&self.state.db)
        .await
        .unwrap()
    }

    async fn cleanup(self) {
        sqlx::query("DELETE FROM organizations WHERE id = $1")
            .bind(self.org)
            .execute(&self.state.db)
            .await
            .unwrap();
        sqlx::query("DELETE FROM users WHERE id = ANY($1)")
            .bind(vec![self.user, self.other_user])
            .execute(&self.state.db)
            .await
            .unwrap();
        self.state.db.close().await;
    }
}

#[tokio::test]
async fn invite_is_bound_to_current_account_email_and_consumed_once() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    assert!(matches!(
        f.accept(f.other_user).await,
        Err(AppError::Forbidden(_))
    ));
    assert_eq!(f.status().await, "pending");
    assert_eq!(f.member_count().await, 0);

    // Simulate roles left behind after this user was previously removed.
    sqlx::query("INSERT INTO user_roles (user_id, role_id, organization_id) VALUES ($1, $2, $3)")
        .bind(f.user)
        .bind(f.owner_role)
        .bind(f.org)
        .execute(&f.state.db)
        .await
        .unwrap();
    let accepted = f.accept(f.user).await.expect("matching email redeems");
    assert_eq!(accepted.0["data"]["organization_id"], f.org.to_string());
    assert_eq!(f.status().await, "accepted");
    assert_eq!(f.member_count().await, 1);
    assert_eq!(
        f.roles().await,
        vec![f.member_role],
        "old elevated roles must not return"
    );

    sqlx::query("DELETE FROM organization_members WHERE organization_id = $1")
        .bind(f.org)
        .execute(&f.state.db)
        .await
        .unwrap();
    sqlx::query("DELETE FROM user_roles WHERE organization_id = $1")
        .bind(f.org)
        .execute(&f.state.db)
        .await
        .unwrap();
    assert!(matches!(
        f.accept(f.user).await,
        Err(AppError::Validation(_))
    ));
    assert_eq!(
        f.member_count().await,
        0,
        "used token cannot restore membership"
    );
    assert!(f.roles().await.is_empty());
    f.cleanup().await;
}

#[tokio::test]
async fn revoked_expired_and_consumed_invites_cannot_grant_membership() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    for (status, seconds) in [("declined", 60i64), ("accepted", 60), ("pending", -60)] {
        sqlx::query("UPDATE invites SET status = $2, expires_at = NOW() + $3 * INTERVAL '1 second' WHERE id = $1")
            .bind(f.invite).bind(status).bind(seconds).execute(&f.state.db).await.unwrap();
        assert!(matches!(
            f.accept(f.user).await,
            Err(AppError::Validation(_))
        ));
        assert_eq!(f.member_count().await, 0);
        assert!(f.roles().await.is_empty());
        assert_eq!(f.status().await, status);
    }
    f.cleanup().await;
}

#[tokio::test]
async fn concurrent_redemption_commits_exactly_once() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let (first, second) = tokio::join!(f.accept(f.user), f.accept(f.user));
    assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
    let failure = if first.is_err() { first } else { second };
    assert!(matches!(failure, Err(AppError::Validation(_))));
    assert_eq!(f.status().await, "accepted");
    assert_eq!(f.member_count().await, 1);
    assert_eq!(f.roles().await, vec![f.member_role]);
    f.cleanup().await;
}

#[tokio::test]
async fn missing_role_or_failed_role_write_leaves_invitation_and_membership_unchanged() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    sqlx::query("UPDATE invites SET role_name = 'Removed role' WHERE id = $1")
        .bind(f.invite)
        .execute(&f.state.db)
        .await
        .unwrap();
    assert!(matches!(
        f.accept(f.user).await,
        Err(AppError::Validation(_))
    ));
    assert_eq!(f.status().await, "pending");
    assert_eq!(f.member_count().await, 0);

    sqlx::query("UPDATE invites SET role_name = 'Member' WHERE id = $1")
        .bind(f.invite)
        .execute(&f.state.db)
        .await
        .unwrap();
    // Force a real database failure after the member insert to verify rollback.
    // Identifiers/values are generated UUIDs; this affects only this fixture.
    let constraint = format!("invite_test_{}", Uuid::new_v4().simple());
    let add = format!(
        "ALTER TABLE user_roles ADD CONSTRAINT {constraint} CHECK (user_id <> '{}')",
        f.user
    );
    sqlx::query(sqlx::AssertSqlSafe(add.as_str()))
        .execute(&f.state.db)
        .await
        .unwrap();
    assert!(matches!(f.accept(f.user).await, Err(AppError::Database(_))));
    assert_eq!(f.status().await, "pending");
    assert_eq!(
        f.member_count().await,
        0,
        "failed grant rolls back member insertion"
    );
    assert!(f.roles().await.is_empty());
    let drop = format!("ALTER TABLE user_roles DROP CONSTRAINT {constraint}");
    sqlx::query(sqlx::AssertSqlSafe(drop.as_str()))
        .execute(&f.state.db)
        .await
        .unwrap();
    let _ = f
        .accept(f.user)
        .await
        .expect("failed attempt did not consume token");
    f.cleanup().await;
}

#[tokio::test]
async fn waiting_for_an_invitation_lock_does_not_extend_token_expiry() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let mut tx = f.state.db.begin().await.unwrap();
    sqlx::query(
        "UPDATE invites SET expires_at = clock_timestamp() + INTERVAL '0.1 second' WHERE id = $1",
    )
    .bind(f.invite)
    .execute(tx.as_mut())
    .await
    .unwrap();
    let state = f.state.clone();
    let user = f.user;
    let token = f.token.clone();
    let redemption = tokio::spawn(async move {
        accept_invite(
            State(state),
            Extension(Claims::new_access(user, "unused@example.test", 60)),
            Json(AcceptInviteRequest { token }),
        )
        .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    tx.commit().await.unwrap();
    assert!(matches!(
        redemption.await.unwrap(),
        Err(AppError::Validation(_))
    ));
    assert_eq!(f.status().await, "pending");
    assert_eq!(f.member_count().await, 0);
    assert!(f.roles().await.is_empty());
    f.cleanup().await;
}

#[tokio::test]
async fn existing_members_keep_their_current_roles() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    sqlx::query("INSERT INTO organization_members (organization_id, user_id) VALUES ($1, $2)")
        .bind(f.org)
        .bind(f.user)
        .execute(&f.state.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO user_roles (user_id, role_id, organization_id) VALUES ($1, $2, $3)")
        .bind(f.user)
        .bind(f.member_role)
        .bind(f.org)
        .execute(&f.state.db)
        .await
        .unwrap();
    sqlx::query("UPDATE invites SET role_name = 'Owner' WHERE id = $1")
        .bind(f.invite)
        .execute(&f.state.db)
        .await
        .unwrap();
    assert!(matches!(f.accept(f.user).await, Err(AppError::Conflict(_))));
    assert_eq!(f.roles().await, vec![f.member_role]);
    assert_eq!(f.status().await, "pending");
    f.cleanup().await;
}
