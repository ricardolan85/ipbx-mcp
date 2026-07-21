import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";

// Pool singleton do processo. O McpServer e recriado a cada request
// (modo stateless), mas o pool NAO pode ser: senao cada chamada abriria
// conexoes novas. Mesma logica do getDb() em sqlite.ts.
let pool: Pool | null = null;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variavel de ambiente ausente: ${name}`);
  }
  return value;
}

/**
 * Id do tenant que ESTA instancia do MCP atende.
 *
 * O banco e multi-tenant (uma instancia Asterisk por cliente, tabela
 * `ipbx`), mas o MCP e mono-tenant: o id vem do ambiente e nunca de um
 * parametro de tool. E o que torna o isolamento entre clientes
 * estrutural em vez de depender do que o modelo passa na chamada.
 */
export function getIpbxId(): number {
  const raw = requireEnv("IPBX_ID");
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`IPBX_ID invalido: "${raw}" (esperado inteiro positivo)`);
  }
  return id;
}

function createPool(): Pool {
  return mysql.createPool({
    host: requireEnv("MYSQL_HOST"),
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: requireEnv("MYSQL_USER"),
    password: requireEnv("MYSQL_PASSWORD"),
    database: requireEnv("MYSQL_DATABASE"),
    // TLS com verificacao de certificado. Se o servidor usa cert
    // autoassinado a conexao falha - e o comportamento desejado:
    // melhor falhar alto do que aceitar qualquer certificado.
    ssl: process.env.MYSQL_SSL ? { minVersion: "TLSv1.2" } : undefined,
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_POOL_LIMIT ?? 5),
    connectTimeout: 10_000,
    // So leitura: nao ha necessidade de multiplos statements, e
    // desabilitar fecha uma via de SQL injection encadeada.
    multipleStatements: false,
  });
}

export function getPool(): Pool {
  if (!pool) pool = createPool();
  return pool;
}

/** Tipos aceitos como parametro de query. Deliberadamente estreito. */
export type QueryParam = string | number | boolean | Date | null;

/**
 * Executa um SELECT parametrizado. Usa `execute` (prepared statement no
 * servidor), entao os valores nunca sao interpolados na string SQL.
 */
export async function query<T extends RowDataPacket>(
  sql: string,
  params: QueryParam[] = [],
): Promise<T[]> {
  const [rows] = await getPool().execute<T[]>(sql, params);
  return rows;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// ---- Tipos de linha ----

export interface IpbxRow extends RowDataPacket {
  id: number;
  shortname: string;
  fullname: string;
  ipaddr: string;
  sipport: number;
  amiport: number;
  created: Date | null;
  updated: Date | null;
}

/**
 * Dados do tenant configurado em IPBX_ID. Retorna null se o id nao
 * existir na tabela `ipbx` (cadastro removido ou .env apontando pro
 * lugar errado).
 */
export async function getIpbxInfo(): Promise<IpbxRow | null> {
  const rows = await query<IpbxRow>(
    `SELECT id, shortname, fullname, ipaddr, sipport, amiport, created, updated
       FROM ipbx
      WHERE id = ?`,
    [getIpbxId()],
  );
  return rows[0] ?? null;
}

export interface IvrRow extends RowDataPacket {
  id: number;
  name: string;
  audio_name: string | null;
  transcription: string | null;
  option_count: number;
}

export interface ListIvrsOptions {
  search?: string;
  limit: number;
}

/**
 * URAs do tenant, com o audio associado e a transcricao do que e
 * falado. A transcricao vem de `audio.transcription` e e o campo mais
 * util da tool: diz o que o cliente ouve.
 */
export async function listIvrs(opts: ListIvrsOptions): Promise<IvrRow[]> {
  const params: QueryParam[] = [getIpbxId()];
  let filter = "";

  if (opts.search) {
    filter = "AND (i.name LIKE ? OR a.transcription LIKE ?)";
    const like = `%${opts.search}%`;
    params.push(like, like);
  }

  // LIMIT vem de inteiro ja validado por zod (1..500).
  return query<IvrRow>(
    `SELECT i.id, i.name,
            a.name AS audio_name, a.transcription,
            (SELECT COUNT(*) FROM ivr_option o
              WHERE o.ivr_id = i.id AND o.ipbx_id = i.ipbx_id) AS option_count
       FROM ivr i
       LEFT JOIN audio a
         ON a.id = i.audio_id AND a.ipbx_id = i.ipbx_id
      WHERE i.ipbx_id = ?
      ${filter}
      ORDER BY i.name
      LIMIT ${Math.trunc(opts.limit)}`,
    params,
  );
}

export interface IvrOptionRow extends RowDataPacket {
  id: number;
  ivr_id: number;
  ivr_name: string | null;
  digit: string;
  goto_ref: string;
  branch_exten: string | null;
  branch_name: string | null;
  queue_name: string | null;
  ivr_target_name: string | null;
  redirect_exten: string | null;
  redirect_name: string | null;
  app_name: string | null;
}

export interface ListIvrOptionsOptions {
  ivrId?: number;
  limit: number;
}

/**
 * Opcoes de URA com o destino resolvido.
 *
 * `ivr_option.goto` e polimorfico: aponta pra 5 tabelas diferentes no
 * formato `<tipo>-<id>` (branch, queue, ivr, redirect, app) e ainda
 * aceita literal sem id -- existe `internal` no banco. Por isso um
 * LEFT JOIN por tipo, cada um casando so quando o prefixo bate, e a
 * tool escolhe o nome que veio preenchido.
 *
 * `app.code` (o dialplan) NAO e exposto: e codigo de execucao do PABX,
 * so o nome do app interessa aqui.
 */
export async function listIvrOptions(
  opts: ListIvrOptionsOptions,
): Promise<IvrOptionRow[]> {
  const params: QueryParam[] = [getIpbxId()];
  let filter = "";

  if (opts.ivrId !== undefined) {
    filter = "AND o.ivr_id = ?";
    params.push(opts.ivrId);
  }

  // LIMIT vem de inteiro ja validado por zod (1..500).
  return query<IvrOptionRow>(
    `SELECT o.id, o.ivr_id, i.name AS ivr_name,
            o.exten AS digit, o.goto AS goto_ref,
            b.exten AS branch_exten, b.name AS branch_name,
            q.name AS queue_name,
            t.name AS ivr_target_name,
            r.exten AS redirect_exten, r.name AS redirect_name,
            ap.name AS app_name
       FROM ivr_option o
       LEFT JOIN ivr i
         ON i.id = o.ivr_id AND i.ipbx_id = o.ipbx_id
       LEFT JOIN branch b
         ON o.goto REGEXP '^branch-[0-9]+$'
        AND b.id = CAST(SUBSTRING_INDEX(o.goto, '-', -1) AS UNSIGNED)
        AND b.ipbx_id = o.ipbx_id
       LEFT JOIN queue q
         ON o.goto REGEXP '^queue-[0-9]+$'
        AND q.id = CAST(SUBSTRING_INDEX(o.goto, '-', -1) AS UNSIGNED)
        AND q.ipbx_id = o.ipbx_id
       LEFT JOIN ivr t
         ON o.goto REGEXP '^ivr-[0-9]+$'
        AND t.id = CAST(SUBSTRING_INDEX(o.goto, '-', -1) AS UNSIGNED)
        AND t.ipbx_id = o.ipbx_id
       LEFT JOIN redirect r
         ON o.goto REGEXP '^redirect-[0-9]+$'
        AND r.id = CAST(SUBSTRING_INDEX(o.goto, '-', -1) AS UNSIGNED)
        AND r.ipbx_id = o.ipbx_id
       LEFT JOIN app ap
         ON o.goto REGEXP '^app-[0-9]+$'
        AND ap.id = CAST(SUBSTRING_INDEX(o.goto, '-', -1) AS UNSIGNED)
        AND ap.ipbx_id = o.ipbx_id
      WHERE o.ipbx_id = ?
      ${filter}
      ORDER BY i.name, LENGTH(o.exten), o.exten
      LIMIT ${Math.trunc(opts.limit)}`,
    params,
  );
}

export interface QueueRow extends RowDataPacket {
  id: number;
  name: string;
  strategy: string;
  member_count: number;
  created: Date | null;
  updated: Date | null;
}

export interface ListQueuesOptions {
  search?: string;
  limit: number;
}

/** Filas do tenant configurado, com quantos membros cada uma tem. */
export async function listQueues(
  opts: ListQueuesOptions,
): Promise<QueueRow[]> {
  const params: QueryParam[] = [getIpbxId()];
  let filter = "";

  if (opts.search) {
    filter = "AND (q.name LIKE ? OR q.strategy LIKE ?)";
    const like = `%${opts.search}%`;
    params.push(like, like);
  }

  // LIMIT vem de inteiro ja validado por zod (1..500).
  return query<QueueRow>(
    `SELECT q.id, q.name, q.strategy,
            COUNT(m.id) AS member_count,
            q.created, q.updated
       FROM queue q
       LEFT JOIN queue_member m
         ON m.queue_id = q.id AND m.ipbx_id = q.ipbx_id
      WHERE q.ipbx_id = ?
      ${filter}
      GROUP BY q.id, q.name, q.strategy, q.created, q.updated
      ORDER BY q.name
      LIMIT ${Math.trunc(opts.limit)}`,
    params,
  );
}

export interface QueueMemberRow extends RowDataPacket {
  id: number;
  queue_id: number;
  queue_name: string | null;
  position: string;
  member_ref: string;
  branch_exten: string | null;
  branch_name: string | null;
}

export interface ListQueueMembersOptions {
  queueId?: number;
  limit: number;
}

/**
 * Membros das filas do tenant, com a referencia resolvida.
 *
 * `queue_member.member` guarda uma referencia em string no formato
 * `<tipo>-<id>` -- ex: `branch-10` aponta pro branch.id 10, que e o
 * ramal 29. NAO e o numero do ramal. E nem todo membro e ramal: existe
 * pelo menos um `redirect-N` no banco. Por isso o LEFT JOIN so casa
 * quando o prefixo e `branch-`, e quem nao casa volta com o ref cru
 * pra tool classificar.
 *
 * `index` e palavra reservada no MySQL 8: precisa de crase. Ele e
 * varchar, entao a ordenacao precisa de CAST pra nao ficar
 * lexicografica ("10" antes de "2").
 */
export async function listQueueMembers(
  opts: ListQueueMembersOptions,
): Promise<QueueMemberRow[]> {
  const params: QueryParam[] = [getIpbxId()];
  let filter = "";

  if (opts.queueId !== undefined) {
    filter = "AND m.queue_id = ?";
    params.push(opts.queueId);
  }

  // LIMIT vem de inteiro ja validado por zod (1..500).
  return query<QueueMemberRow>(
    `SELECT m.id, m.queue_id, q.name AS queue_name,
            m.\`index\` AS position, m.member AS member_ref,
            b.exten AS branch_exten, b.name AS branch_name
       FROM queue_member m
       LEFT JOIN queue q
         ON q.id = m.queue_id AND q.ipbx_id = m.ipbx_id
       LEFT JOIN branch b
         ON m.member REGEXP '^branch-[0-9]+$'
        AND b.id = CAST(SUBSTRING(m.member, 8) AS UNSIGNED)
        AND b.ipbx_id = m.ipbx_id
      WHERE m.ipbx_id = ?
      ${filter}
      ORDER BY q.name, CAST(m.\`index\` AS UNSIGNED)
      LIMIT ${Math.trunc(opts.limit)}`,
    params,
  );
}

export interface TrunkRow extends RowDataPacket {
  id: number;
  name: string;
  host: string;
  port: string | null;
  register: number;
  record: number;
  has_credentials: number;
  created: Date | null;
  updated: Date | null;
}

export interface ListTrunksOptions {
  search?: string;
  limit: number;
}

/**
 * Troncos do tenant configurado.
 *
 * ATENCAO: `username` e `password` NAO entram aqui -- sao a credencial
 * de autenticacao com a operadora, guardada em texto puro. E a
 * credencial mais valiosa do banco: com ela se origina chamada
 * diretamente pela operadora, tarifada na conta da Vivavox.
 *
 * Em vez do segredo, expomos `has_credentials`: diz se o tronco
 * autentica por usuario/senha ou por IP (caso do Datora, sem senha).
 * E o dado operacional que se quer saber, sem revelar nada.
 */
export async function listTrunks(
  opts: ListTrunksOptions,
): Promise<TrunkRow[]> {
  const params: QueryParam[] = [getIpbxId()];
  let filter = "";

  if (opts.search) {
    filter = "AND (name LIKE ? OR host LIKE ?)";
    const like = `%${opts.search}%`;
    params.push(like, like);
  }

  // LIMIT vem de inteiro ja validado por zod (1..500).
  return query<TrunkRow>(
    `SELECT id, name, host, port, register, record,
            (password IS NOT NULL AND password <> '') AS has_credentials,
            created, updated
       FROM trunk
      WHERE ipbx_id = ?
      ${filter}
      ORDER BY name
      LIMIT ${Math.trunc(opts.limit)}`,
    params,
  );
}

export interface GroupRow extends RowDataPacket {
  id: number;
  name: string;
  description: string | null;
  branch_count: number;
  created: Date | null;
  updated: Date | null;
}

export interface ListGroupsOptions {
  search?: string;
  limit: number;
}

/**
 * Grupos de ramais do tenant configurado, com quantos ramais cada um
 * tem. Diferente de `branch` e `users`, esta tabela nao guarda nenhuma
 * credencial -- todas as colunas sao expostas.
 *
 * `groups` e palavra reservada no MySQL 8: precisa de crase.
 * O LEFT JOIN mantem na lista os grupos sem nenhum ramal.
 */
export async function listGroups(
  opts: ListGroupsOptions,
): Promise<GroupRow[]> {
  const params: QueryParam[] = [getIpbxId()];
  let filter = "";

  if (opts.search) {
    filter = "AND (g.name LIKE ? OR g.description LIKE ?)";
    const like = `%${opts.search}%`;
    params.push(like, like);
  }

  // LIMIT vem de inteiro ja validado por zod (1..500).
  return query<GroupRow>(
    `SELECT g.id, g.name, g.description,
            COUNT(b.id) AS branch_count,
            g.created, g.updated
       FROM \`groups\` g
       LEFT JOIN branch b
         ON b.group_id = g.id AND b.ipbx_id = g.ipbx_id
      WHERE g.ipbx_id = ?
      ${filter}
      GROUP BY g.id, g.name, g.description, g.created, g.updated
      ORDER BY g.name
      LIMIT ${Math.trunc(opts.limit)}`,
    params,
  );
}

export interface UserRow extends RowDataPacket {
  id: number;
  name: string;
  email: string;
  created: Date | null;
  updated: Date | null;
}

export interface ListUsersOptions {
  search?: string;
  limit: number;
}

/**
 * Usuarios do painel do tenant configurado.
 *
 * ATENCAO: a coluna `secret` NAO entra aqui. E a senha de login do
 * painel, guardada em texto puro (sem hash) -- confirmado no banco:
 * valores de 4 a 13 caracteres, nenhum padrao de bcrypt/MD5/SHA. Expor
 * isso entrega acesso administrativo ao PABX. Nunca use SELECT *.
 */
export async function listUsers(opts: ListUsersOptions): Promise<UserRow[]> {
  const params: QueryParam[] = [getIpbxId()];
  let filter = "";

  if (opts.search) {
    filter = "AND (name LIKE ? OR email LIKE ?)";
    const like = `%${opts.search}%`;
    params.push(like, like);
  }

  // LIMIT vem de inteiro ja validado por zod (1..500).
  return query<UserRow>(
    `SELECT id, name, email, created, updated
       FROM users
      WHERE ipbx_id = ?
      ${filter}
      ORDER BY name
      LIMIT ${Math.trunc(opts.limit)}`,
    params,
  );
}

export interface BranchRow extends RowDataPacket {
  id: number;
  exten: string;
  name: string;
  group_id: number;
  group_name: string | null;
  record: number;
  webrtc: number;
  dtmf: string;
  forward_busy: string | null;
  forward_noanswer: string | null;
  forward_noanswer_wait: number | null;
}

export interface ListBranchesOptions {
  search?: string;
  limit: number;
}

/**
 * Ramais do tenant configurado.
 *
 * ATENCAO: a lista de colunas e explicita de proposito. `branch` guarda
 * o par de credenciais SIP -- `password` (senha em claro) e `username`
 * (o identificador de autenticacao, que NAO e o numero do ramal). Com os
 * dois, qualquer um registra um softphone e origina chamadas na conta do
 * cliente. Nunca use SELECT * aqui, e nao adicione essas colunas.
 *
 * O LEFT JOIN em `groups` e proposital: nao ha foreign keys declaradas
 * no banco, entao um group_id pode apontar pra grupo inexistente. Com
 * INNER JOIN o ramal sumiria da lista silenciosamente.
 */
export async function listBranches(
  opts: ListBranchesOptions,
): Promise<BranchRow[]> {
  const params: QueryParam[] = [getIpbxId()];
  let filter = "";

  if (opts.search) {
    filter = "AND (b.exten LIKE ? OR b.name LIKE ?)";
    const like = `%${opts.search}%`;
    params.push(like, like);
  }

  // `groups` e palavra reservada no MySQL 8 -- precisa de crase.
  // O LIMIT vem de um inteiro ja validado por zod (1..500), entao a
  // interpolacao aqui nao aceita nada alem de digito.
  return query<BranchRow>(
    `SELECT b.id, b.exten, b.name, b.group_id, g.name AS group_name,
            b.record, b.webrtc, b.dtmf,
            b.forward_busy, b.forward_noanswer, b.forward_noanswer_wait
       FROM branch b
       LEFT JOIN \`groups\` g
         ON g.id = b.group_id AND g.ipbx_id = b.ipbx_id
      WHERE b.ipbx_id = ?
      ${filter}
      ORDER BY LENGTH(b.exten), b.exten
      LIMIT ${Math.trunc(opts.limit)}`,
    params,
  );
}
