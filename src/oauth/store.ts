import { getDb } from "../sqlite.js";

// ----------------------------------------------------------------------
// Clients (DCR — RFC 7591)
// ----------------------------------------------------------------------

export interface OAuthClient {
  client_id: string;
  client_secret: string | null;
  redirect_uris: string[];
  client_name: string | null;
}

export function insertClient(c: OAuthClient): void {
  getDb()
    .prepare(
      `INSERT INTO oauth_clients (client_id, client_secret, redirect_uris, client_name)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      c.client_id,
      c.client_secret,
      JSON.stringify(c.redirect_uris),
      c.client_name,
    );
}

export function getClient(client_id: string): OAuthClient | null {
  const row = getDb()
    .prepare(
      `SELECT client_id, client_secret, redirect_uris, client_name
       FROM oauth_clients WHERE client_id = ?`,
    )
    .get(client_id) as
    | {
        client_id: string;
        client_secret: string | null;
        redirect_uris: string;
        client_name: string | null;
      }
    | undefined;
  if (!row) return null;
  return { ...row, redirect_uris: JSON.parse(row.redirect_uris) };
}

// ----------------------------------------------------------------------
// /authorize transactions (estado state Google <-> params do cliente)
// ----------------------------------------------------------------------

export interface AuthorizeTx {
  state: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string | null;
  client_state: string | null;
}

export function insertAuthorizeTx(tx: AuthorizeTx, ttlSeconds: number): void {
  const expires = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  getDb()
    .prepare(
      `INSERT INTO oauth_authorize_tx
         (state, client_id, redirect_uri, code_challenge, code_challenge_method,
          scope, client_state, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      tx.state,
      tx.client_id,
      tx.redirect_uri,
      tx.code_challenge,
      tx.code_challenge_method,
      tx.scope,
      tx.client_state,
      expires,
    );
}

// Single-use: deleta na leitura. Retorna null se expirou ou nao existe.
export function consumeAuthorizeTx(state: string): AuthorizeTx | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT state, client_id, redirect_uri, code_challenge, code_challenge_method,
              scope, client_state, expires_at
       FROM oauth_authorize_tx WHERE state = ?`,
    )
    .get(state) as
    | (AuthorizeTx & { expires_at: string })
    | undefined;
  if (!row) return null;
  db.prepare(`DELETE FROM oauth_authorize_tx WHERE state = ?`).run(state);
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  const { expires_at, ...rest } = row;
  return rest;
}

// ----------------------------------------------------------------------
// Authorization codes (single-use, ~60s)
// ----------------------------------------------------------------------

export interface AuthCode {
  code: string;
  client_id: string;
  user_email: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string | null;
}

export function insertCode(c: AuthCode, ttlSeconds: number): void {
  const expires = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  getDb()
    .prepare(
      `INSERT INTO oauth_codes
         (code, client_id, user_email, redirect_uri,
          code_challenge, code_challenge_method, scope, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      c.code,
      c.client_id,
      c.user_email,
      c.redirect_uri,
      c.code_challenge,
      c.code_challenge_method,
      c.scope,
      expires,
    );
}

// Marca como usado atomicamente. Retorna a linha se valida, ou null.
export function consumeCode(code: string): AuthCode | null {
  const db = getDb();
  const txn = db.transaction((c: string): AuthCode | null => {
    const row = db
      .prepare(
        `SELECT code, client_id, user_email, redirect_uri,
                code_challenge, code_challenge_method, scope, expires_at, used
         FROM oauth_codes WHERE code = ?`,
      )
      .get(c) as
      | (AuthCode & { expires_at: string; used: number })
      | undefined;
    if (!row) return null;
    if (row.used) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) return null;
    db.prepare(`UPDATE oauth_codes SET used = 1 WHERE code = ?`).run(c);
    const { expires_at, used, ...rest } = row;
    return rest;
  });
  return txn(code);
}

// ----------------------------------------------------------------------
// Refresh tokens (opacos, longa duracao, revogaveis)
// ----------------------------------------------------------------------

export interface RefreshToken {
  token: string;
  client_id: string;
  user_email: string;
}

export function insertRefreshToken(rt: RefreshToken, ttlSeconds: number): void {
  const expires = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  getDb()
    .prepare(
      `INSERT INTO oauth_refresh_tokens (token, client_id, user_email, expires_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(rt.token, rt.client_id, rt.user_email, expires);
}

export function getActiveRefreshToken(token: string): RefreshToken | null {
  const row = getDb()
    .prepare(
      `SELECT token, client_id, user_email, expires_at, revoked_at
       FROM oauth_refresh_tokens WHERE token = ?`,
    )
    .get(token) as
    | {
        token: string;
        client_id: string;
        user_email: string;
        expires_at: string;
        revoked_at: string | null;
      }
    | undefined;
  if (!row) return null;
  if (row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return {
    token: row.token,
    client_id: row.client_id,
    user_email: row.user_email,
  };
}

export function revokeRefreshToken(token: string): void {
  getDb()
    .prepare(
      `UPDATE oauth_refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE token = ?`,
    )
    .run(token);
}
