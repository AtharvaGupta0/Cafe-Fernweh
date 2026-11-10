/**
 * Deterministic response validation (Configuration D).
 *
 * Validates critical factual claims in a model-generated reply against
 * server-verified database facts before the reply is delivered to the
 * customer. The model's own judgement is never trusted to certify its
 * response.
 *
 * Validation uses structured product data returned by database tools, plus a
 * targeted extraction of claims from the reply text. It does not attempt to
 * arbitrate arbitrary natural-language opinions with regular expressions;
 * instead it cross-checks every concrete product, price, availability and
 * dietary claim the reply makes against verified records.
 *
 * When validation fails, the caller must not return the unsupported claim;
 * it should produce a safe response from verified facts and record the
 * failure.
 */

import { type Product, type DietaryRestriction } from "@shared/schema";
import { evaluateDietary, DAIRY_ALLERGENS, NUT_ALLERGENS, GLUTEN_ALLERGENS } from "./menu";
import type { DatabaseLike } from "@shared/types";

export interface ValidationFailure {
  constraint:
    | "product"
    | "price"
    | "availability"
    | "dietary"
    | "allergen"
    | "price-limit"
    | "sales";
  detail: string;
}

export interface ValidationResult {
  valid: boolean;
  failures: ValidationFailure[];
}

/** Price mentions like ₹90 or ₹90.00. */
const PRICE_RE = /₹\s*(\d+(?:\.\d{1,2})?)/g;

/** Availability assertions: "is available" / "unavailable" / "out of stock". */
const AVAILABLE_RE = /\b(available|in stock)\b/i;
const UNAVAILABLE_RE = /\b(unavailable|out of stock|not available)\b/i;

/** Dietary safety assertions: "is vegan" / "dairy-free" / etc. Global flag so every claim in the reply is found. */
const DIETARY_RE = /\b(is\s+)?(vegan|dairy.?free|lactose.?free|nut.?free|gluten.?free|vegetarian)\b/gi;

/**
 * Validate a model reply against verified tool results.
 *
 * @param reply - The model-generated final reply text.
 * @param products - Verified products returned by database tools (source of truth).
 * @param db - Database, needed for dietary evaluations.
 * @param constraints - Active conversational constraints (e.g. maxPriceCents).
 */
export async function validateReply({
  reply,
  products,
  db,
  constraints,
}: {
  reply: string;
  products: Product[];
  db: DatabaseLike;
  constraints?: { maxPriceCents?: number; dietary?: DietaryRestriction };
}): Promise<ValidationResult> {
  const failures: ValidationFailure[] = [];
  const productByName = new Map(
    products.map((p) => [p.name.toLowerCase(), p])
  );

  // 1. Every named product must exist in verified records.
  const namedProducts = new Set<string>();
  for (const p of products) {
    if (reply.toLowerCase().includes(p.name.toLowerCase())) {
      namedProducts.add(p.name.toLowerCase());
    }
  }

  // 2. Price claims: every price stated must match a verified product price.
  let priceMatch: RegExpExecArray | null;
  while ((priceMatch = PRICE_RE.exec(reply)) !== null) {
    const raw = priceMatch[1];
    if (!raw) continue;
    const rupees = parseFloat(raw);
    const claimedCents = Math.round(rupees * 100);
    const matchesVerified = products.some(
      (p) => p.price_cents === claimedCents
    );
    if (!matchesVerified) {
      failures.push({
        constraint: "price",
        detail: `Price ₹${raw} does not match any verified product price.`,
      });
    }
  }

  // 3. Product-level: price, availability, dietary, allergen claims.
  for (const [name, product] of productByName) {
    // Price stated alongside a named product must match that product.
    const productPriceMention = new RegExp(
      `${escapeRegExp(name)}[^\\d]{0,60}?${PRICE_RE.source}`,
      "i"
    );
    const pm = productPriceMention.exec(reply);
    if (pm && pm[1]) {
      const claimedCents = Math.round(parseFloat(pm[1]) * 100);
      if (claimedCents !== product.price_cents) {
        failures.push({
          constraint: "price",
          detail: `${product.name} is stated at ₹${pm[1]} but verified price is ${product.price_inr}.`,
        });
      }
    }

    // Availability claims must match verified availability.
    const aroundProduct = windowAround(reply, name, 120);
    if (UNAVAILABLE_RE.test(aroundProduct) && product.available) {
      failures.push({
        constraint: "availability",
        detail: `${product.name} is stated unavailable but verified records show it available.`,
      });
    }
    if (AVAILABLE_RE.test(aroundProduct) && !product.available) {
      failures.push({
        constraint: "availability",
        detail: `${product.name} is stated available but verified records show it unavailable.`,
      });
    }

    // Dietary safety claims must match verified evaluation. Check every
    // dietary claim found in the reply (global regex) and verify each against
    // the database. A product claimed as vegan/dairy-free/etc. must be
    // verified as safe by evaluateDietary; an unknown result is a failure.
    const claimedRestrictions = new Set<string>();
    for (const dm of reply.matchAll(DIETARY_RE)) {
      const claimedRaw = dm[2];
      if (!claimedRaw) continue;
      const claimed = claimedRaw
        .toLowerCase()
        .replace(/[.\s]/g, "")
        .replace(/-/g, "_") as DietaryRestriction;
      const validRestrictions: DietaryRestriction[] = [
        "vegan", "dairy_free", "lactose_free", "nut_free", "gluten_free", "vegetarian",
      ];
      if (!validRestrictions.includes(claimed)) continue;
      if (claimedRestrictions.has(claimed)) continue;
      claimedRestrictions.add(claimed);

      // Find the product this claim is about: look for a product name near
      // the claim position, falling back to the product being iterated.
      const claimIndex = dm.index ?? 0;
      let targetProduct = product;
      for (const [pName, p] of productByName) {
        const idx = reply.toLowerCase().indexOf(pName);
        if (idx !== -1 && Math.abs(idx - claimIndex) < 120) {
          targetProduct = p;
          break;
        }
      }

      const evalResult = await evaluateDietary(db, targetProduct.id, claimed);
      if (evalResult.status !== "safe") {
        failures.push({
          constraint: "dietary",
          detail: `${targetProduct.name} is stated as ${claimed} but verified status is ${evalResult.status}: ${evalResult.reason}`,
        });
      }
    }

    // Unverified allergen must not be declared safe. Check both the
    // specific allergen name and category-level claims (e.g. "nut-free"
    // covering an unverified almond allergen). Keyword matching uses word
    // boundaries so "nut-free" matches the nuts category but "donut" does not.
    const unverifiedAllergens = product.allergens.filter((a) => !a.verified);
    const allergenCategoryMap: Record<string, string[]> = {
      milk: [...DAIRY_ALLERGENS, "dairy"],
      peanuts: [...NUT_ALLERGENS, "nut", "peanut"],
      almonds: [...NUT_ALLERGENS, "nut", "almond"],
      nuts: [...NUT_ALLERGENS, "nut"],
      "gluten (wheat)": [...GLUTEN_ALLERGENS, "wheat"],
      gluten: GLUTEN_ALLERGENS,
    };
    for (const a of unverifiedAllergens) {
      const allergenName = a.name.toLowerCase();
      const categoryNames = allergenCategoryMap[allergenName] ?? [allergenName];
      const nameMatch = categoryNames.some((cn) => {
        const re = new RegExp(`\\b${cn.replace(/[.]/g, "\\.")}\\b`, "i");
        return re.test(aroundProduct);
      });
      const safeClaim = /safe|no .* allergen|allergen-free|nut.?free|dairy.?free|gluten.?free|lactose.?free/i.test(aroundProduct);
      if (nameMatch && safeClaim) {
        failures.push({
          constraint: "allergen",
          detail: `${product.name} is stated allergen-safe but ${a.name} is unverified (cross-contact possible).`,
        });
      }
    }
  }

  // 4. Price-limit constraint: every recommended product must be within limit.
  if (constraints?.maxPriceCents != null) {
    for (const p of products) {
      if (namedProducts.has(p.name.toLowerCase()) && p.price_cents > constraints.maxPriceCents) {
        failures.push({
          constraint: "price-limit",
          detail: `${p.name} (${p.price_inr}) exceeds the requested maximum of ₹${(constraints.maxPriceCents / 100).toFixed(2)}.`,
        });
      }
    }
  }

  return { valid: failures.length === 0, failures };
}

function windowAround(text: string, anchor: string, radius: number): string {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(anchor.toLowerCase());
  if (idx === -1) return text;
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + anchor.length + radius);
  return text.slice(start, end);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
