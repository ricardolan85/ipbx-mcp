import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logToolCall, type AuthIdentity } from "./audit.js";

export function createServer(identity: AuthIdentity): McpServer {
  const server = new McpServer({
    name: "mcp-base",
    version: "0.1.0",
  });

  server.registerTool(
    "ping",
    {
      description:
        "Health check simples: responde 'pong'. Aceita uma mensagem " +
        "opcional que e ecoada de volta na resposta.",
      inputSchema: {
        message: z
          .string()
          .optional()
          .describe("Mensagem opcional a ser ecoada na resposta."),
      },
    },
    async (input) => {
      const start = Date.now();
      try {
        const result = { pong: true, message: input.message ?? null };

        logToolCall({
          identity,
          tool: "ping",
          args: { message: input.message },
          resultOk: true,
          durationMs: Date.now() - start,
        });

        return {
          content: [
            { type: "text", text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logToolCall({
          identity,
          tool: "ping",
          args: { message: input.message },
          resultOk: false,
          errorMessage: msg,
          durationMs: Date.now() - start,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `Erro no ping: ${msg}` }],
        };
      }
    },
  );

  return server;
}
