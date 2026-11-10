import { DatabaseLike, Prepared } from "@shared/types";

/**
 * Thin abstraction over a D1-like database so the same menu operations run
 * against Cloudflare D1 in production and a sql.js database in tests/dev.
 *
 * D1's statement API: stmt.bind(...values) | run() | first() | all()
 * sql.js's statement API: stmt.bind([values]) | run() | get() | all() | free()
 *
 * Both are normalised to the DatabaseLike interface below.
 */

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<unknown>;
  first(): Promise<unknown>;
  all(): Promise<{ results: unknown[] }>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
}

export interface SqlJsStatement {
  bind(values: unknown[]): SqlJsStatement;
  run(): unknown;
  step(): boolean;
  getAsObject(): unknown;
  free(): void;
}

export interface SqlJsDatabase {
  prepare(sql: string): SqlJsStatement;
  exec(sql: string): void;
}

function normalizeStatement(stmt: D1PreparedStatement | SqlJsStatement): Prepared {
  if ((stmt as D1PreparedStatement).first) {
    // D1-style: variadic bind, has .first(). Note that D1's bind() returns a
    // new bound statement, so we track the current statement in a closure.
    const d1 = stmt as D1PreparedStatement;
    let current: D1PreparedStatement = d1;
    const wrapper: Prepared = {
      bind: (...values: unknown[]) => {
        current = d1.bind(...values);
        return wrapper;
      },
      run: async () => current.run(),
      first: async () => current.first(),
      all: async () => {
        const result: unknown = await current.all();
        if (Array.isArray(result)) return result;
        return (result as { results?: unknown[] }).results ?? [];
      },
    };
    return wrapper;
  }
  // sql.js-style: array bind, .step()/.getAsObject() iteration, no .first()/.all()
  const sjs = stmt as SqlJsStatement;
  let currentSjs: SqlJsStatement = sjs;
  const wrapper: Prepared = {
    bind: (...values: unknown[]) => {
      currentSjs.bind(values);
      return wrapper;
    },
    run: async () => currentSjs.run(),
    first: async () => {
      if (currentSjs.step()) return currentSjs.getAsObject();
      return undefined;
    },
    all: async () => {
      const rows: unknown[] = [];
      while (currentSjs.step()) rows.push(currentSjs.getAsObject());
      return rows;
    },
  };
  return wrapper;
}

export function wrapD1(db: D1Database): DatabaseLike {
  return {
    prepare: (sql: string) => normalizeStatement(db.prepare(sql)),
  };
}

export function wrapSqlJs(db: SqlJsDatabase): DatabaseLike {
  return {
    prepare: (sql: string) => normalizeStatement(db.prepare(sql)),
  };
}

/** Format integer minor currency units (paise, INR) as a rupee string. */
export function formatPriceInr(priceCents: number): string {
  const rupees = (priceCents / 100).toFixed(2);
  return `₹${rupees}`;
}

/**
 * Execute one or more semicolon-separated SQL statements against the database.
 * Safe for our own schema/seed files (no semicolons inside string literals).
 */
export async function execStatements(db: DatabaseLike, sql: string): Promise<void> {
  const statements = sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await db.prepare(statement).run();
  }
}

export async function readAll(db: DatabaseLike, sql: string, params: unknown[] = []): Promise<unknown[]> {
  const result: unknown = await db.prepare(sql).bind(...params).all();
  if (Array.isArray(result)) return result;
  return (result as { results?: unknown[] }).results ?? [];
}

export async function readOne(db: DatabaseLike, sql: string, params: unknown[] = []): Promise<unknown> {
  return db.prepare(sql).bind(...params).first();
}
