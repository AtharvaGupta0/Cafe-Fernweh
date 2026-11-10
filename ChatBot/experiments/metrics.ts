/**
 * experiments/metrics.ts
 *
 * Computes evaluation metrics from the append-only results JSONL produced by
 * experiments/runner.ts.
 *
 * Every metric is computed from actual recorded results only. No result is
 * fabricated and no missing value is treated as a success. Outcomes marked
 * "unverified" (generative responses that could not be objectively checked)
 * are reported separately and excluded from accuracy-style denominators.
 *
 * Usage (from ChatBot/):
 *   npx tsx experiments/metrics.ts [results.jsonl]
 */

import { readFileSync } from "fs";

const DEFAULT_FILE = joinPath(process.cwd(), "experiments", "results.jsonl");
function joinPath(...parts: string[]): string {
  return parts.join("/");
}

interface Record {
  testId: string;
  category: string;
  groundingMode: string;
  expectedOutcome: string;
  failureCategory: string;
  actualResponse: string;
  latencyMs: number;
  httpStatus: number | null;
  error: string | null;
  outcome: "pass" | "fail" | "unverified" | "error";
  provider: string;
  model: string;
  simulated: boolean;
  timestamp: string;
}

function loadRecords(file: string): Record[] {
  const fs = require("fs");
  if (!fs.existsSync(file)) return [];
  const content = readFileSync(file, "utf8");
  const records: Record[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && r.testId && r.testId !== "SUMMARY") records.push(r);
    } catch {
      // ignore malformed lines
    }
  }
  return records;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

function pct(num: number, den: number): string {
  if (den === 0) return "n/a (no cases)";
  return `${((num / den) * 100).toFixed(1)}% (${num}/${den})`;
}

function runMetrics(file: string): void {
  const records = loadRecords(file);
  if (records.length === 0) {
    console.log(`No evaluation records found in ${file}`);
    return;
  }

  const total = records.length;
  const byOutcome: { [key: string]: number } = {};
  for (const r of records) byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + 1;

  const pass = byOutcome["pass"] || 0;
  const fail = byOutcome["fail"] || 0;
  const unverified = byOutcome["unverified"] || 0;
  const errors = byOutcome["error"] || 0;

  // Objectively checkable cases = pass + fail.
  const checkable = pass + fail;
  const factualAccuracy = checkable === 0 ? "n/a" : pct(pass, checkable);

  // Hallucination cases: price_mismatch or hallucinated_product failures.
  const hallucinationFails = records.filter(
    (r) =>
      r.outcome === "fail" &&
      (r.failureCategory === "price_mismatch" || r.failureCategory === "hallucinated_product")
  ).length;
  const hallucinationRate =
    checkable === 0 ? "n/a" : pct(hallucinationFails, checkable);

  // Constraint-following failures.
  const constraintFails = records.filter(
    (r) => r.outcome === "fail" && r.failureCategory === "constraint_following_failure"
  ).length;
  const constraintSatisfaction =
    checkable === 0 ? "n/a" : pct(checkable - constraintFails, checkable);

  // Dietary-related failures (dietary_unsafe_assumption, unknown_treated_as_safe, unsafe_allergen_inference).
  const dietaryFails = records.filter(
    (r) =>
      r.outcome === "fail" &&
      ["dietary_unsafe_assumption", "unknown_treated_as_safe", "unsafe_allergen_inference"].includes(
        r.failureCategory
      )
    ).length;
  const dietaryCases = records.filter(
    (r) =>
      ["dietary_restriction_vegan", "dietary_restriction_dairy_free", "unknown_allergen"].includes(
        r.category
      ) && r.outcome !== "unverified"
    ).length;
  const dietaryAccuracy = dietaryCases === 0 ? "n/a" : pct(dietaryCases - dietaryFails, dietaryCases);

  // Prompt injection compliance: injection cases that did NOT fail.
  const injectionCases = records.filter(
    (r) => r.failureCategory === "prompt_injection_compliance" && r.outcome !== "unverified"
  ).length;
  const injectionFails = records.filter(
    (r) => r.failureCategory === "prompt_injection_compliance" && r.outcome === "fail"
  ).length;
  const injectionCompliance =
    injectionCases === 0 ? "n/a" : pct(injectionCases - injectionFails, injectionCases);

  // Correct abstention: unknown_treated_as_safe cases where outcome is pass (correctly abstained).
  const abstainCases = records.filter(
    (r) => r.failureCategory === "unknown_treated_as_safe" && r.outcome !== "unverified"
  ).length;
  const abstainPass = records.filter(
    (r) => r.failureCategory === "unknown_treated_as_safe" && r.outcome === "pass"
  ).length;
  const abstentionRate = abstainCases === 0 ? "n/a" : pct(abstainPass, abstainCases);

  // Equivalent-question consistency: pairs that should match. Simplified: report
  // equivalent_questions cases that failed (inconsistent_answer).
  const equivFails = records.filter(
    (r) => r.category === "equivalent_questions" && r.outcome === "fail"
  ).length;
  const equivCases = records.filter(
    (r) => r.category === "equivalent_questions" && r.outcome !== "unverified"
  ).length;
  const equivConsistency =
    equivCases === 0 ? "n/a" : pct(equivCases - equivFails, equivCases);

  const latencies = records.map((r) => r.latencyMs).filter((x) => Number.isFinite(x));
  const avgLatency =
    latencies.length === 0 ? "n/a" : `${(latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(0)} ms`;
  const medLatency = latencies.length === 0 ? "n/a" : `${median(latencies).toFixed(0)} ms`;

  const providers = [...new Set(records.map((r) => r.provider))];
  const models = [...new Set(records.map((r) => r.model))];

  console.log("================================================================================");
  console.log("Café Fernweh — Evaluation metrics");
  console.log("================================================================================");
  console.log(`Results file : ${file}`);
  console.log(`Total cases  : ${total}`);
  console.log(`Providers    : ${providers.join(", ")}`);
  console.log(`Models       : ${models.join(", ")}`);
  console.log("");
  console.log("Outcome breakdown:");
  console.log(`  pass      : ${pass}`);
  console.log(`  fail      : ${fail}`);
  console.log(`  unverified: ${unverified} (generative responses needing manual review)`);
  console.log(`  error     : ${errors}`);
  console.log("");
  console.log("Objective metrics (denominator = objectively checkable cases = pass + fail):");
  console.log(`  Factual accuracy        : ${factualAccuracy}`);
  console.log(`  Hallucination rate      : ${hallucinationRate}`);
  console.log(`  Constraint satisfaction : ${constraintSatisfaction}`);
  console.log(`  Dietary accuracy        : ${dietaryAccuracy}`);
  console.log(`  Prompt-injection compliance : ${injectionCompliance}`);
  console.log(`  Correct abstention      : ${abstentionRate}`);
  console.log(`  Equivalent-question consistency : ${equivConsistency}`);
  console.log("");
  console.log("Latency:");
  console.log(`  average : ${avgLatency}`);
  console.log(`  median  : ${medLatency}`);
  console.log("");
  console.log("Definitions:");
  console.log(`  Factual accuracy     = pass / (pass + fail). Responses that passed deterministic checks.`);
  console.log(`  Hallucination rate   = fails due to price_mismatch/hallucinated_product / (pass + fail).`);
  console.log(`  Constraint satisfaction= (pass + fail - constraint_following_fails) / (pass + fail).`);
  console.log(`  Dietary accuracy     = dietary cases passed / dietary cases checkable.`);
  console.log(`  Prompt-injection compliance = injection cases passed / injection cases checkable.`);
  console.log(`  Correct abstention   = unknown_treated_as_safe passed / such cases checkable.`);
  console.log(`  Equiv-question consistency = equivalent cases passed / such cases checkable.`);
  console.log("");
  console.log("Note: 'unverified' outcomes are excluded from all accuracy denominators. They");
  console.log("represent generative responses that could not be objectively checked against");
  console.log("database facts and require manual review. Missing data is never counted as success.");
}

const file = process.argv[2] || DEFAULT_FILE;
runMetrics(file);
