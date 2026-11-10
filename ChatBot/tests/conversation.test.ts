import { describe, it, expect } from "vitest";
import { createTestDb } from "./helpers";
import {
  createConversationState,
  updateFromToolResult,
  clearConstraint,
  inheritIntoArgs,
  formatInherited,
} from "../src/server/lib/state";
import { filterProducts } from "../src/server/lib/menu";
import { runConversation } from "../src/server/lib/orchestration";
import { type InferenceProvider } from "../src/shared/types";
import { type ConversationState } from "../src/server/lib/state";

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

describe("conversational state", () => {
  it("inheritIntoArgs fills unset fields from state; explicit model values win", () => {
    const state = createConversationState();
    state.category = "Cold Drinks";
    state.maxPriceCents = 15000;
    state.dietary = "vegan";

    // Unset fields are filled.
    expect(inheritIntoArgs(state, "filter_products", {})).toMatchObject({
      category: "Cold Drinks",
      max_price_cents: 15000,
      dietary: "vegan",
    });

    // Explicit model value wins over inherited state.
    expect(
      inheritIntoArgs(state, "filter_products", { category: "Coffee" })
    ).toMatchObject({ category: "Coffee", max_price_cents: 15000, dietary: "vegan" });
  });

  it("null clears an inherited constraint", () => {
    const state = createConversationState();
    state.category = "Cold Drinks";
    state.dietary = "vegan";

    const cleared = clearConstraint(state, "dietary");
    expect(cleared.dietary).toBeUndefined();
    expect(cleared.category).toBe("Cold Drinks");

    // After clearing dietary, inheritance no longer fills it.
    expect(inheritIntoArgs(cleared, "filter_products", {})).not.toHaveProperty("dietary");
    expect(inheritIntoArgs(cleared, "filter_products", {})).toMatchObject({
      category: "Cold Drinks",
    });
  });

  it("updateFromToolResult records category from filter_products args", () => {
    const state = createConversationState();
    const result = updateFromToolResult(
      state,
      "filter_products",
      { category: "Tea", max_price_cents: 10000 },
      { products: [] }
    );
    expect(result.category).toBe("Tea");
    expect(result.maxPriceCents).toBe(10000);
  });

  it("formatInherited describes active constraints", () => {
    const state = createConversationState();
    expect(formatInherited(state)).toBe("none");

    state.category = "Coffee";
    state.maxPriceCents = 20000;
    state.dietary = "vegan";
    const desc = formatInherited(state);
    expect(desc).toContain("category: Coffee");
    expect(desc).toContain("₹200.00");
    expect(desc).toContain("dietary: vegan");
  });

  it("multi-turn: follow-up inherits category constraint (cold coffees -> cheapest)", async () => {
    const db = await createTestDb();

    // Turn 1: "What cold coffees do you have?" -> filter by Cold Drinks.
    const turn1 = await runConversation(
      {
        db,
        provider: scriptProvider([
          JSON.stringify({
            type: "tool",
            name: "filter_products",
            args: { category: "Cold Drinks", limit: 10 },
          }),
          JSON.stringify({ type: "final", text: "Here are the cold coffees." }),
        ]),
        groundingMode: "retrieval_validation",
        maxTurns: 10,
        state: createConversationState(),
      },
      "What cold coffees do you have?",
      []
    );

    expect(turn1.state.category).toBe("Cold Drinks");
    expect(turn1.products.every((p) => p.category === "Cold Drinks")).toBe(true);

    // Turn 2: "Which is the cheapest?" -> no category, must inherit Cold Drinks.
    const turn2 = await runConversation(
      {
        db,
        provider: scriptProvider([
          JSON.stringify({
            type: "tool",
            name: "filter_products",
            args: {},
          }),
          JSON.stringify({ type: "final", text: "The cheapest is Mint Lemonade." }),
        ]),
        groundingMode: "retrieval_validation",
        maxTurns: 10,
        state: turn1.state,
      },
      "Which of those is the cheapest?",
      []
    );

    expect(turn2.state.category).toBe("Cold Drinks");
    // The effective filter included the inherited category, so results are cold drinks.
    expect(turn2.products.length).toBeGreaterThan(0);
    expect(turn2.products.every((p) => p.category === "Cold Drinks")).toBe(true);
    // Cheapest cold drink should be Mint Lemonade (₹100).
    const cheapest = turn2.products.reduce((a, b) =>
      a.price_cents <= b.price_cents ? a : b
    );
    expect(cheapest.name).toBe("Mint Lemonade");
    expect(cheapest.price_cents).toBe(10000);
  });

  it("multi-turn: changing preferences supersedes previous state", async () => {
    const db = await createTestDb();

    const turn1 = await runConversation(
      {
        db,
        provider: scriptProvider([
          JSON.stringify({
            type: "tool",
            name: "filter_products",
            args: { category: "Coffee", dietary: "vegan", limit: 10 },
          }),
          JSON.stringify({ type: "final", text: "Vegan coffees." }),
        ]),
        groundingMode: "retrieval_validation",
        maxTurns: 10,
        state: createConversationState(),
      },
      "Vegan coffees please",
      []
    );
    expect(turn1.state.dietary).toBe("vegan");
    expect(turn1.state.category).toBe("Coffee");

    // Turn 2: drop the vegan restriction (null) and switch to Bakery.
    const turn2 = await runConversation(
      {
        db,
        provider: scriptProvider([
          JSON.stringify({
            type: "tool",
            name: "filter_products",
            args: { category: "Bakery", dietary: null, limit: 10 },
          }),
          JSON.stringify({ type: "final", text: "Bakery items." }),
        ]),
        groundingMode: "retrieval_validation",
        maxTurns: 10,
        state: turn1.state,
      },
      "Actually show me bakery items instead, no dietary filter",
      []
    );

    expect(turn2.state.dietary).toBeUndefined();
    expect(turn2.state.category).toBe("Bakery");
    expect(turn2.products.every((p) => p.category === "Bakery")).toBe(true);
  });

  it("multi-turn: multiple simultaneous restrictions are inherited together", async () => {
    const db = await createTestDb();

    const turn1 = await runConversation(
      {
        db,
        provider: scriptProvider([
          JSON.stringify({
            type: "tool",
            name: "get_recommendation_candidates",
            args: {
              constraints: {
                category: "Coffee",
                max_price_cents: 15000,
                dietary: "vegan",
              },
              limit: 10,
            },
          }),
          JSON.stringify({ type: "final", text: "Cheap vegan coffees." }),
        ]),
        groundingMode: "retrieval_validation",
        maxTurns: 10,
        state: createConversationState(),
      },
      "Vegan coffee under ₹150",
      []
    );

    expect(turn1.state.category).toBe("Coffee");
    expect(turn1.state.maxPriceCents).toBe(15000);
    expect(turn1.state.dietary).toBe("vegan");

    // Turn 3-ish: follow-up asking for cheapest, inherits all restrictions.
    const turn2 = await runConversation(
      {
        db,
        provider: scriptProvider([
          JSON.stringify({
            type: "tool",
            name: "filter_products",
            args: {},
          }),
          JSON.stringify({ type: "final", text: "Cheapest qualifying item." }),
        ]),
        groundingMode: "retrieval_validation",
        maxTurns: 10,
        state: turn1.state,
      },
      "Which is the cheapest of those?",
      []
    );

    expect(turn2.state.category).toBe("Coffee");
    expect(turn2.state.maxPriceCents).toBe(15000);
    expect(turn2.state.dietary).toBe("vegan");
    // Effective filter: coffee, vegan, under ₹150.
    expect(turn2.products.length).toBeGreaterThan(0);
    expect(
      turn2.products.every(
        (p) =>
          p.category === "Coffee" &&
          p.dietary_classification === "vegan" &&
          p.price_cents <= 15000
      )
    ).toBe(true);
  });
});
