import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logToolCall, type AuthIdentity } from "./audit.js";
import {
  getIpbxInfo,
  listBranches,
  listGroups,
  listTrunks,
  listUsers,
} from "./mysql.js";

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
    "ipbx_instance_get",
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
          tool: "ipbx_instance_get",
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
          tool: "ipbx_instance_get",
          args: {},
          resultOk: false,
          errorMessage: msg,
          durationMs: Date.now() - start,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `Erro no ipbx_instance_get: ${msg}` }],
        };
      }
    },
  );

  server.registerTool(
    "ipbx_branch_list",
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
          tool: "ipbx_branch_list",
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
          tool: "ipbx_branch_list",
          args: { search: input.search, limit: input.limit },
          resultOk: false,
          errorMessage: msg,
          durationMs: Date.now() - start,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `Erro no ipbx_branch_list: ${msg}` }],
        };
      }
    },
  );

  server.registerTool(
    "ipbx_user_list",
    {
      description:
        "Lista os usuarios do painel da instancia IPBX: nome, email e " +
        "datas de cadastro. Nao retorna a senha de acesso. Aceita busca " +
        "por nome ou email.",
      inputSchema: {
        search: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Filtro opcional por nome ou email (busca parcial, sem " +
              "diferenciar maiuscula).",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximo de usuarios a retornar. Default 100."),
      },
    },
    async (input) => {
      const start = Date.now();
      try {
        const limit = input.limit ?? 100;
        const rows = await listUsers({ search: input.search, limit });

        const users = rows.map((row) => ({
          id: row.id,
          name: row.name.trim(),
          email: row.email.trim(),
          created: row.created,
          updated: row.updated,
        }));

        const result = {
          total: users.length,
          truncated: users.length === limit,
          users,
        };

        // Sem os dados dos usuarios no audit: so o metadado da chamada.
        logToolCall({
          identity,
          tool: "ipbx_user_list",
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
          tool: "ipbx_user_list",
          args: { search: input.search, limit: input.limit },
          resultOk: false,
          errorMessage: msg,
          durationMs: Date.now() - start,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `Erro no ipbx_user_list: ${msg}` }],
        };
      }
    },
  );

  server.registerTool(
    "ipbx_group_list",
    {
      description:
        "Lista os grupos de ramais da instancia IPBX: nome, descricao e " +
        "quantos ramais cada grupo tem. Aceita busca por nome ou descricao.",
      inputSchema: {
        search: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Filtro opcional por nome ou descricao do grupo (busca " +
              "parcial, sem diferenciar maiuscula).",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximo de grupos a retornar. Default 100."),
      },
    },
    async (input) => {
      const start = Date.now();
      try {
        const limit = input.limit ?? 100;
        const rows = await listGroups({ search: input.search, limit });

        const groups = rows.map((row) => ({
          id: row.id,
          name: row.name.trim(),
          description: blankToNull(row.description),
          branches: row.branch_count,
        }));

        const result = {
          total: groups.length,
          truncated: groups.length === limit,
          groups,
        };

        logToolCall({
          identity,
          tool: "ipbx_group_list",
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
          tool: "ipbx_group_list",
          args: { search: input.search, limit: input.limit },
          resultOk: false,
          errorMessage: msg,
          durationMs: Date.now() - start,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `Erro no ipbx_group_list: ${msg}` }],
        };
      }
    },
  );

  server.registerTool(
    "ipbx_trunk_list",
    {
      description:
        "Lista os troncos (trunks) da instancia IPBX: nome, host da " +
        "operadora, porta, se registra e se grava. Nao retorna as " +
        "credenciais de autenticacao com a operadora. Aceita busca por " +
        "nome ou host.",
      inputSchema: {
        search: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Filtro opcional por nome do tronco ou host (busca parcial, " +
              "sem diferenciar maiuscula).",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximo de troncos a retornar. Default 100."),
      },
    },
    async (input) => {
      const start = Date.now();
      try {
        const limit = input.limit ?? 100;
        const rows = await listTrunks({ search: input.search, limit });

        const trunks = rows.map((row) => ({
          id: row.id,
          name: row.name.trim(),
          host: row.host.trim(),
          port: blankToNull(row.port),
          register: row.register === 1,
          record: row.record === 1,
          // Modo de autenticacao, sem revelar a credencial.
          auth: row.has_credentials === 1 ? "credentials" : "ip",
        }));

        const result = {
          total: trunks.length,
          truncated: trunks.length === limit,
          trunks,
        };

        logToolCall({
          identity,
          tool: "ipbx_trunk_list",
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
          tool: "ipbx_trunk_list",
          args: { search: input.search, limit: input.limit },
          resultOk: false,
          errorMessage: msg,
          durationMs: Date.now() - start,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `Erro no ipbx_trunk_list: ${msg}` }],
        };
      }
    },
  );

  return server;
}
