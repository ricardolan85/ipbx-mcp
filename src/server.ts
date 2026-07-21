import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logToolCall, type AuthIdentity } from "./audit.js";
import {
  getIpbxInfo,
  listBranches,
  listGroups,
  listQueueMembers,
  listQueues,
  listTrunks,
  listUsers,
} from "./mysql.js";

/** Campos varchar do PABX vem com "" no lugar de NULL. */
function blankToNull(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * `queue_member.member` e uma referencia `<tipo>-<id>` (ex: branch-10,
 * redirect-2). Extrai o tipo pra tool nao fingir que todo membro e
 * ramal.
 */
function memberType(ref: string): string {
  const match = /^([a-z_]+)-\d+$/i.exec(ref.trim());
  return match ? match[1]!.toLowerCase() : "desconhecido";
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

  server.registerTool(
    "ipbx_queue_list",
    {
      description:
        "Lista as filas de atendimento da instancia IPBX: nome, " +
        "estrategia de distribuicao (ringall, leastrecent, etc) e " +
        "quantos membros cada fila tem. Aceita busca por nome ou " +
        "estrategia.",
      inputSchema: {
        search: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Filtro opcional por nome da fila ou estrategia (busca " +
              "parcial, sem diferenciar maiuscula).",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximo de filas a retornar. Default 100."),
      },
    },
    async (input) => {
      const start = Date.now();
      try {
        const limit = input.limit ?? 100;
        const rows = await listQueues({ search: input.search, limit });

        const queues = rows.map((row) => ({
          id: row.id,
          name: row.name.trim(),
          strategy: row.strategy,
          members: row.member_count,
        }));

        const result = {
          total: queues.length,
          truncated: queues.length === limit,
          queues,
        };

        logToolCall({
          identity,
          tool: "ipbx_queue_list",
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
          tool: "ipbx_queue_list",
          args: { search: input.search, limit: input.limit },
          resultOk: false,
          errorMessage: msg,
          durationMs: Date.now() - start,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `Erro no ipbx_queue_list: ${msg}` }],
        };
      }
    },
  );

  server.registerTool(
    "ipbx_queue_member_list",
    {
      description:
        "Lista os membros das filas de atendimento, na ordem de " +
        "toque. Quando o membro e um ramal, resolve para numero e nome " +
        "do usuario. Membros podem ser de outros tipos (ex: redirect), " +
        "indicados no campo `type`. Use ipbx_queue_list para descobrir " +
        "o queue_id.",
      inputSchema: {
        queue_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Filtra por uma fila especifica. Omita para trazer os " +
              "membros de todas as filas.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximo de membros a retornar. Default 200."),
      },
    },
    async (input) => {
      const start = Date.now();
      try {
        const limit = input.limit ?? 200;
        const rows = await listQueueMembers({
          queueId: input.queue_id,
          limit,
        });

        const members = rows.map((row) => {
          const type = memberType(row.member_ref);
          return {
            queue_id: row.queue_id,
            queue: row.queue_name?.trim() ?? null,
            position: Number(row.position),
            type,
            // Preenchidos so quando o membro e um ramal.
            exten: row.branch_exten,
            name: row.branch_name?.trim() ?? null,
            ref: row.member_ref,
          };
        });

        const result = {
          total: members.length,
          truncated: members.length === limit,
          members,
        };

        logToolCall({
          identity,
          tool: "ipbx_queue_member_list",
          args: { queue_id: input.queue_id, limit },
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
          tool: "ipbx_queue_member_list",
          args: { queue_id: input.queue_id, limit: input.limit },
          resultOk: false,
          errorMessage: msg,
          durationMs: Date.now() - start,
        });
        return {
          isError: true,
          content: [
            { type: "text", text: `Erro no ipbx_queue_member_list: ${msg}` },
          ],
        };
      }
    },
  );

  return server;
}
