import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logToolCall, type AuthIdentity } from "./audit.js";
import { getIpbxInfo, listBranches } from "./mysql.js";

/** Campos varchar do PABX vem com "" no lugar de NULL. */
function blankToNull(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function createServer(identity: AuthIdentity): McpServer {
  const server = new McpServer({
    name: "mcp-ipbx",
    version: "0.1.0",
  });

  server.registerTool(
    "ipbx_info",
    {
      description:
        "Dados de cadastro da instancia IPBX que este servidor atende: " +
        "nome, IP e portas SIP/AMI. Nao aceita parametros - a instancia " +
        "e fixa, definida na configuracao do servidor.",
      inputSchema: {},
    },
    async () => {
      const start = Date.now();
      try {
        const row = await getIpbxInfo();
        if (!row) {
          throw new Error(
            "IPBX_ID configurado nao existe na tabela `ipbx`. " +
              "Verifique o .env deste servidor.",
          );
        }

        // shortname/fullname tem espacos sobrando no cadastro.
        const result = {
          id: row.id,
          shortname: row.shortname.trim(),
          fullname: row.fullname.trim(),
          ipaddr: row.ipaddr,
          sipport: row.sipport,
          amiport: row.amiport,
          created: row.created,
          updated: row.updated,
        };

        logToolCall({
          identity,
          tool: "ipbx_info",
          args: {},
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
          tool: "ipbx_info",
          args: {},
          resultOk: false,
          errorMessage: msg,
          durationMs: Date.now() - start,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `Erro no ipbx_info: ${msg}` }],
        };
      }
    },
  );

  server.registerTool(
    "branch_list",
    {
      description:
        "Lista os ramais (branches) da instancia IPBX: numero, nome do " +
        "usuario, grupo, desvios e flags de gravacao/WebRTC. Nao retorna " +
        "credenciais SIP. Aceita busca por numero ou nome.",
      inputSchema: {
        search: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Filtro opcional por numero do ramal ou nome do usuario " +
              "(busca parcial, sem diferenciar maiuscula).",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximo de ramais a retornar. Default 100."),
      },
    },
    async (input) => {
      const start = Date.now();
      try {
        const limit = input.limit ?? 100;
        const rows = await listBranches({ search: input.search, limit });

        const branches = rows.map((row) => ({
          id: row.id,
          exten: row.exten,
          name: row.name.trim(),
          group: row.group_name?.trim() ?? null,
          record: row.record === 1,
          webrtc: row.webrtc === 1,
          dtmf: row.dtmf,
          forward_busy: blankToNull(row.forward_busy),
          forward_noanswer: blankToNull(row.forward_noanswer),
          forward_noanswer_wait: row.forward_noanswer_wait || null,
        }));

        const result = {
          total: branches.length,
          truncated: branches.length === limit,
          branches,
        };

        // Sem os dados dos ramais no audit: so o metadado da chamada.
        logToolCall({
          identity,
          tool: "branch_list",
          args: { search: input.search, limit },
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
          tool: "branch_list",
          args: { search: input.search, limit: input.limit },
          resultOk: false,
          errorMessage: msg,
          durationMs: Date.now() - start,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `Erro no branch_list: ${msg}` }],
        };
      }
    },
  );

  return server;
}
