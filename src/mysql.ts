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
