CREATE TABLE oidc_login_transactions (
    state_hash           TEXT PRIMARY KEY,
    browser_binding_hash TEXT NOT NULL,
    code_verifier        TEXT NOT NULL,
    expires_at           TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_oidc_login_transactions_expires ON oidc_login_transactions(expires_at);
