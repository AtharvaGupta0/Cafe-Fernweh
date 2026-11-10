import { describe, it, expect } from "vitest";
import { createTestDb } from "./helpers";
import { validateReply } from "../src/server/lib/validation";
import { runConversation } from "../src/server/lib/orchestration";
import { getProduct } from "../src/server/lib/menu";
import { createConversationState } from "../src/server/lib/state";
import { type InferenceProvider } from "../src/shared/types";

function scriptProvider(script: string[]): InferenceProvider {
  let index = 0;
  return {
    async generate() {
      const text = script[index] ?? "";
      index += 1;
      return { text, provider: "mock", model: "mock", simulated: true };
    },
  };
}

describe("deterministic response validation (Configuration D)", () => {
  it("rejects a wrong price for a named product", async () => {
    const db = await createTestDb();
    const products = [(await getProduct(db, 1))!];
    const result = await validateReply({
      reply: "Espresso is ₹5.00, a great deal!",
      products,
      db,
    });
    expect(result.valid).toBe(false);
    expect(result.failures.some((f) => f.constraint === "price")).toBe(true);
  });

  it("accepts the correct verified price", async () => {
    const db = await createTestDb();
    const products = [(await getProduct(db, 1))!];
    const result = await validateReply({
      reply: "Espresso is ₹90.00.",
      products,
      db,
    });
    expect(result.valid).toBe(true);
  });

  it("rejects an availability claim that contradicts verified records", async () => {
    const db = await createTestDb();
    // Espresso is available in the seed.
    const products = [(await getProduct(db, 1))!];
    const result = await validateReply({
      reply: "Espresso is currently unavailable.",
      products,
      db,
    });
    expect(result.valid).toBe(false);
    expect(result.failures.some((f) => f.constraint === "availability")).toBe(
      true
    );
  });

  it("rejects a dietary claim that contradicts verified evaluation", async () => {
    const db = await createTestDb();
    // Cappuccino contains verified milk, so it is not vegan.
    const products = [(await getProduct(db, 3))!];
    const result = await validateReply({
      reply: "Cappuccino is vegan.",
      products,
      db,
    });
    expect(result.valid).toBe(false);
    expect(result.failures.some((f) => f.constraint === "dietary")).toBe(true);
  });

  it("Configuration D blocks an unsupported price claim and returns a safe reply", async () => {
    const db = await createTestDb();
    const state = createConversationState();

    const result = await runConversation(
      {
        db,
        provider: scriptProvider([
          JSON.stringify({ type: "tool", name: "get_product", args: { id: 1 } }),
          JSON.stringify({
            type: "final",
            text: "Espresso is ₹5.00, a great deal!",
          }),
        ]),
        groundingMode: "retrieval_validation",
        maxTurns: 10,
        state,
      },
      "How much is the espresso?",
      []
    );

    // The unsupported ₹5.00 claim is not presented as a verified price;
    // the safe reply reports the verified price instead.
    expect(result.reply).toContain("₹90.00");
    expect(result.reply).not.toMatch(/Espresso is ₹5\.00/);
    // The validation failure is recorded.
    expect(result.state.validationFailures.length).toBeGreaterThan(0);
    expect(
      result.state.validationFailures.some((f) => f.constraint === "price")
    ).toBe(true);
  });

  it("Configuration C (retrieval) does not enforce response validation", async () => {
    const db = await createTestDb();
    const state = createConversationState();

    const result = await runConversation(
      {
        db,
        provider: scriptProvider([
          JSON.stringify({ type: "tool", name: "get_product", args: { id: 1 } }),
          JSON.stringify({
            type: "final",
            text: "Espresso is ₹5.00, a great deal!",
          }),
        ]),
        groundingMode: "retrieval",
        maxTurns: 10,
        state,
      },
      "How much is the espresso?",
      []
    );

    // Without deterministic validation, the model's claim passes through.
    expect(result.reply).toContain("₹5.00");
    expect(result.state.validationFailures.length).toBe(0);
  });

  it("validateReply catches dietary claims made anywhere in the reply (global check)", async () => {
    const db = await createTestDb();
    const cappuccino = (await getProduct(db, 3))!; // contains milk, not vegan

    // The claim "Cappuccino is vegan" appears at the start, before the product name.
    const result = await validateReply({
      reply: "Cappuccino is vegan and costs ₹160.00.",
      products: [cappuccino],
      db,
    });
    expect(result.valid).toBe(false);
    expect(result.failures.some((f) => f.constraint === "dietary")).toBe(true);
  });

  it("validateReply marks unknown dietary status as a failure (never inferred safe)", async () => {
    const db = await createTestDb();
    // English Breakfast Tea is kitchen-classified vegan; but we test a product
    // whose dietary status would be "unknown" for a restriction it isn't classified for.
    const mocha = (await getProduct(db, 6))!; // unavailable, classification "none"
    const result = await validateReply({
      reply: "Mocha is vegan.",
      products: [mocha],
      db,
    });
    expect(result.valid).toBe(false);
    expect(result.failures.some((f) => f.constraint === "dietary")).toBe(true);
  });

  it("validateReply does not declare a product allergen-safe when allergen info is unverified", async () => {
    const db = await createTestDb();
    // Espresso has an unverified almond allergen (cross-contact unknown).
    const espresso = (await getProduct(db, 1))!;
    const result = await validateReply({
      reply: "Espresso is nut-free and safe for nut allergies.",
      products: [espresso],
      db,
    });
    expect(result.valid).toBe(false);
    expect(
      result.failures.some((f) => f.constraint === "allergen")
    ).toBe(true);
  });

  it("Configuration D blocks an unsupported vegan claim and returns a safe reply", async () => {
    const db = await createTestDb();
    const state = createConversationState();

    const result = await runConversation(
      {
        db,
        provider: scriptProvider([
          JSON.stringify({ type: "tool", name: "get_product", args: { id: 3 } }),
          JSON.stringify({
            type: "final",
            text: "Cappuccino is vegan and safe for dairy-free customers.",
          }),
        ]),
        groundingMode: "retrieval_validation",
        maxTurns: 10,
        state,
      },
      "Is the cappuccino vegan?",
      []
    );

    // The unsupported vegan claim is blocked; the safe reply reports verified data.
    expect(result.reply).not.toMatch(/cappuccino is vegan/i);
    expect(result.state.validationFailures.length).toBeGreaterThan(0);
    expect(
      result.state.validationFailures.some((f) => f.constraint === "dietary")
    ).toBe(true);
  });

  it("validateReply verifies dairy-free claims against database records", async () => {
    const db = await createTestDb();
    // Latte contains verified milk, so it is not dairy-free.
    const latte = (await getProduct(db, 4))!;
    const result = await validateReply({
      reply: "Latte is dairy-free.",
      products: [latte],
      db,
    });
    expect(result.valid).toBe(false);
    expect(result.failures.some((f) => f.constraint === "dietary")).toBe(true);
  });

  it("validateReply verifies lactose-free claims against database records", async () => {
    const db = await createTestDb();
    // Latte contains milk, so it is not lactose-free.
    const latte = (await getProduct(db, 4))!;
    const result = await validateReply({
      reply: "Latte is lactose-free.",
      products: [latte],
      db,
    });
    expect(result.valid).toBe(false);
    expect(result.failures.some((f) => f.constraint === "dietary")).toBe(true);
  });

  it("validateReply accepts verified safe dietary claims", async () => {
    const db = await createTestDb();
    // Espresso is kitchen-classified vegan.
    const espresso = (await getProduct(db, 1))!;
    const result = await validateReply({
      reply: "Espresso is vegan.",
      products: [espresso],
      db,
    });
    expect(result.valid).toBe(true);
  });
});
