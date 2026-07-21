import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logToolCall, type AuthIdentity } from "./audit.js";
import {
  getIpbxInfo,
  listBranches,
  listGroups,
  listIvrOptions,
  listIvrs,
  listQueueMembers,
  listQueues,
  listRedirects,
  listRoutingRules,
  listRoutings,
  listRoutingTimes,
  listTrunks,
  listUsers,
} from "./mysql.js";

/** Campos varchar do PABX vem com "" no lugar de NULL. */
function blankToNull(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * O PABX referencia outras entidades por string `<tipo>-<id>` --
 * `branch-10`, `queue-3`, `redirect-2` -- tanto em
 * `queue_member.member` quanto em `ivr_option.goto`. Alguns valores
 * sao literais sem id (ex: `internal`); nesse caso o proprio literal
 * e o tipo.
 */
function refType(ref: string): string {
  const trimmed = ref.trim();
  const match = /^([a-z_]+)-\d+$/i.exec(trimmed);
  return (match ? match[1]! : trimmed).toLowerCase();
}

export function createServer(identity: AuthIdentity): McpServer {
  const server = new McpServer({
    name: "mcp-ipbx",
    // Manter em sincronia com a "version" do package.json a cada release.
    version: "0.3.0",
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
          const type = refType(row.member_ref);
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

  server.registerTool(
    "ipbx_ivr_list",
    {
      description:
        "Lista as URAs (IVRs) da instancia IPBX: nome, audio associado, " +
        "a transcricao do que e falado para quem liga, e quantas opcoes " +
        "cada URA tem. Aceita busca por nome ou pelo texto da " +
        "transcricao.",
      inputSchema: {
        search: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Filtro opcional por nome da URA ou pelo conteudo da " +
              "transcricao do audio (busca parcial).",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximo de URAs a retornar. Default 100."),
      },
    },
    async (input) => {
      const start = Date.now();
      try {
        const limit = input.limit ?? 100;
        const rows = await listIvrs({ search: input.search, limit });

        const ivrs = rows.map((row) => ({
          id: row.id,
          name: row.name.trim(),
          audio: blankToNull(row.audio_name),
          transcription: blankToNull(row.transcription),
          options: row.option_count,
        }));

        const result = {
          total: ivrs.length,
          truncated: ivrs.length === limit,
          ivrs,
        };

        logToolCall({
          identity,
          tool: "ipbx_ivr_list",
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
          tool: "ipbx_ivr_list",
          args: { search: input.search, limit: input.limit },
          resultOk: false,
          errorMessage: msg,
          durationMs: Date.now() - start,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `Erro no ipbx_ivr_list: ${msg}` }],
        };
      }
    },
  );

  server.registerTool(
    "ipbx_ivr_option_list",
    {
      description:
        "Lista as opcoes das URAs: qual tecla leva a qual destino. O " +
        "destino pode ser ramal, fila, outra URA, redirect ou app -- o " +
        "tipo vem em `goto.type` e o nome ja resolvido em `goto.name`. " +
        "Use ipbx_ivr_list para descobrir o ivr_id.",
      inputSchema: {
        ivr_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Filtra por uma URA especifica. Omita para trazer as opcoes " +
              "de todas as URAs.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximo de opcoes a retornar. Default 200."),
      },
    },
    async (input) => {
      const start = Date.now();
      try {
        const limit = input.limit ?? 200;
        const rows = await listIvrOptions({ ivrId: input.ivr_id, limit });

        const options = rows.map((row) => ({
          ivr_id: row.ivr_id,
          ivr: row.ivr_name?.trim() ?? null,
          digit: row.digit,
          goto: {
            type: refType(row.goto_ref),
            // Um dos joins por tipo preenche; literais nao preenchem
            // nenhum e voltam so com type + ref.
            name:
              row.branch_name?.trim() ??
              row.queue_name?.trim() ??
              row.ivr_target_name?.trim() ??
              row.redirect_name?.trim() ??
              row.app_name?.trim() ??
              null,
            exten: row.branch_exten ?? row.redirect_exten ?? null,
            ref: row.goto_ref,
          },
        }));

        const result = {
          total: options.length,
          truncated: options.length === limit,
          options,
        };

        logToolCall({
          identity,
          tool: "ipbx_ivr_option_list",
          args: { ivr_id: input.ivr_id, limit },
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
          tool: "ipbx_ivr_option_list",
          args: { ivr_id: input.ivr_id, limit: input.limit },
          resultOk: false,
          errorMessage: msg,
          durationMs: Date.now() - start,
        });
        return {
          isError: true,
          content: [
            { type: "text", text: `Erro no ipbx_ivr_option_list: ${msg}` },
          ],
        };
      }
    },
  );

  server.registerTool(
    "ipbx_routing_list",
    {
      description:
        "Lista os planos de roteamento da instancia IPBX (ex: entrada e " +
        "saida), com quantas regras e quantas janelas de horario cada " +
        "um tem. Use o id retornado para filtrar " +
        "ipbx_routing_rule_list e ipbx_routing_time_list.",
      inputSchema: {
        search: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Filtro opcional por nome do plano (busca parcial)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximo de planos a retornar. Default 100."),
      },
    },
    async (input) => {
      const start = Date.now();
      try {
        const limit = input.limit ?? 100;
        const rows = await listRoutings({ search: input.search, limit });

        const routings = rows.map((row) => ({
          id: row.id,
          name: row.name.trim(),
          rules: row.rule_count,
          time_windows: row.time_count,
        }));

        const result = {
          total: routings.length,
          truncated: routings.length === limit,
          routings,
        };

        logToolCall({
          identity,
          tool: "ipbx_routing_list",
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
          tool: "ipbx_routing_list",
          args: { search: input.search, limit: input.limit },
          resultOk: false,
          errorMessage: msg,
          durationMs: Date.now() - start,
        });
        return {
          isError: true,
          content: [
            { type: "text", text: `Erro no ipbx_routing_list: ${msg}` },
          ],
        };
      }
    },
  );

  server.registerTool(
    "ipbx_routing_time_list",
    {
      description:
        "Lista as janelas de horario dos planos de roteamento. Cada " +
        "janela tem faixas no formato do Asterisk (ex: '08:00-18:00,mon'), " +
        "devolvidas como lista. Use ipbx_routing_list para o routing_id.",
      inputSchema: {
        routing_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Filtra por um plano especifico. Omita para trazer todas as " +
              "janelas.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximo de janelas a retornar. Default 100."),
      },
    },
    async (input) => {
      const start = Date.now();
      try {
        const limit = input.limit ?? 100;
        const rows = await listRoutingTimes({
          routingId: input.routing_id,
          limit,
        });

        const windows = rows.map((row) => ({
          id: row.id,
          routing_id: row.routing_id,
          routing: row.routing_name?.trim() ?? null,
          name: row.name.trim(),
          // Formato Asterisk: uma faixa por linha.
          ranges: row.pattern
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean),
        }));

        const result = {
          total: windows.length,
          truncated: windows.length === limit,
          time_windows: windows,
        };

        logToolCall({
          identity,
          tool: "ipbx_routing_time_list",
          args: { routing_id: input.routing_id, limit },
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
          tool: "ipbx_routing_time_list",
          args: { routing_id: input.routing_id, limit: input.limit },
          resultOk: false,
          errorMessage: msg,
          durationMs: Date.now() - start,
        });
        return {
          isError: true,
          content: [
            { type: "text", text: `Erro no ipbx_routing_time_list: ${msg}` },
          ],
        };
      }
    },
  );

  server.registerTool(
    "ipbx_routing_rule_list",
    {
      description:
        "Lista as regras de roteamento (o dialplan). Cada regra casa um " +
        "padrao de numero dentro de uma janela de horario, suprime N " +
        "digitos, adiciona um prefixo e manda pro destino. O destino " +
        "pode ser tronco, URA, ramal, fila, redirect ou app -- resolvido " +
        "em `goto`. Use ipbx_routing_list para o routing_id.",
      inputSchema: {
        routing_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Filtra por um plano especifico. Omita para trazer as regras " +
              "de todos os planos.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximo de regras a retornar. Default 200."),
      },
    },
    async (input) => {
      const start = Date.now();
      try {
        const limit = input.limit ?? 200;
        const rows = await listRoutingRules({
          routingId: input.routing_id,
          limit,
        });

        const rules = rows.map((row) => {
          // goto2/goto3 estao vazios no banco hoje. Se um dia forem
          // preenchidos, aparecem aqui em vez de sumir em silencio.
          const extra = [row.goto2, row.goto3]
            .map((v) => v?.trim())
            .filter((v): v is string => Boolean(v));

          return {
            id: row.id,
            routing_id: row.routing_id,
            routing: row.routing_name?.trim() ?? null,
            name: row.name.trim(),
            time_window: row.time_name?.trim() ?? null,
            match: row.match_rule,
            // Coluna do banco e `supress` (typo). Exposto correto.
            suppress: Number(row.supress) || 0,
            prefix: blankToNull(row.prefix),
            goto: {
              type: refType(row.goto_ref),
              name:
                row.branch_name?.trim() ??
                row.queue_name?.trim() ??
                row.ivr_name?.trim() ??
                row.redirect_name?.trim() ??
                row.app_name?.trim() ??
                row.trunk_name?.trim() ??
                null,
              exten: row.branch_exten ?? row.redirect_exten ?? null,
              ref: row.goto_ref,
            },
            ...(extra.length ? { goto_extra: extra } : {}),
          };
        });

        const result = {
          total: rules.length,
          truncated: rules.length === limit,
          rules,
        };

        logToolCall({
          identity,
          tool: "ipbx_routing_rule_list",
          args: { routing_id: input.routing_id, limit },
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
          tool: "ipbx_routing_rule_list",
          args: { routing_id: input.routing_id, limit: input.limit },
          resultOk: false,
          errorMessage: msg,
          durationMs: Date.now() - start,
        });
        return {
          isError: true,
          content: [
            { type: "text", text: `Erro no ipbx_routing_rule_list: ${msg}` },
          ],
        };
      }
    },
  );

  server.registerTool(
    "ipbx_redirect_list",
    {
      description:
        "Lista os redirects da instancia IPBX: ramais curtos que " +
        "encaminham para um numero externo saindo por um tronco. Sao os " +
        "mesmos `redirect-<id>` que aparecem como destino em filas, URAs " +
        "e regras de roteamento. Aceita busca por ramal, nome ou numero " +
        "de destino.",
      inputSchema: {
        search: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Filtro opcional por ramal, nome ou numero de destino " +
              "(busca parcial).",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximo de redirects a retornar. Default 100."),
      },
    },
    async (input) => {
      const start = Date.now();
      try {
        const limit = input.limit ?? 100;
        const rows = await listRedirects({ search: input.search, limit });

        const redirects = rows.map((row) => ({
          id: row.id,
          exten: row.exten,
          name: row.name.trim(),
          forward: row.forward,
          trunk: row.trunk_name?.trim() ?? null,
          ref: `redirect-${row.id}`,
        }));

        const result = {
          total: redirects.length,
          truncated: redirects.length === limit,
          redirects,
        };

        // `forward` e telefone pessoal: fica fora do audit.
        logToolCall({
          identity,
          tool: "ipbx_redirect_list",
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
          tool: "ipbx_redirect_list",
          args: { search: input.search, limit: input.limit },
          resultOk: false,
          errorMessage: msg,
          durationMs: Date.now() - start,
        });
        return {
          isError: true,
          content: [
            { type: "text", text: `Erro no ipbx_redirect_list: ${msg}` },
          ],
        };
      }
    },
  );

  return server;
}
