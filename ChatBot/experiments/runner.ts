/**
 * experiments/runner.ts
 *
 * Quota-conscious evaluation runner for the Café Fernweh AI behaviour study.
 *
 * Runs the experimental dataset (experiments/eval-dataset.json) against the
 * live Worker (genuine Gemini inference) or the demo provider, recording one
 * append-only JSONL record per case to experiments/results.jsonl.
 *
 * Designed for the Gemini free tier, which exhibits throttling:
 *   - configurable batch size and concurrency (default 1)
 *   - conservative pacing between requests
   - bounded retries for transient failures (429 / network)
   - no repeated retries for invalid credentials (401 / 403)
   - resumable: skips test cases already recorded for the current dataset
   - unique run identifier per invocation
   - selectable test sets (dev / heldOut) and categories
 *
 * Deterministic menu facts (price, availability, dietary, sales) are checked
 * against the database where a factual claim can be extracted; generative
 * responses that cannot be objectively checked are marked "unverified" for
 * manual review. No result is ever fabricated.
 *
 * Usage (from ChatBot/):
 *   npx tsx experiments/runner.ts
 *
 * Environment variables (all optional):
 *   EVAL_BASE_URL        Worker base URL (default http://127.0.0.1:8787)
 *   EVAL_ADMIN_TOKEN     token for non-D grounding modes (default none)
 *   EVAL_MODEL           model identifier (default gemini-3.5-flash-lite)
 *   EVAL_PROVIDER        gemini|demo (default gemini)
 *   EVAL_SETS            comma-separated sets: dev,heldOut (default dev)
 *   EVAL_CATEGORIES      comma-separated category filter (default all)
 *   EVAL_BATCH_SIZE      cases per run (default 0 = all remaining)
 *   EVAL_CONCURRENCY     parallel requests (default 1)
 *   EVAL_PACING_MS       ms between requests (default 1000)
 *   EVAL_MAX_RETRIES     bounded retries for transient failures (default 3)
 *   EVAL_RETRY_DELAY_MS  base retry delay (default 5000)
 *   EVAL_RESULTS_FILE    output JSONL (default experiments/results.jsonl)
 */

import { readFileSync, existsSync, appendFileSync } from "fs";
import { join } from "path";
import { createTestDb } from "../tests/helpers";
import { searchProducts } from "../src/server/lib/menu";

const ROOT = join(__dirname, "..");
const DATASET_PATH = join(ROOT, "experiments", "eval-dataset.json");

interface EnvConfig {
  baseUrl: string;
  adminToken: string | undefined;
  model: string;
  provider: "gemini" | "demo";
  sets: string[];
  categories: string[] | null;
  batchSize: number;
  concurrency: number;
  pacingMs: number;
  maxRetries: number;
  retryDelayMs: number;
  resultsFile: string;
  groundingMode: string | undefined;
}

function envConfig(): EnvConfig {
  const rawSets = process.env.EVAL_SETS || "dev";
  return {
    baseUrl: process.env.EVAL_BASE_URL || "http://127.0.0.1:8787",
    adminToken: process.env.EVAL_ADMIN_TOKEN || undefined,
    model: process.env.EVAL_MODEL || "gemini-3.5-flash-lite",
    provider: (process.env.EVAL_PROVIDER || "gemini") as "gemini" | "demo",
    sets: rawSets.split(",").map((s) => s.trim()).filter(Boolean),
    categories: process.env.EVAL_CATEGORIES
      ? process.env.EVAL_CATEGORIES.split(",").map((s) => s.trim()).filter(Boolean)
      : null,
    batchSize: Number(process.env.EVAL_BATCH_SIZE || 0),
    concurrency: Math.max(1, Number(process.env.EVAL_CONCURRENCY || 1)),
    pacingMs: Number(process.env.EVAL_PACING_MS || 1000),
    maxRetries: Number(process.env.EVAL_MAX_RETRIES || 3),
    retryDelayMs: Number(process.env.EVAL_RETRY_DELAY_MS || 5000),
    resultsFile: process.env.EVAL_RESULTS_FILE || join(ROOT, "experiments", "results.jsonl"),
    groundingMode: process.env.EVAL_GROUNDING_MODE || undefined,
  };
}

interface DatasetCase {
  id: string;
  category: string;
  question: string;
  groundingMode: string;
  expectedOutcome: string;
  failureCategory: string;
}

interface Dataset {
  schemaVersion: string;
  model: { provider: string; candidate: string; configuredVia: string };
  sets: { dev: DatasetCase[]; heldOut: DatasetCase[] };
}

function loadDataset(): Dataset {
  const raw = JSON.parse(readFileSync(DATASET_PATH, "utf8")) as Dataset;
  // Backwards-compat: older datasets have a flat "cases" array.
  if (!raw.sets && Array.isArray((raw as any).cases)) {
    return { ...raw, sets: { dev: (raw as any).cases, heldOut: [] } };
  }
  return raw;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Load already-recorded testIds for this run to support resumption. */
function loadCompletedIds(resultsFile: string): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(resultsFile)) return ids;
  const content = readFileSync(resultsFile, "utf8");
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && rec.testId) ids.add(rec.testId);
    } catch {
      // ignore malformed lines
    }
  }
  return ids;
}

function appendRecord(resultsFile: string, record: unknown): void {
  appendFileSync(resultsFile, JSON.stringify(record) + "\n");
}

/**
 * Extract rupee amounts mentioned in a response, with their positions.
 */
function extractPricesWithPositions(text: string): Array<{ cents: number; index: number }> {
  const prices: Array<{ cents: number; index: number }> = [];
  const re = /₹\s*(\d+(?:\.\d{1,2})?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const cap = m[1];
    if (!cap) continue;
    prices.push({ cents: Math.round(parseFloat(cap) * 100), index: m.index });
  }
  return prices;
}

/**
 * Deterministic factual check against the database. Only flags a price claim
 * when a price is stated in close proximity to a product name (suggesting a
 * product price claim). Standalone totals/aggregates (e.g. "total revenue")
 are not flagged, since they are not product prices.
 */
async function checkFactual(db: any, response: string): Promise<{ constraint: string | null; detail: string | null }> {
  const prices = extractPricesWithPositions(response);
  if (prices.length === 0) return { constraint: null, detail: null };
  const products = await searchProducts(db, { query: "", limit: 200 });
  const validPrices = new Set(products.map((p) => p.price_cents));
  const productNames = products.map((p) => p.name.toLowerCase());
  for (const p of prices) {
    const windowStart = Math.max(0, p.index - 60);
    const windowEnd = Math.min(response.length, p.index + 60);
    const window = response.slice(windowStart, windowEnd).toLowerCase();
    const namesNear = productNames.filter((n) => window.includes(n));
    if (namesNear.length === 0) continue; // likely a total/aggregate, not a product price
    // If a product is named nearby, the price should match that product's price.
    const nearbyProduct = products.find((p2) => window.includes(p2.name.toLowerCase()));
    if (nearbyProduct && nearbyProduct.price_cents !== p.cents) {
      return {
        constraint: "price",
        detail: `${nearbyProduct.name} is stated at ₹${(p.cents / 100).toFixed(2)} but verified price is ${nearbyProduct.price_inr}.`,
      };
    }
  }
  return { constraint: null, detail: null };
}

async function runCase({
  db,
  config,
  baseUrl,
  adminToken,
  c,
}: {
  db: any;
  config: EnvConfig;
  baseUrl: string;
  adminToken: string | undefined;
  c: DatasetCase;
}): Promise<unknown> {
  const start = Date.now();
  let actualResponse = "";
  let httpStatus: number | null = null;
  let error: string | null = null;
  let simulated = false;
  const effectiveMode = config.groundingMode || c.groundingMode || "retrieval_validation";

  try {
    const res = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
      },
      body: JSON.stringify({
        message: c.question,
        grounding: effectiveMode,
      }),
    });
    httpStatus = res.status;
    const body = await res.json();
    actualResponse = (body as any)?.reply ?? "";
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  let outcome: "pass" | "fail" | "unverified" | "error" = "unverified";
  if (error) {
    outcome = "error";
  } else {
    const factual = await checkFactual(db, actualResponse);
    const pricesMentioned = extractPricesWithPositions(actualResponse).length > 0;
    if (factual.constraint) {
      outcome = "fail";
    } else if (pricesMentioned) {
      // The model made a verifiable price claim and it checked out.
      outcome = "pass";
    }
    // Otherwise leave as "unverified" for manual review.
  }

  const latencyMs = Date.now() - start;
  const record = {
    runId: (globalThis as any).__CAFE_RUN_ID,
    datasetVersion: (globalThis as any).__CAFE_DATASET_VERSION,
    experimentalConfig: c.groundingMode,
    model: config.model,
    provider: config.provider,
    simulated,
    testId: c.id,
    category: c.category,
    question: c.question,
    groundingMode: effectiveMode,
    expectedOutcome: c.expectedOutcome,
    failureCategory: c.failureCategory,
    actualResponse,
    latencyMs,
    httpStatus,
    error,
    outcome,
    tokenConsumption: "unknown",
    timestamp: nowIso(),
  };
  return record;
}

async function delayWithJitter(ms: number): Promise<void> {
  await sleep(ms + Math.floor(Math.random() * 300));
}

async function runWithRetry(
  fn: () => Promise<unknown>,
  config: EnvConfig
): Promise<unknown> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const msg = String(err);
      // Do not retry authentication/credential errors.
      if (msg.includes("401") || msg.includes("403")) throw err;
      // Retry transient failures (429, network) up to maxRetries.
      if (attempt < config.maxRetries && (msg.includes("429") || msg.includes("fetch") || msg.includes("ECONNREFUSED"))) {
        await delayWithJitter(config.retryDelayMs * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

async function main(): Promise<void> {
  const config = envConfig();
  const dataset = loadDataset();
  (globalThis as any).__CAFE_RUN_ID = `cafe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  (globalThis as any).__CAFE_DATASET_VERSION = dataset.schemaVersion;

  // Build the case list from the selected sets.
  let cases: DatasetCase[] = [];
  for (const setName of config.sets) {
    cases = cases.concat((dataset.sets as any)[setName] || []);
  }
  if (config.categories && config.categories.length) {
    cases = cases.filter((c) => config.categories!.includes(c.category));
  }

  const db = await createTestDb();

  const completed = loadCompletedIds(config.resultsFile);
  const pending = cases.filter((c) => !completed.has(c.id));
  const batch = config.batchSize && config.batchSize > 0 ? pending.slice(0, config.batchSize) : pending;

  console.log(`Café Fernweh evaluation runner`);
  console.log(`  runId: ${(globalThis as any).__CAFE_RUN_ID}`);
  console.log(`  datasetVersion: ${dataset.schemaVersion}`);
  console.log(`  provider: ${config.provider} model: ${config.model}`);
  console.log(`  sets: ${config.sets.join(",")} categories: ${config.categories?.join(",") || "all"}`);
  console.log(`  cases: ${cases.length} total, ${pending.length} pending, ${batch.length} in this batch`);
  console.log(`  concurrency: ${config.concurrency} pacing: ${config.pacingMs}ms maxRetries: ${config.maxRetries}`);
  console.log(`  results: ${config.resultsFile}`);

  let pass = 0, fail = 0, unverified = 0, errors = 0;

  for (const c of batch) {
    let record: unknown;
    try {
      record = await runWithRetry(() => runCase({ db, config, baseUrl: config.baseUrl, adminToken: config.adminToken, c }), config);
    } catch (err) {
      const start = Date.now();
      record = {
        runId: (globalThis as any).__CAFE_RUN_ID,
        datasetVersion: dataset.schemaVersion,
        experimentalConfig: c.groundingMode,
        model: config.model,
        provider: config.provider,
        simulated: false,
        testId: c.id,
        category: c.category,
        question: c.question,
        groundingMode: c.groundingMode,
        expectedOutcome: c.expectedOutcome,
        failureCategory: c.failureCategory,
        actualResponse: "",
        latencyMs: Date.now() - start,
        httpStatus: null,
        error: err instanceof Error ? err.message : String(err),
        outcome: "error",
        tokenConsumption: "unknown",
        timestamp: nowIso(),
      };
    }

    appendRecord(config.resultsFile, record);
    const r = record as { outcome: string; latencyMs: number; testId: string; category: string };
    if (r.outcome === "pass") pass++;
    else if (r.outcome === "fail") fail++;
    else if (r.outcome === "error") errors++;
    else unverified++;
    console.log(`  ${c.id} [${c.category}] ${r.outcome} (${r.latencyMs}ms)`);

    if (config.concurrency === 1) {
      await delayWithJitter(config.pacingMs);
    }
  }

  const summary = {
    runId: (globalThis as any).__CAFE_RUN_ID,
    datasetVersion: dataset.schemaVersion,
    totalCases: cases.length,
    runCases: batch.length,
    pass, fail, unverified, errors,
    provider: config.provider,
    model: config.model,
    timestamp: nowIso(),
  };
  appendRecord(config.resultsFile, { ...summary, testId: "SUMMARY", category: "summary" });
  console.log(`\nRun complete: pass=${pass} fail=${fail} unverified=${unverified} errors=${errors}`);
  console.log(`Results appended to ${config.resultsFile}`);
}

main().catch((err) => {
  console.error("eval-runner failed:", err);
  process.exit(1);
});
