import type { QueryResultRow } from "pg";

export interface SqlResult<Row extends QueryResultRow = QueryResultRow> {
  readonly rows: Row[];
  readonly rowCount: number | null;
}

export interface SqlExecutor {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<SqlResult<Row>>;
}

export interface SqlClient extends SqlExecutor {
  release(): void;
}

export interface SqlPool {
  connect(): Promise<SqlClient>;
  end(): Promise<void>;
}
