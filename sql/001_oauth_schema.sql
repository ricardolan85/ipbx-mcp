-- Schema OAuth + audit log para mcp-base (SQLite)
--
-- Engine: SQLite. Arquivo apontado por SQLITE_PATH no .env (default
-- ./data/app.db local, /data/app.db em prod via volume Docker).
--
-- Aplicar:
--   sqlite3 $SQLITE_PATH < sql/001_oauth_schema.sql
--
-- IMPORTANTE: o servidor deve setar `PRAGMA foreign_keys = ON;` na
-- abertura da conexao - sem isso, SQLite ignora FK silenciosamente.

PRAGMA journal_mode = WAL;       -- melhor concorrencia leitor/escritor
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------
-- Clientes registrados via Dynamic Client Registration (RFC 7591)
-- ---------------------------------------------------------------
-- Cada cliente MCP (claude.ai, Desktop, CLI, etc.) se auto-registra
-- na primeira conexao. client_secret e NULL para clientes publicos
-- que usam PKCE (padrao da spec MCP).
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id      TEXT     NOT NULL PRIMARY KEY,
  client_secret  TEXT     NULL,
  redirect_uris  TEXT     NOT NULL,   -- JSON array, valida na aplicacao
  client_name    TEXT     NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------
-- Authorization codes (curta duracao, ~60s, single-use)
-- ---------------------------------------------------------------
-- Emitidos no /authorize apos o usuario logar no Google. Trocados
-- por access/refresh tokens no /token. Marca `used = 1` apos a
-- primeira troca para evitar replay.
CREATE TABLE IF NOT EXISTS oauth_codes (
  code                  TEXT     NOT NULL PRIMARY KEY,
  client_id             TEXT     NOT NULL,
  user_email            TEXT     NOT NULL,
  redirect_uri          TEXT     NOT NULL,
  code_challenge        TEXT     NOT NULL,
  code_challenge_method TEXT     NOT NULL DEFAULT 'S256'
                                 CHECK (code_challenge_method = 'S256'),
  scope                 TEXT     NULL,
  expires_at            DATETIME NOT NULL,
  used                  INTEGER  NOT NULL DEFAULT 0
                                 CHECK (used IN (0, 1)),
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires ON oauth_codes(expires_at);

-- ---------------------------------------------------------------
-- Refresh tokens (longa duracao, revogaveis)
-- ---------------------------------------------------------------
-- Trocados por novos access tokens no /token. Access tokens em si
-- (JWTs) NAO ficam no banco - sao stateless, validados por assinatura.
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  token       TEXT     NOT NULL PRIMARY KEY,
  client_id   TEXT     NOT NULL,
  user_email  TEXT     NOT NULL,
  expires_at  DATETIME NOT NULL,
  revoked_at  DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_refresh_user    ON oauth_refresh_tokens(user_email);
CREATE INDEX IF NOT EXISTS idx_refresh_expires ON oauth_refresh_tokens(expires_at);

-- ---------------------------------------------------------------
-- Audit log de chamadas de tool
-- ---------------------------------------------------------------
-- Uma linha por chamada de tool em /mcp. auth_kind='service' com
-- user_email='service:static' indica chamada via MCP_AUTH_TOKEN.
CREATE TABLE IF NOT EXISTS audit_log (
  id              INTEGER  PRIMARY KEY AUTOINCREMENT,
  user_email      TEXT     NULL,
  auth_kind       TEXT     NOT NULL CHECK (auth_kind IN ('user', 'service')),
  client_id       TEXT     NULL,
  tool            TEXT     NOT NULL,
  args_json       TEXT     NOT NULL,    -- JSON, valida na aplicacao
  result_ok       INTEGER  NOT NULL CHECK (result_ok IN (0, 1)),
  error_message   TEXT     NULL,
  duration_ms     INTEGER  NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_user_time ON audit_log(user_email, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_time      ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_tool_time ON audit_log(tool, created_at);
