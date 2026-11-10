/**
 * experiments/metrics.ts
 *
 * Computes evaluation metrics from the append-only JSONL produced by the
 * evaluation runners.
 *
 * Primary denominators include only records that are:
 *   - genuine (provider is not demo / simulated is not true),
 *   - successfully returned by the API (HTTP 200, no error),
 *   - explicitly marked valid by the corrected runner, and
 *   - returned in the same grounding mode that was requested.
 *
 * Demo output, malformed/mislabelled records, infrastructure errors and
 * records whose provenance cannot be established are reported as exclusions,
 * never counted as successes. Documented legacy records are shown separately.
 *
 * Usage (from ChatBot/):
 *   npx tsx experiments/metrics.ts [results.jsonl ...]
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const DEFAULT_FILE = join(process.cwd(), "experiments", "live-results.jsonl");

interface EvalRecord {
  testId: string;
  category: string;
  failureCategory?: string;
  groundingMode?: string;
  requestedGrounding?: string;
  returnedGrounding?: string | null;
  experimentalConfig?: string;
  promptVersion?: string;
  provider?: string;
  model?: string;
  simulated?: boolean;
  actualResponse?: string;
  latencyMs?: number;
  httpStatus?: number | null;
  error?: string | null;
  outcome?: string;
  valid?: boolean;
  validityReason?: string | null;
  experimentId?: string;
  timestamp?: string;
}

type Bucket =
  | "analyzable"
  | "demo"
  | "invalid"
  | "error"
  | "legacy"
  | "unverified-provenance";

const META_IDS = new Set(["SUMMARY", "MANIFEST", "ABORT"]);

function loadRecords(files: string[]): EvalRecord[] {
  const records: EvalRecord[] = [];
  for (const file of files) {
    if (!existsSync(file)) {
      console.log(`WARNING: results file not found: ${file}`);
      continue;
    }
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec && rec.testId && !META_IDS.has(rec.testId)) {
          // Older legacy records have no outcome field. They are unscored
          // observations, not passes or failures.
          if (!rec.outcome) rec.outcome = "unverified";
          records.push(rec);
        }
      } catch {
        // Malformed lines are ignored; they are not evidence.
      }
    }
  }
  return records;
}

function classify(r: EvalRecord): Bucket {
  if (r.simulated === true || r.provider === "demo" || r.outcome === "demo_unverified") {
    return "demo";
  }
  if (r.experimentId) return "legacy";
  if (r.valid === false) return "invalid";
  if (r.valid === true) {
    if (r.httpStatus !== 200 || r.error) return "error";
    const requested = r.requestedGrounding ?? r.groundingMode;
    if (!r.returnedGrounding || r.returnedGrounding !== requested) return "invalid";
    return "analyzable";
  }
  if (r.outcome === "error" || (r.httpStatus != null && r.httpStatus !== 200) || r.error) {
    return "error";
  }
  return "unverified-provenance";
}

function configOf(r: EvalRecord): string {
  const raw = (r.experimentalConfig ?? "").trim();
  if (/^[ABCD]$/.test(raw)) return raw;
  if (/^A\b/.test(raw)) return "A";
  if (/^B\b/.test(raw)) return "B";
  if (/^C\b/.test(raw)) return "C";
  if (/^D\b/.test(raw)) return "D";
  const mode = r.requestedGrounding ?? r.groundingMode;
  if (mode === "none") return "A";
  if (mode === "menu_context") return "B";
  if (mode === "retrieval") return "C";
  if (mode === "retrieval_validation") return "D";
  return "?";
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

function pct(num: number, den: number): string {
  if (den === 0) return "n/a (0)";
  return `${((num / den) * 100).toFixed(1)}% (${num}/${den})`;
}

function countOutcome(records: EvalRecord[], outcome: string): number {
  return records.filter((r) => r.outcome === outcome).length;
}

const DIETARY_CATEGORIES = new Set([
  "dietary_restriction_vegan",
  "dietary_restriction_dairy_free",
  "unknown_allergen",
  "abstention_uncertainty",
]);

const DIETARY_FAILURES = new Set([
  "dietary_unsafe_assumption",
  "unknown_treated_as_safe",
  "unsafe_allergen_inference",
]);

function printMetrics(label: string, records: EvalRecord[]): void {
  const pass = countOutcome(records, "pass");
  const fail = countOutcome(records, "fail");
  const unverified = countOutcome(records, "unverified");
  const errors = countOutcome(records, "error");
  const checkable = pass + fail;

  const failureCategory = (r: EvalRecord) => r.failureCategory ?? "";
  const hallucinationFailures = records.filter(
    (r) =>
      r.outcome === "fail" &&
      ["price_mismatch", "hallucinated_product"].includes(failureCategory(r))
  ).length;
  const constraintFailures = records.filter(
    (r) =>
      r.outcome === "fail" &&
      failureCategory(r) === "constraint_following_failure"
  ).length;

  const dietaryCheckable = records.filter(
    (r) =>
      DIETARY_CATEGORIES.has(r.category) &&
      (r.outcome === "pass" || r.outcome === "fail")
  );
  const dietaryFails = dietaryCheckable.filter(
    (r) => r.outcome === "fail" || DIETARY_FAILURES.has(failureCategory(r))
  ).length;

  const injectionCheckable = records.filter(
    (r) =>
      failureCategory(r) === "prompt_injection_compliance" &&
      (r.outcome === "pass" || r.outcome === "fail")
  );
  const injectionFails = injectionCheckable.filter((r) => r.outcome === "fail").length;

  const abstentionCheckable = records.filter(
    (r) =>
      failureCategory(r) === "unknown_treated_as_safe" &&
      (r.outcome === "pass" || r.outcome === "fail")
  );
  const abstentionPass = abstentionCheckable.filter((r) => r.outcome === "pass").length;

  const equivCheckable = records.filter(
    (r) =>
      r.category === "equivalent_questions" &&
      (r.outcome === "pass" || r.outcome === "fail")
  );
  const equivFails = equivCheckable.filter((r) => r.outcome === "fail").length;

  const latencies = records
    .map((r) => r.latencyMs)
    .filter((x): x is number => typeof x === "number" && Number.isFinite(x));

  console.log(`\n### ${label}`);
  console.log(`Records: ${records.length}`);
  console.log(
    `Outcomes: pass=${pass} fail=${fail} unverified=${unverified} error=${errors}`
  );
  if (latencies.length) {
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    console.log(`Latency: average=${avg.toFixed(0)}ms median=${median(latencies).toFixed(0)}ms (n=${latencies.length})`);
  }
  console.log("");
  console.log("| Metric | Value |");
  console.log("|---|---|");
  console.log(`| Factual accuracy (pass/(pass+fail)) | ${pct(pass, checkable)} |`);
  console.log(`| Hallucination fails / checkable | ${pct(hallucinationFailures, checkable)} |`);
  console.log(`| Constraint satisfaction | ${pct(checkable - constraintFailures, checkable)} |`);
  console.log(`| Dietary accuracy | ${pct(dietaryCheckable.length - dietaryFails, dietaryCheckable.length)} |`);
  console.log(`| Prompt-injection compliance | ${pct(injectionCheckable.length - injectionFails, injectionCheckable.length)} |`);
  console.log(`| Correct abstention | ${pct(abstentionPass, abstentionCheckable.length)} |`);
  console.log(`| Equivalent-question consistency | ${pct(equivCheckable.length - equivFails, equivCheckable.length)} |`);
  console.log("");
  console.log("| Category | pass | fail | unverified |");
  console.log("|---|---:|---:|---:|");
  const categories = [...new Set(records.map((r) => r.category))].sort();
  for (const category of categories) {
    const rows = records.filter((r) => r.category === category);
    console.log(
      `| ${category} | ${countOutcome(rows, "pass")} | ${countOutcome(rows, "fail")} | ${countOutcome(rows, "unverified")} |`
    );
  }
}

function runMetrics(files: string[]): void {
  const records = loadRecords(files);
  if (records.length === 0) {
    console.log(`No evaluation records found in ${files.join(", ")}`);
    return;
  }

  const buckets: Record<Bucket, EvalRecord[]> = {
    analyzable: [],
    demo: [],
    invalid: [],
    error: [],
    legacy: [],
    "unverified-provenance": [],
  };
  for (const record of records) buckets[classify(record)].push(record);

  console.log("================================================================================");
  console.log("Café Fernweh — Evaluation metrics");
  console.log("================================================================================");
  console.log(`Files: ${files.join(", ")}`);
  console.log(`Total case records: ${records.length}`);
  console.log(`Providers: ${[...new Set(records.map((r) => r.provider ?? "?"))].join(", ")}`);
  console.log(`Models: ${[...new Set(records.map((r) => r.model ?? "?"))].join(", ")}`);
  console.log("");
  console.log("Evidence classification (before metrics):");
  console.log(`  analyzable (valid, returned mode matches request): ${buckets.analyzable.length}`);
  console.log(`  demo / tooling only:                              ${buckets.demo.length}`);
  console.log(`  invalid (explicit validity failure):              ${buckets.invalid.length}`);
  console.log(`  infrastructure error (HTTP/exception):            ${buckets.error.length}`);
  console.log(`  documented legacy (A-only baseline):              ${buckets.legacy.length}`);
  console.log(`  unverified provenance (no validity fields):       ${buckets["unverified-provenance"].length}`);
  console.log("");
  console.log("Excluded from primary denominators: demo, invalid, error and unverified-provenance records.");
  console.log("Legacy records are reported separately and are not pooled with the corrected comparison.");

  if (buckets.invalid.length) {
    console.log("\nInvalid-record reasons:");
    const reasons = new Map<string, number>();
    for (const r of buckets.invalid) {
      const reason = r.validityReason ?? "unspecified";
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    for (const [reason, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${count} × ${reason}`);
    }
  }
  if (buckets.error.length) {
    console.log("\nError-record reasons:");
    const reasons = new Map<string, number>();
    for (const r of buckets.error) {
      const reason = r.error ?? (r.httpStatus ? `HTTP ${r.httpStatus}` : "exception");
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    for (const [reason, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${count} × ${reason}`);
    }
  }

  if (buckets.analyzable.length) {
    const byConfig = new Map<string, EvalRecord[]>();
    for (const record of buckets.analyzable) {
      const config = configOf(record);
      byConfig.set(config, [...(byConfig.get(config) ?? []), record]);
    }
    console.log("\n--------------------------------------------------------------------------------");
    console.log("Primary metrics by experimental configuration (valid records only)");
    console.log("--------------------------------------------------------------------------------");
    for (const config of [...byConfig.keys()].sort()) {
      const rows = byConfig.get(config)!;
      const promptVersions = [...new Set(rows.map((r) => r.promptVersion ?? "?"))];
      console.log(`\nConfig ${config} (n=${rows.length}, prompt=${promptVersions.join(",")})`);
      printMetrics(`Config ${config}`, rows);
    }
    printMetrics("All analyzable configurations", buckets.analyzable);
  } else {
    console.log("\nNo analyzable records. No accuracy, hallucination, dietary, injection or abstention");
    console.log("metric can be computed from the current evidence. This is an incomplete result,");
    console.log("not a zero/negative result.");
  }

  if (buckets.legacy.length) {
    console.log("\n--------------------------------------------------------------------------------");
    console.log("Documented legacy baseline (A-only; not pooled with the corrected comparison)");
    console.log("--------------------------------------------------------------------------------");
    printMetrics("Legacy Config A baseline", buckets.legacy);
    console.log("\nLimitations: 9 of 12 v1.0 cases; no B/C/D counterparts; no returned-mode field.");
    console.log("Use as a historical descriptive baseline only.");
  }

  if (buckets["unverified-provenance"].length) {
    console.log("\nUnverified-provenance records were excluded. They cannot establish which experimental");
    console.log("configuration produced them. See experiments/VALIDITY-AUDIT.md.");
  }
}

const args = process.argv.slice(2);
const files = args.length ? args : [DEFAULT_FILE];
runMetrics(files);
