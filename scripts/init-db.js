#!/usr/bin/env node
/**
 * scripts/init-db.js
 *
 * Repeatable database seeding for local development / demos.
 *
 * Reads db/schema.sql and db/seeds/seed.sql and applies them to a local
 * sql.js database persisted at .data/local.db. Re-running is safe: the seed
 * is idempotent (DELETE + INSERT OR REPLACE).
 *
 * Usage: node scripts/init-db.js
 *
 * This mirrors the D1 migrations (db/migrations/0001_initial.sql and
 * 0002_seed.sql) so the local file and the D1 database stay in sync.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { mkdirSync } from "fs";
import Database from "sql.js";

const ROOT = join(__dirname, "..");
const OUT = join(ROOT, ".data", "local.db");

async function main() {
  const sqljsModule = await import("sql.js");
  const init = (sqljsModule as { default: unknown }).default || sqljsModule;
  const module = await (init as unknown as () => Promise<{ Database: new () => { exec(sql: string): void; export(): Uint8Array } }>)();
  const db = new module.Database();

  const schema = readFileSync(join(ROOT, "db", "schema.sql"), "utf8");
  const seed = readFileSync(join(ROOT, "db", "seeds", "seed.sql"), "utf8");

  db.exec(schema);
  db.exec(seed);

  mkdirSync(join(ROOT, ".data"), { recursive: true });
  const data = db.export();
  require("fs").writeFileSync(OUT, Buffer.from(data));
  // eslint-disable-next-line no-console
  console.log(`Seeded local database -> ${OUT}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("init-db failed:", err);
  process.exit(1);
});
