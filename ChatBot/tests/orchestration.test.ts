import { describe, it, expect } from "vitest";
import { createTestDb } from "./helpers";
import { runConversation, escapeHtml } from "../src/server/lib/orchestration";
import { createConversationState } from "../src/server/lib/state";
import { type InferenceProvider } from "../src/shared/types";
import { EVAL_CONFIGS } from "../src/shared/schema";

describe("escapeHtml", () => {
  it("escapes HTML markup", () => {
    expect(escapeHtml("<script>alert('x')</script>")).toBe(
      "&lt;script&gt;alert(&#039;x&#039;)&lt;/script&gt;"
    );
  });
});

function mockProvider(script: string[]): InferenceProvider {
  let index = 0;
  return {
    async generate() {
      const text = script[index] ?? "";
      index += 1;
      return { text, provider: "mock", model: "mock", simulated: true };
    },
  };
}

describe("grounded conversation orchestration", () => {
  it("uses a database tool and grounds the reply in validated data", async () => {
    const db = await createTestDb();
    const provider = mockProvider([
      JSON.stringify({
        type: "tool",
        name: "search_products",
        args: { query: "espresso", limit: 5 },
      }),
      JSON.stringify({
        type: "final",
        text: "We have espresso available for ₹90.00.",
      }),
    ]);

    const result = await runConversation(
      {
        db,
        provider,
        groundingMode: EVAL_CONFIGS.D.mode,
        maxTurns: 10,
        state: createConversationState(),
      },
      "Do you have espresso?",
      []
    );

    expect(result.usedTools).toContain("search_products");
    expect(result.products.length).toBeGreaterThan(0);
    expect(result.reply).toContain("espresso");
    expect(result.groundingMode).toBe("retrieval_validation");
  });

  it("does not use tools in the no-grounding baseline config", async () => {
    const db = await createTestDb();
    const provider = mockProvider([
      JSON.stringify({
        type: "final",
        text: "I don't have access to the live menu.",
      }),
    ]);

    const result = await runConversation(
      {
        db,
        provider,
        groundingMode: EVAL_CONFIGS.A.mode,
        maxTurns: 10,
        state: createConversationState(),
      },
      "What is on the menu?",
      []
    );

    expect(result.usedTools).toEqual([]);
    expect(result.groundingMode).toBe("none");
  });
});
