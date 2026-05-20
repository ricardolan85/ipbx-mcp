import Database from "better-sqlite3";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";

let db: Database.Database | null = null;

function openDb(): Database.Database {
  const path = process.env.SQLITE_PATH ?? "./data/app.db";
  const resolved = resolve(path);
  mkdirSync(dirname(resolved), { recursive: true });

  const instance = new Database(resolved);
  instance.pragma("journal_mode = WAL");
  instance.pragma("foreign_keys = ON");

  applySchemas(instance);
  return instance;
}

function applySchemas(instance: Database.Database): void {
  // Diretório sql/ relativo ao CWD (raiz do projeto / WORKDIR no container).
  const sqlDir = resolve(process.cwd(), "sql");
  const files = readdirSync(sqlDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(sqlDir, file), "utf8");
    instance.exec(sql);
  }
}

export function getDb(): Database.Database {
  if (!db) db = openDb();
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
