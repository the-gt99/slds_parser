import type { QueryResultRow } from "pg";

export function first<Row extends QueryResultRow>(rows: readonly Row[]): Row | null {
  return rows[0] ?? null;
}

export function requireRow<Row extends QueryResultRow>(rows: readonly Row[], entity: string, id: string): Row {
  const row = rows[0];
  if (!row) throw new Error(`${entity} not found: ${id}`);
  return row;
}

interface PostgresError { readonly code?: unknown; readonly constraint?: unknown }

export function isExternalIdentityConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const postgresError = error as PostgresError;
  return postgresError.code === "23505" && postgresError.constraint === "source_products_source_external_id_idx";
}
