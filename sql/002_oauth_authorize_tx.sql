-- Transacoes de /authorize em transito (state Google <-> params do cliente)
--
-- Cada chamada GET /authorize cria uma linha aqui, identificada por
-- um state opaco que vai pro Google. Quando o usuario volta no
-- /oauth/google/callback, recuperamos essa linha pra saber:
--   - qual client_id pediu (e qual redirect_uri usar pra responder)
--   - o code_challenge PKCE original
--   - o state original do cliente (que precisa ecoar de volta)
--
-- TTL curto (~10 min): o usuario pode demorar no login Google, mas
-- nao deve ficar dias com a tx aberta. Single-use: a linha some
-- assim que o callback consome.

CREATE TABLE IF NOT EXISTS oauth_authorize_tx (
  state                 TEXT     NOT NULL PRIMARY KEY,
  client_id             TEXT     NOT NULL,
  redirect_uri          TEXT     NOT NULL,
  code_challenge        TEXT     NOT NULL,
  code_challenge_method TEXT     NOT NULL DEFAULT 'S256'
                                 CHECK (code_challenge_method = 'S256'),
  scope                 TEXT     NULL,
  client_state          TEXT     NULL,
  expires_at            DATETIME NOT NULL,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_authorize_tx_expires ON oauth_authorize_tx(expires_at);
