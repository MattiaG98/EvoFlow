// Minimal Cloudflare Workers types for what EvoFlow uses. Kept local so the project has no npm dependencies.

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta?: Record<string, unknown>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

export interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Shared secret the hooks and the reconciliation task send as `Authorization: Bearer …`. */
  INGEST_TOKEN?: string;
  /** Password for the dashboard UI. */
  DASHBOARD_PASSWORD?: string;
  /** Optional override, in hours, of the 48 h "forgotten" threshold. */
  FORGOTTEN_HOURS?: string;
}

export interface ScheduledController {
  scheduledTime: number;
  cron: string;
}
