#!/usr/bin/env node
import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { createServer } from "./server.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const ALLOWED_HOSTS = process.env.MCP_ALLOWED_HOSTS
  ? process.env.MCP_ALLOWED_HOSTS.split(",").map((s) => s.trim()).filter(Boolean)
  : undefined;
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

if (!AUTH_TOKEN) {
  console.error(
    "MCP_AUTH_TOKEN não definido. Defina a variável de ambiente antes de iniciar.",
  );
  process.exit(1);
}

const expectedToken = Buffer.from(AUTH_TOKEN);

function tokenMatches(provided: string): boolean {
  const got = Buffer.from(provided);
  if (got.length !== expectedToken.length) return false;
  return timingSafeEqual(expectedToken, got);
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.header("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match || !tokenMatches(match[1])) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
    return;
  }
  next();
}

const app = createMcpExpressApp({ host: HOST, allowedHosts: ALLOWED_HOSTS });

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/mcp", requireAuth, async (req, res) => {
  const server = createServer();
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
});

const shutdown = (signal: string) => () => {
  console.error(`Recebido ${signal}, encerrando...`);
  process.exit(0);
};
process.on("SIGINT", shutdown("SIGINT"));
process.on("SIGTERM", shutdown("SIGTERM"));
