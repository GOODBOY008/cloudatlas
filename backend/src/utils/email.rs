//! SMTP delivery helper shared by webhook email channels, invite flows and
//! notifications. No-op (logged warning) when SMTP is not configured.

use crate::state::AppState;

/// Send a plain-text email. Returns `Ok(())` on success; logs and returns
/// `Err(())` when SMTP is unconfigured or the send fails.
pub async fn send_email(
    state: &AppState,
    to: &str,
    subject: &str,
    body: &str,
) -> Result<(), ()> {
    use lettre::message::{Mailbox, Message};
    use lettre::{SmtpTransport, Transport};

    let (Some(host), Some(from)) = (&state.config.smtp_host, &state.config.smtp_from) else {
        tracing::warn!(
            to = %to,
            subject = %subject,
            "email requested but SMTP_HOST/SMTP_FROM not configured — skipping"
        );
        return Err(());
    };

    let to_mb: Mailbox = to.parse().map_err(|e| {
        tracing::warn!(error = %e, "invalid email recipient");
    })?;
    let from_mb: Mailbox = from.parse().map_err(|e| {
        tracing::warn!(error = %e, "invalid SMTP_FROM address");
    })?;

    let email = Message::builder()
        .from(from_mb)
        .to(to_mb)
        .subject(subject)
        .header(lettre::message::header::ContentType::TEXT_PLAIN)
        .body(body.to_string())
        .map_err(|e| {
            tracing::warn!(error = %e, "email build failed");
        })?;

    let mailer = if let (Some(user), Some(pass)) = (&state.config.smtp_username, &state.config.smtp_password) {
        SmtpTransport::relay(host)
            .map_err(|e| tracing::warn!(error = %e, "SMTP relay init failed"))?
            .port(state.config.smtp_port)
            .credentials(lettre::transport::smtp::authentication::Credentials::new(
                user.clone(),
                pass.clone(),
            ))
            .build()
    } else {
        SmtpTransport::relay(host)
            .map_err(|e| tracing::warn!(error = %e, "SMTP relay init failed"))?
            .port(state.config.smtp_port)
            .build()
    };

    match mailer.send(&email) {
        Ok(_) => Ok(()),
        Err(e) => {
            tracing::warn!(error = %e, to = %to, "email send failed");
            Err(())
        }
    }
}
