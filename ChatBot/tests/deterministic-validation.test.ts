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
});
