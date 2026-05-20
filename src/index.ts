#!/usr/bin/env node
import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { createServer } from "./server.js";
import { requireAuth } from "./auth/middleware.js";
import { getDb, closeDb } from "./sqlite.js";

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

// Inicializa SQLite cedo: cria arquivo, aplica schemas, pega o erro
// agora em vez de na primeira requisicao.
getDb();

const app = createMcpExpressApp({ host: HOST, allowedHosts: ALLOWED_HOSTS });

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/mcp", requireAuth, async (req, res) => {
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

app.get("/mcp", requireAuth, methodNotAllowed);
app.delete("/mcp", requireAuth, methodNotAllowed);

app.listen(PORT, HOST, (err?: Error) => {
  if (err) {
    console.error("Falha ao iniciar:", err);
    process.exit(1);
  }
  console.error(`mcp-portabilidade ouvindo em http://${HOST}:${PORT}/mcp`);
  console.error(
    `Auth: ${[HAS_JWT && "JWT/OAuth", HAS_STATIC && "bearer estatico"]
      .filter(Boolean)
      .join(" + ")}`,
  );
});

const shutdown = (signal: string) => () => {
  console.error(`Recebido ${signal}, encerrando...`);
  closeDb();
  process.exit(0);
};
process.on("SIGINT", shutdown("SIGINT"));
process.on("SIGTERM", shutdown("SIGTERM"));
