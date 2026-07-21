import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken } from "./jwt.js";
import type { AuthIdentity } from "../audit.js";

declare module "express-serve-static-core" {
  interface Request {
    identity?: AuthIdentity;
  }
}

const STATIC_TOKEN = process.env.MCP_AUTH_TOKEN
  ? Buffer.from(process.env.MCP_AUTH_TOKEN)
  : null;

function staticTokenMatches(provided: string): boolean {
  if (!STATIC_TOKEN) return false;
  const got = Buffer.from(provided);
  if (got.length !== STATIC_TOKEN.length) return false;
  return timingSafeEqual(STATIC_TOKEN, got);
}

function unauthorized(res: Response): void {
  // RFC 9728: aponta clientes MCP pra descoberta do AS via header.
  // Sem isso, claude.ai nao acha o endpoint OAuth no primeiro 401.
  const issuer = process.env.OAUTH_ISSUER?.replace(/\/$/, "");
  if (issuer) {
    res.setHeader(
      "WWW-Authenticate",
      `Bearer realm="${issuer}", resource_metadata="${issuer}/.well-known/oauth-protected-resource"`,
    );
  } else {
    res.setHeader("WWW-Authenticate", `Bearer realm="mcp-ipbx"`);
  }
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Unauthorized" },
    id: null,
  });
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.header("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return unauthorized(res);
  const token = match[1];

  // 1) Tenta como JWT (caminho OAuth)
  try {
    const claims = await verifyAccessToken(token);
    req.identity = {
      kind: "user",
      email: claims.sub,
      clientId: claims.azp,
    };
    return next();
  } catch {
    // Nao e JWT valido - tenta como token estatico
  }

  // 2) Fallback: bearer estatico (legado)
  if (staticTokenMatches(token)) {
    req.identity = {
      kind: "service",
      email: "service:static",
      clientId: null,
    };
    return next();
  }

  return unauthorized(res);
}
