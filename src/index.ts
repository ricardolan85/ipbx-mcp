#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { consultaTN } from "./db.js";

const server = new McpServer({
  name: "mcp-portabilidade",
  version: "0.1.0",
});

server.tool(
  "consultar-portabilidade",
  "Consulta status de portabilidade de um número via stored procedure consultaTN.",
  {
    numero: z
      .string()
      .regex(/^\d{10,13}$/)
      .describe("Número apenas com dígitos (DDI+DDD+assinante), ex: 553534733100"),
  },
  async ({ numero }) => {
    try {
      const row = await consultaTN(numero);
      if (!row) {
        return {
          content: [
            { type: "text", text: `Nenhum resultado para ${numero}.` },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                numero,
                idoperadora: row.idoperadora,
                CIO: row.CIO,
                IsPortado: Boolean(row.IsPortado),
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `Erro na consulta: ${msg}` }],
      };
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("mcp-portabilidade rodando via stdio");
}

main().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
