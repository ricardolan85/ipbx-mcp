import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { consultarPortabilidade } from "./portabilidade.js";
import { logToolCall, type AuthIdentity } from "./audit.js";

export function createServer(identity: AuthIdentity): McpServer {
  const server = new McpServer({
    name: "mcp-portabilidade",
    version: "0.1.0",
  });

  server.tool(
    "consultar-portabilidade",
    "Consulta status de portabilidade de um número via API da provedora.",
    {
      numero: z
        .string()
        .regex(/^\d{10,13}$/)
        .describe("Número apenas com dígitos (DDI+DDD+assinante), ex: 553534733100"),
    },
    async ({ numero }) => {
      const start = Date.now();
      try {
        const row = await consultarPortabilidade(numero);
        const result = row
          ? {
              numero,
              idoperadora: row.idoperadora,
              operadora: row.operadora,
              CIO: row.cio,
              IsPortado: row.portado,
            }
          : null;

        logToolCall({
          identity,
          tool: "consultar-portabilidade",
          args: { numero },
          resultOk: true,
          durationMs: Date.now() - start,
        });

        if (!result) {
          return {
            content: [
              { type: "text", text: `Nenhum resultado para ${numero}.` },
            ],
          };
        }
        return {
          content: [
            { type: "text", text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logToolCall({
          identity,
          tool: "consultar-portabilidade",
          args: { numero },
          resultOk: false,
          errorMessage: msg,
          durationMs: Date.now() - start,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `Erro na consulta: ${msg}` }],
        };
      }
    },
  );

  return server;
}
