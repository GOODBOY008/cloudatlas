use crate::error::{AppError, AppResult};
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq)]
pub enum Permission {
    ViewExpenses,
    ManagePools,
    ManageCloudAccounts,
    ManageCmdb,
    ManageRules,
    ManageWebhooks,
    AdminOrg,
}

impl Permission {
    pub fn required_role_level(&self) -> i32 {
        match self {
            Permission::ViewExpenses => 10,
            Permission::ManagePools => 20,
            Permission::ManageCloudAccounts => 20,
            Permission::ManageCmdb => 20,
            Permission::ManageRules => 20,
            Permission::ManageWebhooks => 30,
            Permission::AdminOrg => 40,
        }
    }
}

pub async fn require_permission(
    db: &PgPool,
    user_id: Uuid,
    org_id: Uuid,
    permission: Permission,
) -> AppResult<()> {
    let roles = sqlx::query_scalar::<_, String>(
        r#"SELECT r.name FROM organization_members om
           JOIN user_roles ur ON ur.user_id=om.user_id AND ur.organization_id=om.organization_id
           JOIN roles r ON r.id=ur.role_id AND (r.organization_id=om.organization_id OR r.organization_id IS NULL)
           WHERE om.organization_id=$1 AND om.user_id=$2"#,
    ).bind(org_id).bind(user_id).fetch_all(db).await?;
    if roles.is_empty() {
        return Err(AppError::Forbidden("No role in this environment".into()));
    }
    let allowed = roles.iter().any(|role| {
        let level = match role.to_ascii_lowercase().as_str() {
            "owner" => 40,
            "admin" => 30,
            "finops" => 20,
            "cmdb editor" | "cmdb_editor" if permission == Permission::ManageCmdb => 20,
            _ => 10,
        };
        level >= permission.required_role_level()
    });
    if !allowed {
        return Err(AppError::Forbidden("Insufficient permissions".into()));
    }
    Ok(())
}
