import { getDb } from "./sqlite.js";

export type AuthKind = "user" | "service";

export interface AuthIdentity {
  kind: AuthKind;
  email: string | null;
  clientId: string | null;
}

export interface AuditEntry {
  identity: AuthIdentity;
  tool: string;
  args: unknown;
  resultOk: boolean;
  errorMessage?: string;
  durationMs?: number;
}

const INSERT_SQL = `
  INSERT INTO audit_log
    (user_email, auth_kind, client_id, tool, args_json, result_ok, error_message, duration_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;

export function logToolCall(entry: AuditEntry): void {
  const db = getDb();
  const stmt = db.prepare(INSERT_SQL);
  try {
    stmt.run(
      entry.identity.email,
      entry.identity.kind,
      entry.identity.clientId,
      entry.tool,
      JSON.stringify(entry.args ?? null),
      entry.resultOk ? 1 : 0,
      entry.errorMessage ?? null,
      entry.durationMs ?? null,
    );
  } catch (err) {
    // Audit nao deve quebrar a chamada da tool. Loga e segue.
    console.error("Falha ao gravar audit_log:", err);
  }
}
