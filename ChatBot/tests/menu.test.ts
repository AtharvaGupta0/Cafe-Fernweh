import { describe, it, expect } from "vitest";
import { createTestDb } from "./helpers";
import {
  searchProducts,
  getProduct,
  checkAvailability,
  evaluateDietary,
  filterProducts,
  getBestsellers,
  getSalesStats,
  getRecommendationCandidates,
} from "../src/server/lib/menu";
import { formatPriceInr } from "../src/server/lib/db";

describe("menu operations", () => {
  it("searches products by name", async () => {
    const db = await createTestDb();
    const results = await searchProducts(db, { query: "espresso", limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((p) => p.name === "Espresso")).toBe(true);
    expect(results[0]!.price_inr).toBe("₹90.00");
  });

  it("searches products by description", async () => {
    const db = await createTestDb();
    const results = await searchProducts(db, { query: "lemon", limit: 5 });
    expect(results.some((p) => p.name === "Iced Lemon Tea")).toBe(true);
  });

  it("retrieves a single product by id", async () => {
    const db = await createTestDb();
    const product = await getProduct(db, 1);
    expect(product).not.toBeNull();
    expect(product!.name).toBe("Espresso");
    expect(product!.category).toBe("Coffee");
    expect(product!.price_cents).toBe(9000);
    expect(formatPriceInr(product!.price_cents)).toBe("₹90.00");
  });

  it("returns null for unknown product id", async () => {
    const db = await createTestDb();
    expect(await getProduct(db, 9999)).toBeNull();
  });

  it("checks availability", async () => {
    const db = await createTestDb();
    const espresso = await checkAvailability(db, 1);
    expect(espresso.available).toBe(true);
    const mocha = await checkAvailability(db, 6); // Mocha is seeded unavailable
    expect(mocha.available).toBe(false);
    expect(mocha.product!.name).toBe("Mocha");
  });

  it("filters by category", async () => {
    const db = await createTestDb();
    const teas = await filterProducts(db, { category: "Tea", limit: 50 });
    expect(teas.every((p) => p.category === "Tea")).toBe(true);
    expect(teas.length).toBeGreaterThan(0);
  });

  it("matches category case-insensitively", async () => {
    const db = await createTestDb();
    const exact = await filterProducts(db, { category: "Cold Drinks", limit: 50 });
    const lower = await filterProducts(db, { category: "cold drinks", limit: 50 });
    expect(lower.length).toBe(exact.length);
    expect(lower.map((p) => p.id).sort()).toEqual(exact.map((p) => p.id).sort());
  });

  it("filters lactose-free returns vegan items too (consistent with evaluateDietary)", async () => {
    const db = await createTestDb();
    const lactoseFree = await filterProducts(db, { dietary: "lactose_free", limit: 50 });
    const vegan = await filterProducts(db, { dietary: "vegan", limit: 50 });
    expect(lactoseFree.length).toBeGreaterThan(0);
    expect(lactoseFree.some((p) => p.name === "Espresso")).toBe(true);
    expect(vegan.length).toBeGreaterThan(0);
    expect(lactoseFree.map((p) => p.id).sort()).toEqual(vegan.map((p) => p.id).sort());
  });

  it("filters by maximum price", async () => {
    const db = await createTestDb();
    const cheap = await filterProducts(db, { max_price_cents: 10000, limit: 50 });
    expect(cheap.every((p) => p.price_cents <= 10000)).toBe(true);
    expect(cheap.some((p) => p.name === "Masala Chai")).toBe(true);
  });

  it("filters by availability", async () => {
    const db = await createTestDb();
    const available = await filterProducts(db, { available: true, limit: 50 });
    expect(available.every((p) => p.available)).toBe(true);
    expect(available.some((p) => p.name === "Mocha")).toBe(false); // unavailable
  });

  it("excludes products with a verified allergen", async () => {
    const db = await createTestDb();
    const noMilk = await filterProducts(db, { allergen: "Milk", limit: 50 });
    expect(
      noMilk.every((p) => !p.allergens.some((a) => a.name === "Milk" && a.verified))
    ).toBe(true);
  });

  it("evaluates vegan: espresso safe, cappuccino unsafe", async () => {
    const db = await createTestDb();
    const espresso = await evaluateDietary(db, 1, "vegan");
    expect(espresso.status).toBe("safe");
    const cappuccino = await evaluateDietary(db, 3, "vegan");
    expect(cappuccino.status).toBe("unsafe");
  });

  it("evaluates dairy-free: vegan cookie safe, latte unsafe", async () => {
    const db = await createTestDb();
    const cookie = await evaluateDietary(db, 25, "dairy_free");
    expect(cookie.status).toBe("safe");
    const latte = await evaluateDietary(db, 4, "dairy_free");
    expect(latte.status).toBe("unsafe");
  });

  it("treats unknown allergen info as unknown, never safe", async () => {
    const db = await createTestDb();
    // Espresso has an unverified almond allergen (cross-contact unknown).
    const nutFree = await evaluateDietary(db, 1, "nut_free");
    expect(nutFree.status).toBe("unknown");
  });

  it("bestsellers are ranked by units sold from transactions", async () => {
    const db = await createTestDb();
    const bestsellers = await getBestsellers(db, 5);
    expect(bestsellers.length).toBeGreaterThan(0);
    const top = bestsellers[0]!;
    expect(top.product.name).toBe("Espresso");
    expect(top.units_sold).toBe(9);
    expect(top.revenue_cents).toBe(9 * 9000);
    for (let i = 1; i < bestsellers.length; i++) {
      expect(bestsellers[i - 1]!.units_sold).toBeGreaterThanOrEqual(bestsellers[i]!.units_sold);
    }
  });

  it("sales stats are calculated from recorded transactions", async () => {
    const db = await createTestDb();
    const stats = await getSalesStats(db);
    expect(stats.total_transactions).toBe(28);
    const expected = 23000 + 27000 + 17000 + 18000 + 14000 + 23500 + 27000 + 25000
      + 12000 + 45000 + 7500 + 20000 + 17500 + 19000 + 19000 + 26000 + 27000 + 15000
      + 20000 + 36000 + 18000 + 34000 + 18000 + 14000 + 29500 + 14000 + 12500 + 28500;
    expect(stats.total_revenue_cents).toBe(expected);
    expect(stats.total_revenue_inr).toBe(formatPriceInr(expected));
  });

  it("recommendation candidates respect multiple constraints", async () => {
    const db = await createTestDb();
    const candidates = await getRecommendationCandidates(db, {
      constraints: {
        category: "Coffee",
        max_price_cents: 15000,
        dietary: "vegan",
        allergen_exclude: ["Milk"],
      },
      limit: 10,
    });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((p) => p.category === "Coffee")).toBe(true);
    expect(candidates.every((p) => p.available)).toBe(true);
    expect(candidates.every((p) => p.price_cents <= 15000)).toBe(true);
  });

  it("filters by temperature: hot returns coffees and teas", async () => {
    const db = await createTestDb();
    const hot = await filterProducts(db, { temperature: "hot", limit: 50 });
    expect(hot.length).toBeGreaterThan(0);
    expect(hot.some((p) => p.name === "Espresso")).toBe(true);
    expect(hot.some((p) => p.name === "Masala Chai")).toBe(true);
    // Iced items should not appear in hot results.
    expect(hot.some((p) => p.name === "Iced Coffee")).toBe(false);
    expect(hot.some((p) => p.name === "Mint Lemonade")).toBe(false);
  });

  it("filters by temperature: cold returns iced and cold drinks", async () => {
    const db = await createTestDb();
    const cold = await filterProducts(db, { temperature: "cold", limit: 50 });
    expect(cold.length).toBeGreaterThan(0);
    expect(cold.some((p) => p.name === "Iced Coffee")).toBe(true);
    expect(cold.some((p) => p.name === "Mint Lemonade")).toBe(true);
    expect(cold.some((p) => p.name === "Cold Brew")).toBe(true);
    // Hot items should not appear in cold results.
    expect(cold.some((p) => p.name === "Espresso")).toBe(false);
  });

  it("filters by temperature: iced returns iced items", async () => {
    const db = await createTestDb();
    const iced = await filterProducts(db, { temperature: "iced", limit: 50 });
    expect(iced.length).toBeGreaterThan(0);
    expect(iced.some((p) => p.name === "Iced Coffee")).toBe(true);
    expect(iced.some((p) => p.name === "Iced Latte")).toBe(true);
    expect(iced.some((p) => p.name === "Iced Matcha Latte")).toBe(true);
    expect(iced.some((p) => p.name === "Espresso")).toBe(false);
  });

  it("recommendation candidates pass temperature through to filterProducts", async () => {
    const db = await createTestDb();
    const coldVegan = await getRecommendationCandidates(db, {
      constraints: {
        dietary: "vegan",
        temperature: "cold",
        allergen_exclude: [],
      },
      limit: 10,
    });
    expect(coldVegan.length).toBeGreaterThan(0);
    expect(
      coldVegan.every((p) => p.dietary_classification === "vegan")
    ).toBe(true);
    // All returned items should be cold-compatible.
    expect(coldVegan.some((p) => p.name === "Mint Lemonade")).toBe(true);
    expect(coldVegan.some((p) => p.name === "Cold Brew")).toBe(true);
  });
});
