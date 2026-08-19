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
    let row = sqlx::query_as::<_, (String,)>(
        r#"SELECT r.name FROM organization_members om
           JOIN user_roles ur ON ur.user_id = om.user_id AND ur.organization_id = om.organization_id
           JOIN roles r ON r.id = ur.role_id
           WHERE om.organization_id = $1 AND om.user_id = $2
           ORDER BY r.name ASC LIMIT 1"#,
    )
    .bind(org_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;

    let role_level = match row {
        Some((ref role,)) if role.eq_ignore_ascii_case("owner") => 40,
        Some((ref role,)) if role.eq_ignore_ascii_case("admin") => 30,
        Some((ref role,))
            if role.eq_ignore_ascii_case("finops") || role.eq_ignore_ascii_case("cmdb_editor") =>
        {
            20
        }
        Some(_) => 10,
        None => {
            return Err(AppError::Forbidden(
                "Not a member of this organization".into(),
            ))
        }
    };

    if role_level < permission.required_role_level() {
        return Err(AppError::Forbidden("Insufficient permissions".into()));
    }
    Ok(())
}
