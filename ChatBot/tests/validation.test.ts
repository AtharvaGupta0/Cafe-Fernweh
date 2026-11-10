import { describe, it, expect } from "vitest";
import { chatRequestSchema } from "../src/shared/schema";

describe("input validation", () => {
  it("accepts a valid chat request", () => {
    const result = chatRequestSchema.safeParse({ message: "Do you have vegan options?" });
    expect(result.success).toBe(true);
  });

  it("rejects an empty message", () => {
    const result = chatRequestSchema.safeParse({ message: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a message over the length limit", () => {
    const result = chatRequestSchema.safeParse({ message: "x".repeat(2001) });
    expect(result.success).toBe(false);
  });

  it("requires grounding to be a known mode when provided", () => {
    const result = chatRequestSchema.safeParse({ message: "hi", grounding: "bogus" as any });
    expect(result.success).toBe(false);
  });

  it("defaults grounding to undefined (server applies production config)", () => {
    const result = chatRequestSchema.safeParse({ message: "hi" });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("unreachable");
    expect(result.data.grounding).toBeUndefined();
  });
});
