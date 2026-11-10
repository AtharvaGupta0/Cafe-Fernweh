/**
 * experiments/runner.ts
 *
 * Quota-conscious, resumable evaluation runner for the Café Fernweh AI
 * behaviour study.
 *
 * Runs the experimental dataset (experiments/eval-dataset.json) against the
 * live Worker (genuine Gemini inference) or the demo provider, recording one
 * append-only JSONL record per case. A run manifest records the dataset
 * version, requested configuration, server-reported model/prompt version,
 * generation parameters and database snapshot before any case is run.
 *
 * Validity rules:
 *   - A, B and C require a valid DEV_ADMIN_TOKEN (EVAL_ADMIN_TOKEN) because
 *     the server must not silently downgrade an experimental request to D.
 *   - Each record stores both the requested mode and the mode the server
 *     actually used. A mismatch invalidates the record.
 *   - Demo-provider output is marked simulated and invalid as model evidence.
 *   - The two-turn follow-up case is actually sent as two turns.
 *   - Resumption is keyed by test ID + configuration, not test ID alone.
 *
 * Usage (from ChatBot/):
 *   EVAL_CONFIG=A EVAL_ADMIN_TOKEN=... npx tsx experiments/runner.ts
 *
 * Environment variables:
 *   EVAL_BASE_URL        Worker base URL (default http://127.0.0.1:8787)
 *   EVAL_CONFIG          A|B|C|D (preferred; default D)
 *   EVAL_GROUNDING_MODE  raw mode (legacy alternative to EVAL_CONFIG)
 *   EVAL_ADMIN_TOKEN     dev token required for A/B/C and for provenance checks
 *   EVAL_PROVIDER        gemini|demo (default gemini)
 *   EVAL_MODEL           expected model identifier (default gemini-3.5-flash-lite)
 *   EVAL_SETS            comma-separated sets: dev,heldOut (default dev)
 *   EVAL_CATEGORIES      comma-separated category filter (default all)
 *   EVAL_BATCH_SIZE      cases per run (default 0 = all remaining)
 *   EVAL_PACING_MS       ms between requests (default 1000)
 *   EVAL_MAX_RETRIES     bounded retries for transient failures (default 3)
 *   EVAL_RETRY_DELAY_MS  base retry delay (default 5000)
 *   EVAL_MAX_CONSECUTIVE_ERRORS  abort after this many consecutive errors (default 2)
 *   EVAL_RESULTS_FILE    output JSONL (default experiments/live-results.jsonl)
 */

import { readFileSync, existsSync, appendFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { createTestDb } from "../tests/helpers";
import { searchProducts, getSalesStats } from "../src/server/lib/menu";
import {
  EVAL_CONFIGS,
  groundingModeSchema,
  type GroundingMode,
} from "../src/shared/schema";

const ROOT = join(__dirname, "..");
const DATASET_PATH = join(ROOT, "experiments", "eval-dataset.json");
const DEFAULT_RESULTS = join(ROOT, "experiments", "live-results.jsonl");

type ConfigId = keyof typeof EVAL_CONFIGS;

const MODE_TO_CONFIG: Record<GroundingMode, ConfigId> = {
  none: "A",
  menu_context: "B",
  retrieval: "C",
  retrieval_validation: "D",
};

interface EnvConfig {
  baseUrl: string;
  adminToken: string | undefined;
  model: string;
  provider: "gemini" | "demo";
  sets: string[];
  categories: string[] | null;
  batchSize: number;
  pacingMs: number;
  maxRetries: number;
  retryDelayMs: number;
  maxConsecutiveErrors: number;
  resultsFile: string;
  configId: ConfigId;
  mode: GroundingMode;
}

function resolveRequestedConfig(): { configId: ConfigId; mode: GroundingMode } {
  const rawId = process.env.EVAL_CONFIG?.trim().toUpperCase();
  const rawMode = process.env.EVAL_GROUNDING_MODE?.trim();
  if (rawId && rawMode) {
    throw new Error("Set either EVAL_CONFIG or EVAL_GROUNDING_MODE, not both.");
  }
  if (rawId) {
    if (!(rawId in EVAL_CONFIGS)) {
      throw new Error(`EVAL_CONFIG must be one of A, B, C, D (got ${rawId}).`);
    }
    const configId = rawId as ConfigId;
    return { configId, mode: EVAL_CONFIGS[configId].mode };
  }
  if (rawMode) {
    const parsed = groundingModeSchema.safeParse(rawMode);
    if (!parsed.success) {
      throw new Error(
        `EVAL_GROUNDING_MODE must be one of ${groundingModeSchema.options.join(", ")}.`
      );
    }
    return { configId: MODE_TO_CONFIG[parsed.data], mode: parsed.data };
  }
  // Default to the production configuration, but record that choice
  // explicitly in every result row.
  return { configId: "D", mode: EVAL_CONFIGS.D.mode };
}

function envConfig(): EnvConfig {
  const rawSets = process.env.EVAL_SETS || "dev";
  const provider = (process.env.EVAL_PROVIDER || "gemini") as "gemini" | "demo";
  if (provider !== "gemini" && provider !== "demo") {
    throw new Error("EVAL_PROVIDER must be gemini or demo.");
  }
  const requested = resolveRequestedConfig();
  return {
    baseUrl: process.env.EVAL_BASE_URL || "http://127.0.0.1:8787",
    adminToken: process.env.EVAL_ADMIN_TOKEN || undefined,
    model: process.env.EVAL_MODEL || "gemini-3.5-flash-lite",
    provider,
    sets: rawSets.split(",").map((s) => s.trim()).filter(Boolean),
    categories: process.env.EVAL_CATEGORIES
      ? process.env.EVAL_CATEGORIES.split(",").map((s) => s.trim()).filter(Boolean)
      : null,
    batchSize: Number(process.env.EVAL_BATCH_SIZE || 0),
    pacingMs: Number(process.env.EVAL_PACING_MS || 1000),
    maxRetries: Math.max(0, Number(process.env.EVAL_MAX_RETRIES ?? 3)),
    retryDelayMs: Number(process.env.EVAL_RETRY_DELAY_MS || 5000),
    maxConsecutiveErrors: Math.max(1, Number(process.env.EVAL_MAX_CONSECUTIVE_ERRORS || 2)),
    resultsFile: process.env.EVAL_RESULTS_FILE || DEFAULT_RESULTS,
    configId: requested.configId,
    mode: requested.mode,
  };
}

interface DatasetCase {
  id: string;
  category: string;
  question: string;
  groundingMode: string;
  expectedOutcome: string;
  failureCategory: string;
  precedingQuestion?: string;
  questionPart?: string;
  setName?: string;
}

interface Dataset {
  schemaVersion: string;
  model: { provider: string; candidate: string; configuredVia: string };
  sets: { dev: DatasetCase[]; heldOut: DatasetCase[] };
}

interface ServerStatus {
  ok: boolean;
  prompt_version: string;
  provider: string;
  model: string;
  generation_parameters: { temperature: number; maxOutputTokens: number } | null;
  modes: string[];
}

function loadDataset(): Dataset {
  const raw = JSON.parse(readFileSync(DATASET_PATH, "utf8")) as Dataset;
  if (!raw.sets && Array.isArray((raw as any).cases)) {
    return { ...raw, sets: { dev: (raw as any).cases, heldOut: [] } };
  }
  return raw;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function delayWithJitter(ms: number): Promise<void> {
  await sleep(ms + Math.floor(Math.random() * 300));
}

/**
 * Load test IDs that already have a valid, non-error record for the selected
 * configuration. Resumption must not be keyed by test ID alone: the same case
 * is deliberately run under A, B, C and D.
 */
function loadCompletedIds(resultsFile: string, configId: ConfigId): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(resultsFile)) return ids;
  for (const line of readFileSync(resultsFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (!rec?.testId) continue;
      if (["SUMMARY", "MANIFEST", "ABORT"].includes(rec.testId)) continue;
      const sameConfig = rec.experimentalConfig === configId;
      const usable =
        rec.valid !== false &&
        rec.simulated !== true &&
        rec.outcome !== "error" &&
        rec.httpStatus === 200 &&
        !rec.error;
      if (sameConfig && usable) ids.add(rec.testId);
    } catch {
      // ignore malformed lines; they are not evidence
    }
  }
  return ids;
}

function appendRecord(resultsFile: string, record: unknown): void {
  appendFileSync(resultsFile, JSON.stringify(record) + "\n");
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function extractPricesWithPositions(text: string): Array<{ cents: number; index: number }> {
  const prices: Array<{ cents: number; index: number }> = [];
  const re = /₹\s*(\d+(?:\.\d{1,2})?)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const cap = match[1];
    if (!cap) continue;
    prices.push({ cents: Math.round(parseFloat(cap) * 100), index: match.index });
  }
  return prices;
}

/**
 * Deterministic check of product prices. Prices immediately preceded by a
 * negation ("not ₹5", "not ₹5.00") are treated as refuted premises, not
 * product claims. Aggregates are ignored because they are not product prices.
 */
async function checkFactual(
  db: any,
  response: string
): Promise<{ constraint: string | null; detail: string | null }> {
  const prices = extractPricesWithPositions(response);
  if (prices.length === 0) return { constraint: null, detail: null };
  const products = await searchProducts(db, { query: "", limit: 200 });

  // Find the product name whose occurrence is closest to the price mention,
  // so a price is validated against the product it actually describes.
  function nearestProduct(textLower: string, priceIndex: number): { product: typeof products[number]; distance: number } | null {
    let best: { product: typeof products[number]; distance: number } | null = null;
    for (const p of products) {
      const name = p.name.toLowerCase();
      let idx = textLower.indexOf(name);
      while (idx !== -1) {
        const distance = Math.abs(idx - priceIndex);
        if (!best || distance < best.distance) {
          best = { product: p, distance };
        }
        idx = textLower.indexOf(name, idx + 1);
      }
    }
    return best;
  }

  const lower = response.toLowerCase();
  for (const price of prices) {
    const before = response.slice(Math.max(0, price.index - 20), price.index).toLowerCase();
    if (/\b(not|isn't|isnt|never|rather than|instead of)\s*$/.test(before)) continue;
    const nearest = nearestProduct(lower, price.index);
    if (!nearest) continue;
    if (nearest.product.price_cents !== price.cents) {
      return {
        constraint: "price",
        detail: `${nearest.product.name} is stated at ₹${(price.cents / 100).toFixed(2)} but verified price is ${nearest.product.price_inr}.`,
      };
    }
  }
  return { constraint: null, detail: null };
}

/** Category-specific deterministic checks where the expected answer is explicit. */
async function checkConstraint(
  db: any,
  c: DatasetCase,
  response: string
): Promise<{ constraint: string | null; detail: string | null }> {
  const lower = response.toLowerCase();
  if (c.category === "follow_up_context") {
    if (!lower.includes("cold brew") || lower.includes("masala chai")) {
      return {
        constraint: "constraint_following_failure",
        detail:
          "Follow-up reply did not preserve the cold-coffee constraint (expected Cold Brew, not Masala Chai).",
      };
    }
  }
  if (c.category === "fabricated_sales_statistic") {
    const stats = (await getSalesStats(db)) as { total_transactions?: number };
    const match = response.match(/(\d[\d,]*)\s+transactions?/i);
    if (match) {
      const stated = Number(match[1]!.replace(/,/g, ""));
      if (Number.isFinite(stated) && stated !== Number(stats.total_transactions ?? -1)) {
        return {
          constraint: "unsupported_sales_claim",
          detail: `Stated ${stated} transactions but recorded total is ${stats.total_transactions}.`,
        };
      }
    }
  }
  return { constraint: null, detail: null };
}

interface ChatTurn {
  status: number | null;
  body: {
    reply?: string;
    grounding_mode?: string;
    prompt_version?: string;
    conversation_id?: string;
    used_tools?: string[];
  } | null;
  error: string | null;
  attempts: number;
  latencyMs: number;
}

/**
 * POST /chat with bounded retries for transient failures. Authentication and
 * validation failures are never retried. Quota exhaustion returns a clear
 * error after the configured retry budget rather than looping.
 */
async function postChat({
  config,
  message,
  grounding,
  conversationId,
}: {
  config: EnvConfig;
  message: string;
  grounding: string;
  conversationId?: string;
}): Promise<ChatTurn> {
  const start = Date.now();
  let lastError = "Request failed.";
  let attempts = 0;
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    attempts += 1;
    try {
      const res = await fetch(`${config.baseUrl}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.adminToken ? { Authorization: `Bearer ${config.adminToken}` } : {}),
        },
        body: JSON.stringify({
          message,
          grounding,
          ...(conversationId ? { conversation_id: conversationId } : {}),
        }),
      });
      const text = await res.text();
      let body: ChatTurn["body"] = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      if ([408, 429, 500, 502, 503, 504].includes(res.status) && attempt < config.maxRetries) {
        lastError = `HTTP ${res.status}`;
        await delayWithJitter(config.retryDelayMs * (attempt + 1));
        continue;
      }
      return {
        status: res.status,
        body,
        error: res.ok ? null : `HTTP ${res.status}`,
        attempts,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < config.maxRetries) {
        await delayWithJitter(config.retryDelayMs * (attempt + 1));
        continue;
      }
    }
  }
  return {
    status: null,
    body: null,
    error: lastError,
    attempts,
    latencyMs: Date.now() - start,
  };
}

/**
 * Verify the evaluation configuration without spending model quota. The
 * endpoint is protected by DEV_ADMIN_TOKEN and reports the server's actual
 * provider/model/prompt version. A mismatch invalidates the run.
 */
async function preflight(config: EnvConfig): Promise<ServerStatus> {
  const syntheticDemo: ServerStatus = {
    ok: true,
    prompt_version: "demo-provider",
    provider: "demo",
    model: config.model,
    generation_parameters: null,
    modes: groundingModeSchema.options,
  };
  if (config.provider === "demo" && config.mode === "retrieval_validation" && !config.adminToken) {
    return syntheticDemo;
  }
  if (!config.adminToken) {
    throw new Error(
      "EVAL_ADMIN_TOKEN is required for a live evaluation run (and for any non-D configuration)."
    );
  }
  const res = await fetch(`${config.baseUrl}/eval/status`, {
    headers: { Authorization: `Bearer ${config.adminToken}` },
  });
  if (!res.ok) {
    throw new Error(
      `Evaluation preflight failed with HTTP ${res.status}. Is DEV_ADMIN_TOKEN configured on the Worker?`
    );
  }
  const body = (await res.json()) as ServerStatus;
  if (!body.ok || !Array.isArray(body.modes) || !body.modes.includes(config.mode)) {
    throw new Error(`The server does not offer grounding mode "${config.mode}".`);
  }
  if (body.provider !== config.provider) {
    throw new Error(
      `Provider mismatch: runner expects ${config.provider}, server reports ${body.provider}.`
    );
  }
  return body;
}

async function snapshotDb(db: any): Promise<Record<string, unknown>> {
  const products = await searchProducts(db, { query: "", limit: 500 });
  const stats = (await getSalesStats(db)) as {
    total_transactions?: number;
    total_revenue_inr?: string;
    average_order_value_inr?: string;
  };
  const fingerprint = sha256(
    JSON.stringify(
      products.map((p) => ({
        id: p.id,
        name: p.name,
        price_cents: p.price_cents,
        available: p.available,
        dietary_classification: p.dietary_classification,
      }))
    )
  );
  return {
    product_count: products.length,
    product_fingerprint: fingerprint,
    transaction_count: stats.total_transactions ?? null,
    total_revenue_inr: stats.total_revenue_inr ?? null,
    average_order_value_inr: stats.average_order_value_inr ?? null,
  };
}

interface CaseArgs {
  db: any;
  config: EnvConfig;
  serverStatus: ServerStatus;
  c: DatasetCase;
}

async function runCase({ db, config, serverStatus, c }: CaseArgs): Promise<Record<string, unknown>> {
  const start = Date.now();
  const requested = config.mode;
  const simulated = config.provider === "demo" || serverStatus.provider === "demo";
  let precedingResponse: string | null = null;
  let precedingStatus: number | null = null;
  let precedingGrounding: string | null = null;
  let conversationId: string | undefined;
  let turn: ChatTurn;

  if (c.precedingQuestion) {
    const first = await postChat({
      config,
      message: c.precedingQuestion,
      grounding: requested,
    });
    precedingResponse = first.body?.reply ?? null;
    precedingStatus = first.status;
    precedingGrounding = first.body?.grounding_mode ?? null;
    conversationId = first.body?.conversation_id;
    if (first.error || first.status !== 200 || !first.body?.reply || !conversationId) {
      return buildRecord({
        c,
        config,
        serverStatus,
        simulated,
        requested,
        returned: precedingGrounding,
        actualResponse: precedingResponse ?? "",
        precedingResponse,
        precedingStatus,
        precedingGrounding,
        promptVersion: first.body?.prompt_version ?? null,
        httpStatus: first.status,
        error: first.error ?? "Follow-up setup turn did not return a reply/conversation_id.",
        attempts: first.attempts,
        latencyMs: Date.now() - start,
        valid: false,
        validityReason: "Follow-up setup turn failed; the case cannot test context retention.",
        outcome: "error",
      });
    }
    turn = await postChat({
      config,
      message: c.question,
      grounding: requested,
      conversationId,
    });
  } else {
    turn = await postChat({ config, message: c.question, grounding: requested });
  }

  const returned = turn.body?.grounding_mode ?? null;
  const promptVersion = turn.body?.prompt_version ?? null;
  const actualResponse = turn.body?.reply ?? "";

  let valid = true;
  let validityReason: string | null = null;
  if (turn.error) {
    valid = false;
    validityReason = turn.error;
  } else if (turn.status !== 200) {
    valid = false;
    validityReason = `HTTP ${turn.status}`;
  } else if (!actualResponse) {
    valid = false;
    validityReason = "Server returned an empty reply.";
  } else if (returned !== requested) {
    valid = false;
    validityReason = `Server used grounding mode ${String(returned)}, requested ${requested}.`;
  } else if (!promptVersion) {
    valid = false;
    validityReason = "Server did not report prompt_version.";
  } else if (c.precedingQuestion && precedingGrounding !== requested) {
    valid = false;
    validityReason = `Follow-up setup used grounding mode ${String(precedingGrounding)}, requested ${requested}.`;
  } else if (simulated) {
    valid = false;
    validityReason = "Demo provider output is tooling evidence, not a genuine model trial.";
  }

  let outcome: "pass" | "fail" | "unverified" | "error" = valid ? "unverified" : simulated ? "unverified" : "error";
  if (valid) {
    const factual = await checkFactual(db, actualResponse);
    const constraint = await checkConstraint(db, c, actualResponse);
    const failure = factual.constraint ? factual : constraint;
    if (failure.constraint) {
      outcome = "fail";
    } else if (extractPricesWithPositions(actualResponse).length > 0) {
      outcome = "pass";
    }
  }

  return buildRecord({
    c,
    config,
    serverStatus,
    simulated,
    requested,
    returned,
    actualResponse,
    precedingResponse,
    precedingStatus,
    precedingGrounding,
    promptVersion,
    httpStatus: turn.status,
    error: turn.error,
    attempts: turn.attempts,
    latencyMs: Date.now() - start,
    valid,
    validityReason,
    outcome,
  });
}

function buildRecord({
  c,
  config,
  serverStatus,
  simulated,
  requested,
  returned,
  actualResponse,
  precedingResponse,
  precedingStatus,
  precedingGrounding,
  promptVersion,
  httpStatus,
  error,
  attempts,
  latencyMs,
  valid,
  validityReason,
  outcome,
}: {
  c: DatasetCase;
  config: EnvConfig;
  serverStatus: ServerStatus;
  simulated: boolean;
  requested: string;
  returned: string | null;
  actualResponse: string;
  precedingResponse?: string | null;
  precedingStatus?: number | null;
  precedingGrounding?: string | null;
  promptVersion: string | null;
  httpStatus: number | null;
  error: string | null;
  attempts: number;
  latencyMs: number;
  valid: boolean;
  validityReason: string | null;
  outcome: "pass" | "fail" | "unverified" | "error";
}): Record<string, unknown> {
  return {
    runId: (globalThis as any).__CAFE_RUN_ID,
    datasetVersion: (globalThis as any).__CAFE_DATASET_VERSION,
    setName: c.setName ?? null,
    experimentalConfig: config.configId,
    model: serverStatus.model,
    provider: serverStatus.provider,
    simulated,
    testId: c.id,
    category: c.category,
    question: c.question,
    precedingQuestion: c.precedingQuestion ?? null,
    precedingResponse: precedingResponse ?? null,
    precedingHttpStatus: precedingStatus ?? null,
    precedingGrounding: precedingGrounding ?? null,
    requestedGrounding: requested,
    groundingMode: requested,
    returnedGrounding: returned,
    promptVersion: promptVersion ?? "unknown",
    generationParameters: serverStatus.generation_parameters,
    expectedOutcome: c.expectedOutcome,
    failureCategory: c.failureCategory,
    actualResponse,
    latencyMs,
    httpStatus,
    error,
    attempts,
    valid,
    validityReason,
    outcome,
    tokenConsumption: "unknown",
    timestamp: nowIso(),
  };
}

async function main(): Promise<void> {
  const config = envConfig();
  const dataset = loadDataset();
  const runId = `cafe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  (globalThis as any).__CAFE_RUN_ID = runId;
  (globalThis as any).__CAFE_DATASET_VERSION = dataset.schemaVersion;

  const serverStatus = await preflight(config);

  let cases: DatasetCase[] = [];
  for (const setName of config.sets) {
    const set = (dataset.sets as Record<string, DatasetCase[]>)[setName];
    if (!set) throw new Error(`Unknown dataset set "${setName}". Use dev and/or heldOut.`);
    cases = cases.concat(set.map((c) => ({ ...c, setName })));
  }
  if (config.categories && config.categories.length) {
    cases = cases.filter((c) => config.categories!.includes(c.category));
  }

  const db = await createTestDb();
  const snapshot = await snapshotDb(db);
  const completed = loadCompletedIds(config.resultsFile, config.configId);
  const pending = cases.filter((c) => !completed.has(c.id));
  const batch = config.batchSize > 0 ? pending.slice(0, config.batchSize) : pending;

  console.log("Café Fernweh evaluation runner");
  console.log(`  runId: ${runId}`);
  console.log(`  datasetVersion: ${dataset.schemaVersion}`);
  console.log(`  config: ${config.configId} (${config.mode})`);
  console.log(`  server: ${serverStatus.provider} model: ${serverStatus.model}`);
  console.log(`  promptVersion: ${serverStatus.prompt_version}`);
  console.log(`  sets: ${config.sets.join(",")} categories: ${config.categories?.join(",") || "all"}`);
  console.log(`  cases: ${cases.length} total, ${completed.size} completed for this config, ${pending.length} pending, ${batch.length} in this batch`);
  console.log(`  sequential execution, pacing ${config.pacingMs}ms, maxRetries ${config.maxRetries}`);
  console.log(`  results: ${config.resultsFile}`);

  appendRecord(config.resultsFile, {
    testId: "MANIFEST",
    category: "manifest",
    runId,
    datasetVersion: dataset.schemaVersion,
    experimentalConfig: config.configId,
    groundingMode: config.mode,
    provider: serverStatus.provider,
    model: serverStatus.model,
    promptVersion: serverStatus.prompt_version,
    generationParameters: serverStatus.generation_parameters,
    simulated: serverStatus.provider === "demo",
    dbSnapshot: snapshot,
    selectedSets: config.sets,
    caseIds: batch.map((c) => c.id),
    timestamp: nowIso(),
  });

  let pass = 0;
  let fail = 0;
  let unverified = 0;
  let errors = 0;
  let validCount = 0;
  let invalidCount = 0;
  let consecutiveErrors = 0;

  for (const c of batch) {
    let record: Record<string, unknown>;
    try {
      record = await runCase({ db, config, serverStatus, c });
    } catch (err) {
      record = {
        runId,
        datasetVersion: dataset.schemaVersion,
        setName: c.setName ?? null,
        experimentalConfig: config.configId,
        model: serverStatus.model,
        provider: serverStatus.provider,
        simulated: serverStatus.provider === "demo",
        testId: c.id,
        category: c.category,
        question: c.question,
        precedingQuestion: c.precedingQuestion ?? null,
        requestedGrounding: config.mode,
        groundingMode: config.mode,
        returnedGrounding: null,
        promptVersion: serverStatus.prompt_version,
        generationParameters: serverStatus.generation_parameters,
        expectedOutcome: c.expectedOutcome,
        failureCategory: c.failureCategory,
        actualResponse: "",
        latencyMs: 0,
        httpStatus: null,
        error: err instanceof Error ? err.message : String(err),
        attempts: 0,
        valid: false,
        validityReason: "Runner exception before a complete record was produced.",
        outcome: "error",
        tokenConsumption: "unknown",
        timestamp: nowIso(),
      };
    }

    appendRecord(config.resultsFile, record);
    const r = record as {
      outcome: string;
      latencyMs: number;
      testId: string;
      category: string;
      valid: boolean;
      validityReason: string | null;
      attempts: number;
    };
    if (r.valid) validCount++;
    else invalidCount++;
    if (r.outcome === "pass") pass++;
    else if (r.outcome === "fail") fail++;
    else if (r.outcome === "error") errors++;
    else unverified++;
    console.log(
      `  ${c.id} [${c.category}] ${r.outcome}${r.valid ? "" : ` (invalid: ${r.validityReason})`} (${r.latencyMs}ms, attempts=${r.attempts})`
    );

    const errored = r.outcome === "error" && !(record as { simulated?: boolean }).simulated;
    consecutiveErrors = errored ? consecutiveErrors + 1 : 0;
    if (consecutiveErrors >= config.maxConsecutiveErrors) {
      appendRecord(config.resultsFile, {
        testId: "ABORT",
        category: "abort",
        runId,
        reason: `Aborted after ${consecutiveErrors} consecutive errors; quota or server availability may be exhausted.`,
        timestamp: nowIso(),
      });
      console.error(
        `Aborting run after ${consecutiveErrors} consecutive errors. Do not retry repeatedly; check quota/server status first.`
      );
      break;
    }

    await delayWithJitter(config.pacingMs);
  }

  const summary = {
    testId: "SUMMARY",
    category: "summary",
    runId,
    datasetVersion: dataset.schemaVersion,
    experimentalConfig: config.configId,
    groundingMode: config.mode,
    totalCases: cases.length,
    runCases: batch.length,
    pass,
    fail,
    unverified,
    errors,
    valid: validCount,
    invalid: invalidCount,
    provider: serverStatus.provider,
    model: serverStatus.model,
    promptVersion: serverStatus.prompt_version,
    timestamp: nowIso(),
  };
  appendRecord(config.resultsFile, summary);
  console.log(
    `\nRun complete: pass=${pass} fail=${fail} unverified=${unverified} errors=${errors} valid=${validCount} invalid=${invalidCount}`
  );
  console.log(`Results appended to ${config.resultsFile}`);
}

main().catch((err) => {
  console.error("eval-runner failed:", err);
  process.exit(1);
});
