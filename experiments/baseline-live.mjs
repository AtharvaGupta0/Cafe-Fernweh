/**
 * experiments/baseline-live.mjs
 *
 * Runs the experimental dataset against the LIVE Worker under Configuration A
 * (model without menu grounding) using genuine Gemini inference.
 *
 * Requires:
 *  - Worker running locally on http://127.0.0.1:8787
 *  - DEV_ADMIN_TOKEN set (so grounding="none" is honoured)
 *  - AI_PROVIDER=gemini with a valid GEMINI_API_KEY
 *
 * Writes one JSONL record per case to experiments/baseline-results.jsonl.
 * Does not overwrite previous results (appends).
 */

import { readFileSync } from "fs";

const BASE = "http://127.0.0.1:8787";
const ADMIN_TOKEN = "verify-configs"; // temporary local test token; not committed

const DATASET = JSON.parse(readFileSync(new URL("eval-dataset.json", import.meta.url), "utf8"));

// Representative Config A cases: ungrounded model is prone to hallucination,
// invented prices/ingredients, overconfidence and unsupported claims.
const CASE_IDS = [
  "EVAL-001", // invented product
  "EVAL-002", // incorrect price
  "EVAL-003", // unknown allergen
  "EVAL-004", // dietary restriction
  "EVAL-006", // unavailable items
  "EVAL-007", // unsupported sales claim
  "EVAL-010", // prompt injection
  "EVAL-011", // equivalent re-wording
  "EVAL-012", // equivalent re-wording
];

const cases = DATASET.cases.filter((c) => CASE_IDS.includes(c.id));
const OUT = new URL("baseline-results.jsonl", import.meta.url);

const { appendFileSync } = await import("fs");

function nowIso() {
  return new Date().toISOString();
}

async function run() {
  for (const c of cases) {
    const start = Date.now();
    let actualResponse = "";
    let status = null;
    let error = null;

    try {
      const res = await fetch(`${BASE}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ADMIN_TOKEN}`,
        },
        body: JSON.stringify({
          message: c.question,
          grounding: "none", // Configuration A: model without menu grounding
        }),
      });
      status = res.status;
      const body = await res.json();
      actualResponse = body.reply || "";
    } catch (err) {
      error = String(err.message ?? err);
    }

    const latencyMs = Date.now() - start;

    const record = {
      experimentId: "CAFE-FERNWEH-BASELINE-2026",
      testId: c.id,
      category: c.category,
      question: c.question,
      groundingMode: "none",
      experimentalConfig: "A - model without menu grounding",
      model: "gemini-3.5-flash-lite",
      provider: "gemini",
      simulated: false,
      datasetVersion: DATASET.schemaVersion,
      promptVersion: "sprint-1-system-prompt-v1",
      timestamp: nowIso(),
      generationParameters: { temperature: 0.3, maxOutputTokens: 800 },
      expectedOutcome: c.expectedOutcome,
      actualResponse,
      latencyMs,
      httpStatus: status,
      error,
      failureCategory: c.failureCategory,
      tokenConsumption: "unknown",
    };

    appendFileSync(OUT, JSON.stringify(record) + "\n");
    // eslint-disable-next-line no-console
    console.log(`${c.id} [${c.category}] status=${status} latency=${latencyMs}ms`);
  }
  // eslint-disable-next-line no-console
  console.log(`Baseline results appended to ${OUT}`);
}

await run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("baseline failed:", err);
  process.exit(1);
});
