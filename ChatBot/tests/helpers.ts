import { wrapSqlJs, execStatements } from "../src/server/lib/db";
import type { DatabaseLike } from "@shared/types";
import { SCHEMA_SQL, SEED_SQL } from "../src/server/lib/init-sql";

/**
 * Build an in-memory sql.js database initialized with the Café Fernweh schema
 * and seed data. Mirrors D1's parameterised-statement interface so the same
 * menu operations run in tests as in production.
 *
 * sql.js loads its WASM asynchronously: the init function resolves to an Emscripten
 * module whose `Database` constructor creates a database instance.
 */
export async function createTestDb(): Promise<DatabaseLike> {
  const sqljsModule = await import("sql.js");
  const init = (sqljsModule as { default: unknown }).default || sqljsModule;
  const module = await (init as unknown as () => Promise<{ Database: new () => { exec(sql: string): void; prepare(sql: string): unknown } }>)();
  const db = new module.Database();
  await execStatements(db as any, SCHEMA_SQL);
  await execStatements(db as any, SEED_SQL);
  return wrapSqlJs(db as any);
}
