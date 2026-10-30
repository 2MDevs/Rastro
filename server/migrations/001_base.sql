-- RASTRO — estrutura inicial: pessoas, acesso, segurança, auditoria e configurações.
-- Cada arquivo desta pasta roda uma única vez, em ordem, dentro de uma transação.

CREATE TABLE users (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  email                 TEXT NOT NULL,
  phone                 TEXT,
  role                  TEXT NOT NULL CHECK (role IN ('DEVELOPER','ADMIN','DIRECTOR','COORDINATOR','STORE_MANAGER','PROMOTER')),
  status                TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','BLOCKED')),
  password_hash         TEXT,
  must_change_password  BOOLEAN NOT NULL DEFAULT false,
  failed_login_attempts INT NOT NULL DEFAULT 0,
  locked_until          TIMESTAMPTZ,
  pin_hash              TEXT,
  pin_failed_attempts   INT NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at         TIMESTAMPTZ
);
CREATE UNIQUE INDEX users_email_uq ON users (LOWER(email));

-- Desafio de 2FA por e-mail (só o hash do código fica guardado)
CREATE TABLE login_challenges (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  code_hash     TEXT,
  attempts      INT NOT NULL DEFAULT 0,
  last_sent_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ,
  first_access  BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX login_challenges_user_idx ON login_challenges (user_id);

-- Dispositivos de acesso (navegadores/celulares que entram no sistema)
CREATE TABLE auth_devices (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  os                TEXT NOT NULL,
  browser           TEXT NOT NULL,
  device_type       TEXT NOT NULL DEFAULT 'desktop',
  ip                TEXT NOT NULL,
  token_hash        TEXT UNIQUE,
  status            TEXT NOT NULL DEFAULT 'TRUSTED' CHECK (status IN ('TRUSTED','PENDING','BLOCKED','REVOKED')),
  trusted_until     TIMESTAMPTZ,
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX auth_devices_user_idx ON auth_devices (user_id);

CREATE TABLE sessions (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id      TEXT REFERENCES auth_devices(id) ON DELETE SET NULL,
  token_hash     TEXT NOT NULL UNIQUE,
  ip             TEXT,
  user_agent     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL,
  locked_at      TIMESTAMPTZ,
  reauth_at      TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE password_resets (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  purpose     TEXT NOT NULL DEFAULT 'reset' CHECK (purpose IN ('reset','invite')),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Configurações (Banco > .env > padrão). Segredos ficam criptografados com AES-256-GCM.
CREATE TABLE system_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  is_secret   BOOLEAN NOT NULL DEFAULT false,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  TEXT
);

-- Auditoria imutável, encadeada por SHA-256
CREATE TABLE audit_logs (
  seq            BIGSERIAL PRIMARY KEY,
  id             TEXT NOT NULL UNIQUE,
  occurred_at    TIMESTAMPTZ NOT NULL,
  user_id        TEXT,
  user_name      TEXT NOT NULL,
  role           TEXT NOT NULL,
  scope          TEXT NOT NULL,
  action         TEXT NOT NULL,
  target_type    TEXT,
  target_id      TEXT,
  target_name    TEXT,
  details        TEXT NOT NULL DEFAULT '',
  result         TEXT NOT NULL CHECK (result IN ('SUCCESS','DENIED','BLOCKED','FAILURE')),
  ip             TEXT NOT NULL,
  device         TEXT NOT NULL,
  prev_hash      TEXT NOT NULL,
  hash           TEXT NOT NULL
);
CREATE INDEX audit_logs_time_idx ON audit_logs (occurred_at DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (action);

-- Ninguém altera nem apaga registros de auditoria, nem pelo banco sem desligar esta proteção
CREATE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Registros de auditoria não podem ser alterados nem apagados.';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_immutable();

-- Chaves de API (só o hash) e webhooks
CREATE TABLE api_keys (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  key_prefix     TEXT NOT NULL,
  key_hash       TEXT NOT NULL UNIQUE,
  scopes         TEXT[] NOT NULL DEFAULT '{}',
  created_by     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at   TIMESTAMPTZ,
  last_used_ip   TEXT,
  revoked_at     TIMESTAMPTZ
);

CREATE TABLE webhooks (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  url               TEXT NOT NULL CHECK (url LIKE 'https://%'),
  events            TEXT[] NOT NULL DEFAULT '{}',
  secret_encrypted  TEXT NOT NULL,
  active            BOOLEAN NOT NULL DEFAULT true,
  created_by        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_delivery_at  TIMESTAMPTZ,
  last_status       TEXT,
  last_error        TEXT
);
