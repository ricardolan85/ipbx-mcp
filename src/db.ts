import mysql from "mysql2/promise";

let pool: mysql.Pool | undefined;

export function getPool(): mysql.Pool {
  if (pool) return pool;

  const {
    MYSQL_HOST,
    MYSQL_PORT,
    MYSQL_USER,
    MYSQL_PASSWORD,
    MYSQL_DATABASE,
  } = process.env;

  if (!MYSQL_HOST || !MYSQL_USER || !MYSQL_DATABASE) {
    throw new Error(
      "Variáveis MYSQL_HOST, MYSQL_USER e MYSQL_DATABASE são obrigatórias.",
    );
  }

  pool = mysql.createPool({
    host: MYSQL_HOST,
    port: MYSQL_PORT ? Number(MYSQL_PORT) : 3306,
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    database: MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 5,
    namedPlaceholders: true,
  });

  return pool;
}

export interface ConsultaTNRow {
  idoperadora: number;
  CIO: number;
  IsPortado: number;
}

export async function consultaTN(numero: string): Promise<ConsultaTNRow | null> {
  const [rows] = await getPool().query<mysql.RowDataPacket[][]>(
    "CALL consultaTN(?)",
    [numero],
  );
  const first = rows?.[0]?.[0] as ConsultaTNRow | undefined;
  return first ?? null;
}
