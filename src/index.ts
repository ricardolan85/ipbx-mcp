#!/usr/bin/env node
import type { NextFunction, Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { createServer } from "./server.js";
import { requireAuth } from "./auth/middleware.js";
import { getDb, closeDb } from "./sqlite.js";
import { registerOAuthRoutes } from "./oauth/routes.js";

// Log de acesso pras rotas /mcp. Roda ANTES do requireAuth, entao
// pega tambem 401 (anon) - util pra detectar tentativas com token
// errado.
function logMcpAccess(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on("finish", () => {
    const body = req.body as
      | {
          method?: string;
          params?: { name?: string; arguments?: Record<string, unknown> };
        }
      | undefined;
    const rpc = body?.method ?? "?";
    const tool = body?.params?.name;
    const args = body?.params?.arguments;
    const argsStr =
      args && typeof args === "object"
        ? " " +
          Object.entries(args)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(" ")
        : "";
    const tag = tool ? `${rpc}(${tool}${argsStr})` : rpc;
    const who = req.identity?.email ?? "anon";
    console.error(
      `[mcp] ${who} ${req.method} ${tag} -> ${res.statusCode} ${Date.now() - start}ms`,
    );
  });
  next();
}

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const ALLOWED_HOSTS = process.env.MCP_ALLOWED_HOSTS
  ? process.env.MCP_ALLOWED_HOSTS.split(",").map((s) => s.trim()).filter(Boolean)
  : undefined;

// Pelo menos um caminho de auth precisa estar configurado.
const HAS_STATIC = Boolean(process.env.MCP_AUTH_TOKEN);
const HAS_JWT = Boolean(process.env.OAUTH_JWT_SECRET && process.env.OAUTH_ISSUER);
if (!HAS_STATIC && !HAS_JWT) {
  console.error(
    "Nenhum caminho de auth configurado. Defina MCP_AUTH_TOKEN " +
      "(bearer estatico) e/ou OAUTH_JWT_SECRET + OAUTH_ISSUER (JWT/OAuth).",
  );
  process.exit(1);
}

// Para ativar o fluxo OAuth completo (rotas /authorize, callback Google,
// /token) precisamos das credenciais do Google. Sem elas, podemos ter
// JWT (validar tokens emitidos antes) mas nao emitir novos pela UI.
const OAUTH_FLOW_READY =
  HAS_JWT &&
  Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
if (HAS_JWT && !OAUTH_FLOW_READY) {
  console.error(
    "AVISO: OAUTH_JWT_SECRET definido mas GOOGLE_CLIENT_ID/SECRET ausentes. " +
      "Rotas /authorize, /oauth/google/callback e /token nao serao registradas.",
  );
}

// Inicializa SQLite cedo: cria arquivo, aplica schemas, pega o erro
// agora em vez de na primeira requisicao.
getDb();

const app = createMcpExpressApp({ host: HOST, allowedHosts: ALLOWED_HOSTS });

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// OAuth (publico: discovery, DCR, /authorize, callback Google, /token).
// So registra se tem o flow completo configurado.
if (OAUTH_FLOW_READY) {
  registerOAuthRoutes(app);
}

app.post("/mcp", logMcpAccess, requireAuth, async (req, res) => {
  const identity = req.identity!;
  const server = createServer(identity);
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Erro no /mcp:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

const methodNotAllowed = (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
};

app.get("/mcp", logMcpAccess, requireAuth, methodNotAllowed);
app.delete("/mcp", logMcpAccess, requireAuth, methodNotAllowed);

app.listen(PORT, HOST, (err?: Error) => {
  if (err) {
    console.error("Falha ao iniciar:", err);
    process.exit(1);
  }
  console.error(`mcp-base ouvindo em http://${HOST}:${PORT}/mcp`);
  console.error(
    `Auth: ${[HAS_JWT && "JWT", HAS_STATIC && "bearer estatico"]
      .filter(Boolean)
      .join(" + ")}` + (OAUTH_FLOW_READY ? " (OAuth flow ativo)" : ""),
  );
});

const shutdown = (signal: string) => () => {
  console.error(`Recebido ${signal}, encerrando...`);
  closeDb();
  process.exit(0);
};
process.on("SIGINT", shutdown("SIGINT"));
process.on("SIGTERM", shutdown("SIGTERM"));
