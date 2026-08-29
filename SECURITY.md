# Security Policy

CloudAtlas holds your cloud account credentials (encrypted at rest with AES-256-GCM) and your billing data. We treat security reports with priority.

## Supported Versions

The project is pre-1.0 and moving quickly; security fixes land on `main` and ship in the next tagged release.

| Version | Supported |
|---------|-----------|
| `main` (dev) | ✅ fixes land here first |
| latest `v*` tag | ✅ |
| older tags | ❌ — upgrade to the latest release |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security problems.**

Report privately via **GitHub Security Advisories**:

1. Go to the [Security tab](https://github.com/GOODBOY008/cloudatlas/security/advisories) of the repository
2. Click **Report a vulnerability**
3. Describe the issue, affected component (`backend/` Rust API, `frontend/` SPA, Helm chart, or Docker setup), reproduction steps, and impact

You should get a first response within **72 hours**. Please give us **90 days** to address the issue before public disclosure; we'll credit you in the advisory unless you prefer to stay anonymous.

### Scope

In scope:

- Authentication / authorization bypasses (JWT handling, RBAC, org tenant isolation)
- SQL injection, XSS, SSRF, path traversal
- Cloud credential handling (encryption, logging, exposure)
- Container / Helm chart misconfigurations that lead to exposure

Out of scope:

- Vulnerabilities in dependencies already fixed in a newer version (run `cargo audit` / `npm audit` — Dependabot covers both)
- Self-inflicted issues from disabling auth, using default `.env` values in production, or exposing the API publicly without TLS
- Missing rate limits on endpoints behind authenticated access

## Hardening Notes for Operators

- Set strong `JWT_SECRET` and `ENCRYPTION_KEY` (`make gen-secret`); never run production with `.env.example` defaults
- Restrict `CORS_ALLOWED_ORIGINS` to your own domains
- Terminate TLS in front of the API (nginx / ingress)
- Keep `CLOUD_MOCK_ENABLED` off in production
- See [docs/production-checklist.md](docs/production-checklist.md) for the full list
