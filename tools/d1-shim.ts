// A D1-compatible wrapper over node:sqlite, so the Worker runs and is tested locally without wrangler.
import { DatabaseSync } from 'node:sqlite';

class Statement {
  db: DatabaseSync;
  sql: string;
  params: unknown[];

  constructor(db: DatabaseSync, sql: string, params: unknown[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: unknown[]) {
    return new Statement(this.db, this.sql, values);
  }

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...(this.params as never[])) as T) ?? null;
  }

  async all<T>() {
    return { results: this.db.prepare(this.sql).all(...(this.params as never[])) as T[], success: true, meta: {} };
  }

  async run() {
    const res = this.db.prepare(this.sql).run(...(this.params as never[]));
    return { results: [], success: true, meta: { changes: Number(res.changes) } };
  }

  runSync() {
    const stmt = this.db.prepare(this.sql);
    if (/^\s*(SELECT|INSERT.*RETURNING)/is.test(this.sql)) {
      return { results: stmt.all(...(this.params as never[])), success: true, meta: {} };
    }
    const res = stmt.run(...(this.params as never[]));
    return { results: [], success: true, meta: { changes: Number(res.changes) } };
  }
}

export function createD1(path = ':memory:') {
  const db = new DatabaseSync(path);
  return {
    prepare: (sql: string) => new Statement(db, sql),
    // D1 runs a batch as one transaction.
    async batch(statements: Statement[]) {
      db.exec('BEGIN');
      try {
        const out = statements.map((s) => s.runSync());
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    raw: db,
  };
}
