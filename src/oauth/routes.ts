import express, { type Express, type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  insertClient,
  getClient,
  insertAuthorizeTx,
  consumeAuthorizeTx,
  insertCode,
  consumeCode,
  insertRefreshToken,
  getActiveRefreshToken,
  revokeRefreshToken,
} from "./store.js";
import { verifyPkceS256 } from "./pkce.js";
import { buildGoogleAuthorizeUrl, exchangeGoogleCode } from "./google.js";
import { signAccessToken, ACCESS_TTL_SECONDS } from "../auth/jwt.js";

// TTLs em segundos
const AUTHORIZE_TX_TTL = 10 * 60;       // 10 min — login Google pode demorar
const CODE_TTL = 60;                    // 60s — troca por token logo apos
const REFRESH_TTL = 90 * 24 * 60 * 60;  // 90 dias

function issuerUrl(): string {
  const v = process.env.OAUTH_ISSUER;
  if (!v) throw new Error("OAUTH_ISSUER nao definido");
  return v.replace(/\/$/, "");
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function cors(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function oauthError(
  res: Response,
  status: number,
  error: string,
  description?: string,
): void {
  cors(res);
  res.status(status).json({
    error,
    ...(description ? { error_description: description } : {}),
  });
}

// --------------------------- Zod schemas ---------------------------

const RegisterReq = z.object({
  redirect_uris: z.array(z.string().url()).min(1).max(10),
  client_name: z.string().max(200).optional(),
});

const AuthorizeReq = z.object({
  response_type: z.literal("code"),
  client_id: z.string(),
  redirect_uri: z.string().url(),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal("S256"),
  scope: z.string().optional(),
  state: z.string().optional(),
});

const TokenAuthzCodeReq = z.object({
  grant_type: z.literal("authorization_code"),
  code: z.string(),
  redirect_uri: z.string().url(),
  client_id: z.string(),
  code_verifier: z.string().min(43).max(128),
});

const TokenRefreshReq = z.object({
  grant_type: z.literal("refresh_token"),
  refresh_token: z.string(),
  client_id: z.string(),
});

// --------------------------- Routes ---------------------------

export function registerOAuthRoutes(app: Express): void {
  // CORS preflight para todos os endpoints OAuth chamados por browser.
  app.options(
    [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource",
      "/register",
      "/token",
    ],
    (_req, res) => {
      cors(res);
      res.status(204).end();
    },
  );

  // ---- Discovery: RFC 8414 ----
  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    cors(res);
    const base = issuerUrl();
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    });
  });

  // ---- Discovery: RFC 9728 (Protected Resource Metadata) ----
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    cors(res);
    const base = issuerUrl();
    res.json({
      resource: base,
      authorization_servers: [base],
      bearer_methods_supported: ["header"],
    });
  });

  // ---- Dynamic Client Registration: RFC 7591 ----
  // Publico, sem auth — clientes MCP se registram na primeira conexao.
  app.post("/register", (req, res) => {
    const parsed = RegisterReq.safeParse(req.body);
    if (!parsed.success) {
      return oauthError(
        res,
        400,
        "invalid_client_metadata",
        parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      );
    }
    const client_id = `mcp-${randomToken(16)}`;
    const issuedAt = Math.floor(Date.now() / 1000);
    insertClient({
      client_id,
      client_secret: null,
      redirect_uris: parsed.data.redirect_uris,
      client_name: parsed.data.client_name ?? null,
    });
    cors(res);
    res.status(201).json({
      client_id,
      client_id_issued_at: issuedAt,
      redirect_uris: parsed.data.redirect_uris,
      client_name: parsed.data.client_name ?? null,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  // ---- /authorize: redireciona pro Google ----
  app.get("/authorize", (req, res) => {
    const parsed = AuthorizeReq.safeParse(req.query);
    if (!parsed.success) {
      return oauthError(
        res,
        400,
        "invalid_request",
        parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      );
    }
    const {
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      scope,
      state,
    } = parsed.data;
    const client = getClient(client_id);
    if (!client) {
      return oauthError(res, 400, "invalid_client", "client_id desconhecido");
    }
    if (!client.redirect_uris.includes(redirect_uri)) {
      return oauthError(res, 400, "invalid_request", "redirect_uri nao registrada");
    }
    const googleState = randomToken(24);
    insertAuthorizeTx(
      {
        state: googleState,
        client_id,
        redirect_uri,
        code_challenge,
        code_challenge_method,
        scope: scope ?? null,
        client_state: state ?? null,
      },
      AUTHORIZE_TX_TTL,
    );
    res.redirect(302, buildGoogleAuthorizeUrl(googleState));
  });

  // ---- /oauth/google/callback: Google volta pra ca ----
  app.get("/oauth/google/callback", async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const errorParam =
      typeof req.query.error === "string" ? req.query.error : "";
    if (errorParam) {
      return res
        .status(400)
        .type("text/plain")
        .send(`Google retornou erro: ${errorParam}`);
    }
    if (!code || !state) {
      return res
        .status(400)
        .type("text/plain")
        .send("Parametros code/state ausentes.");
    }
    const tx = consumeAuthorizeTx(state);
    if (!tx) {
      return res
        .status(400)
        .type("text/plain")
        .send("Transacao /authorize expirada ou desconhecida.");
    }

    let identity;
    try {
      identity = await exchangeGoogleCode(code);
    } catch (err) {
      console.error("Falha ao trocar code Google:", err);
      return res
        .status(502)
        .type("text/plain")
        .send("Falha ao validar login Google.");
    }

    // Defesa em profundidade: mesmo com OAuth consent screen Internal,
    // validamos o claim hd antes de emitir nosso codigo.
    const allowedHd = process.env.ALLOWED_GOOGLE_HD;
    if (allowedHd && identity.hd !== allowedHd) {
      console.error(
        `Login rejeitado: email=${identity.email} hd=${identity.hd ?? "<vazio>"}`,
      );
      return res
        .status(403)
        .type("text/plain")
        .send(`Acesso restrito a contas @${allowedHd}.`);
    }
    if (!identity.email_verified) {
      return res
        .status(403)
        .type("text/plain")
        .send("Email Google nao verificado.");
    }

    const ourCode = randomToken(32);
    insertCode(
      {
        code: ourCode,
        client_id: tx.client_id,
        user_email: identity.email,
        redirect_uri: tx.redirect_uri,
        code_challenge: tx.code_challenge,
        code_challenge_method: tx.code_challenge_method,
        scope: tx.scope,
      },
      CODE_TTL,
    );
    const target = new URL(tx.redirect_uri);
    target.searchParams.set("code", ourCode);
    if (tx.client_state) target.searchParams.set("state", tx.client_state);
    res.redirect(302, target.toString());
  });

  // ---- /token: troca code / refresh por access token ----
  app.post(
    "/token",
    express.urlencoded({ extended: false }),
    async (req, res) => {
      const grantType = req.body?.grant_type;
      if (grantType === "authorization_code") {
        return handleAuthCodeGrant(req, res);
      }
      if (grantType === "refresh_token") {
        return handleRefreshGrant(req, res);
      }
      return oauthError(res, 400, "unsupported_grant_type");
    },
  );
}

async function handleAuthCodeGrant(
  req: Request,
  res: Response,
): Promise<void> {
  const parsed = TokenAuthzCodeReq.safeParse(req.body);
  if (!parsed.success) {
    return oauthError(
      res,
      400,
      "invalid_request",
      parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    );
  }
  const { code, client_id, redirect_uri, code_verifier } = parsed.data;
  const codeRow = consumeCode(code);
  if (!codeRow) {
    return oauthError(res, 400, "invalid_grant", "code invalido ou expirado");
  }
  if (codeRow.client_id !== client_id) {
    return oauthError(res, 400, "invalid_grant", "client_id nao bate");
  }
  if (codeRow.redirect_uri !== redirect_uri) {
    return oauthError(res, 400, "invalid_grant", "redirect_uri nao bate");
  }
  if (!verifyPkceS256(code_verifier, codeRow.code_challenge)) {
    return oauthError(res, 400, "invalid_grant", "PKCE invalido");
  }
  const accessToken = await signAccessToken({
    email: codeRow.user_email,
    clientId: codeRow.client_id,
  });
  const refreshToken = randomToken(32);
  insertRefreshToken(
    {
      token: refreshToken,
      client_id: codeRow.client_id,
      user_email: codeRow.user_email,
    },
    REFRESH_TTL,
  );
  cors(res);
  res.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: refreshToken,
    ...(codeRow.scope ? { scope: codeRow.scope } : {}),
  });
}

async function handleRefreshGrant(
  req: Request,
  res: Response,
): Promise<void> {
  const parsed = TokenRefreshReq.safeParse(req.body);
  if (!parsed.success) {
    return oauthError(res, 400, "invalid_request");
  }
  const { refresh_token, client_id } = parsed.data;
  const row = getActiveRefreshToken(refresh_token);
  if (!row || row.client_id !== client_id) {
    return oauthError(res, 400, "invalid_grant", "refresh_token invalido");
  }
  // Rotacao: revoga o antigo, emite novo (mitiga reuso roubado).
  revokeRefreshToken(refresh_token);
  const newRefresh = randomToken(32);
  insertRefreshToken(
    { token: newRefresh, client_id: row.client_id, user_email: row.user_email },
    REFRESH_TTL,
  );
  const accessToken = await signAccessToken({
    email: row.user_email,
    clientId: row.client_id,
  });
  cors(res);
  res.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: newRefresh,
  });
}
