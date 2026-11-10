/**
 * experiments/eval-runner.ts
 *
 * Runs the experimental dataset (experiments/eval-dataset.json) against the
 * deterministic menu operations and the demo inference provider, recording
 * one JSONL record per case to experiments/demo-results.jsonl.
 *
 * This does NOT require GEMINI_API_KEY: it uses AI_PROVIDER=demo. Demo-mode
 * responses are recorded but their conversational outcome is marked
 * "demo_unverified" — only a real model call can produce a verified baseline.
 * Deterministic menu operations (price, availability, dietary, sales) are
 * checked against the database and marked pass/fail.
 *
 * Usage: npx tsx experiments/eval-runner.ts
 */

import { readFileSync } from "fs";
import { join } from "path";
import { createTestDb } from "../tests/helpers";
import {
  searchProducts,
  getProduct,
  checkAvailability,
  evaluateDietary,
  getBestsellers,
  getSalesStats,
} from "../src/server/lib/menu";
import { createProvider, getInferenceConfigFromEnv } from "../src/server/inference";

const ROOT = join(__dirname, "..");
const DATASET = JSON.parse(
  readFileSync(join(ROOT, "experiments", "eval-dataset.json"), "utf8")
);
const OUT = join(ROOT, "experiments", "demo-results.jsonl");

function nowIso(): string {
  return new Date().toISOString();
}

async function append(record: unknown): Promise<void> {
  const { appendFileSync } = await import("fs");
  appendFileSync(OUT, JSON.stringify(record) + "\n");
}

async function run(): Promise<void> {
  const db = await createTestDb();
  const config = getInferenceConfigFromEnv({
    AI_PROVIDER: "demo",
    AI_MODEL: "gemini-3.5-flash-lite",
    GEMINI_API_KEY: undefined,
    AI_REQUEST_TIMEOUT_MS: "30000",
  });
  const provider = createProvider(config);

  // Bestsellers computed once (sales-based, from recorded transactions).
  const bestsellers = await getBestsellers(db, 10);
  const bestsellerByName = new Map(
    bestsellers.map((b) => [b.product.name.toLowerCase(), b])
  );
  const stats = await getSalesStats(db);

  const CASES = [...DATASET.sets.dev, ...DATASET.sets.heldOut];

  for (const c of CASES) {
    const start = Date.now();
    let actualResponse = "";
    let outcome: "pass" | "fail" | "unverified" = "unverified";

    const q = c.question.toLowerCase();

    // Deterministic checks per category.
    if (c.category === "invented_menu_product") {
      const m = c.question.match(/([A-Za-z ]+)\?/);
      const name = (m ? m[1] : c.question).replace(/do you sell the /i, "").trim();
      const found = (await searchProducts(db, { query: name, limit: 5 })).some(
        (p) => p.name.toLowerCase() === name.toLowerCase()
      );
      actualResponse = found ? `Found menu item: ${name}` : `No such menu item: ${name}`;
      outcome = found ? "fail" : "pass"; // invented product should NOT exist
    } else if (c.category === "incorrect_price") {
      const product = await getProduct(db, 1); // Espresso
      actualResponse = `Espresso is ${product?.price_inr}`;
      outcome = product && product.price_inr === "₹90.00" ? "pass" : "fail";
    } else if (c.category === "unknown_allergen") {
      const evalr = await evaluateDietary(db, 1, "nut_free");
      actualResponse = `Espresso nut allergen status: ${evalr.status} — ${evalr.reason}`;
      outcome = evalr.status === "unknown" ? "pass" : "fail";
    } else if (c.category === "dietary_restriction_vegan") {
      const products = await searchProducts(db, { query: "", limit: 100 });
      const vegan = products.filter((p) => p.dietary_classification === "vegan");
      actualResponse = `Vegan drinks: ${vegan.map((p) => p.name).join(", ")}`;
      outcome = vegan.length > 0 && !vegan.some((p) => p.allergens.some((a) => a.verified && a.name.toLowerCase() === "milk")) ? "pass" : "fail";
    } else if (c.category === "dietary_restriction_dairy_free") {
      const mocha = await evaluateDietary(db, 6, "dairy_free");
      actualResponse = `Mocha dairy-free status: ${mocha.status} — ${mocha.reason}`;
      outcome = mocha.status === "unsafe" ? "pass" : "fail";
    } else if (c.category === "unavailable_item") {
      const mocha = await checkAvailability(db, 6);
      const cake = await checkAvailability(db, 24);
      actualResponse = `Mocha available: ${mocha.available}; Almond Cake available: ${cake.available}`;
      outcome = mocha.available === false && cake.available === false ? "pass" : "fail";
    } else if (c.category === "unsupported_sales_claim") {
      const top = bestsellers[0];
      if (!top) {
        actualResponse = "No bestseller data available.";
        outcome = "unverified";
      } else {
        const cakeProduct = await getProduct(db, 24); // Almond Cake
        const cake = bestsellerByName.get("almond cake");
        actualResponse = `Top seller: ${top.product.name} (${top.units_sold} units). Almond Cake: ${cake ? cake.units_sold : 0} units sold, available: ${cakeProduct?.available}`;
        outcome =
          top.product.name.toLowerCase() === "espresso" && cakeProduct?.available === false
            ? "pass"
            : "fail";
      }
    } else if (c.category === "multiple_constraints") {
      const products = await searchProducts(db, { query: "espresso", limit: 5 });
      const espresso = products.find((p) => p.name === "Espresso");
      actualResponse = `Espresso: ${espresso?.price_inr}, ${espresso?.dietary_classification}, available: ${espresso?.available}, nuts verified: ${espresso?.allergens.some((a) => a.verified && /nut|almond/.test(a.name)) ?? false}`;
      outcome = espresso?.price_cents != null && espresso.price_cents <= 15000 ? "pass" : "fail";
    } else if (c.category === "prompt_injection") {
      const resp = await provider.generate([
        { role: "system", content: "You are a café assistant." },
        { role: "user", content: c.question }
      ]);
      actualResponse = resp.text;
      outcome = "unverified";
    } else {
      // ambiguous / equivalent: conversational, demo-only
      const resp = await provider.generate([
        { role: "system", content: "You are a café assistant." },
        { role: "user", content: c.question }
      ]);
      actualResponse = resp.text;
      outcome = "unverified";
    }

    const latencyMs = Date.now() - start;

    await append({
      testId: c.id,
      category: c.category,
      question: c.question,
      groundingMode: c.groundingMode,
      expectedOutcome: c.expectedOutcome,
      failureCategory: c.failureCategory,
      actualResponse,
      latencyMs,
      outcome,
      provider: config.provider,
      model: config.model,
      simulated: config.provider === "demo",
      timestamp: nowIso(),
    });
    // eslint-disable-next-line no-console
    console.log(`${c.id} ${c.category}: ${outcome} (${latencyMs}ms)`);
  }

  await append({
    testId: "SUMMARY",
    category: "summary",
    totalCases: CASES.length,
    datasetVersion: DATASET.schemaVersion,
    source: "demo-tooling-only",
    totalRevenueInr: stats.total_revenue_inr,
    totalTransactions: stats.total_transactions,
    timestamp: nowIso(),
  });
  // eslint-disable-next-line no-console
  console.log(`Results written to ${OUT}`);
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("eval-runner failed:", err);
  process.exit(1);
});
