import { z } from "zod";

/**
 * Shared runtime schemas.
 *
 * These schemas validate data crossing the system boundary (customer messages,
 * model-generated tool arguments, API request/response bodies). They are the
 * single source of truth for what shapes are acceptable, keeping the backend
 * provider-independent and the frontend able to mirror validation without
 * duplicating logic.
 *
 * Prices are stored and transmitted as integer minor currency units (paise for
 * INR) to avoid floating-point currency errors. A display-friendly string is
 * derived at the edge, never parsed back into money.
 */

export const dietaryRestrictionSchema = z.enum([
  "vegan",
  "dairy_free",
  "lactose_free",
  "nut_free",
  "gluten_free",
  "vegetarian",
]);
export type DietaryRestriction = z.infer<typeof dietaryRestrictionSchema>;

export const groundingModeSchema = z.enum([
  "none", // A: model without menu grounding
  "menu_context", // B: model with menu context in the prompt
  "retrieval", // C: model with structured database retrieval
  "retrieval_validation", // D: retrieval + deterministic validation (production default)
]);
export type GroundingMode = z.infer<typeof groundingModeSchema>;

export const productSchema = z.object({
  id: z.number().int().positive(),
  category_id: z.number().int().positive(),
  category: z.string().optional(),
  name: z.string().min(1),
  description: z.string().min(1),
  price_cents: z.number().int().nonnegative(),
  price_inr: z.string().optional(), // derived display string, e.g. "₹250.00"
  available: z.boolean(),
  dietary_classification: z.string(),
  ingredients: z.array(z.string()).default([]),
  allergens: z
    .array(
      z.object({
        name: z.string(),
        verified: z.boolean(),
      })
    )
    .default([]),
});
export type Product = z.infer<typeof productSchema>;

export const productSearchArgsSchema = z.object({
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(50).default(10),
});

export const productGetArgsSchema = z.object({
  id: z.number().int().positive(),
});

export const productFilterArgsSchema = z.object({
  category: z.string().optional(),
  min_price_cents: z.number().int().nonnegative().optional(),
  max_price_cents: z.number().int().nonnegative().optional(),
  dietary: dietaryRestrictionSchema.optional(),
  allergen: z.string().optional(),
  available: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

export const availabilityArgsSchema = z.object({
  id: z.number().int().positive(),
});

export const dietaryArgsSchema = z.object({
  id: z.number().int().positive(),
  restriction: dietaryRestrictionSchema,
});

export const bestsellersArgsSchema = z.object({
  limit: z.number().int().min(1).max(50).default(10),
});

export const salesStatsArgsSchema = z.object({});

export const recommendationArgsSchema = z.object({
  constraints: z
    .object({
      category: z.string().optional(),
      max_price_cents: z.number().int().nonnegative().optional(),
      dietary: dietaryRestrictionSchema.optional(),
      allergen_exclude: z.array(z.string()).default([]),
      taste: z.string().optional(), // e.g. "bitter", "sweet", "nutty"
      temperature: z.string().optional(), // e.g. "hot", "iced", "warm"
    })
    .default({}),
  limit: z.number().int().min(1).max(50).default(10),
});

export const toolNameSchema = z.enum([
  "search_products",
  "get_product",
  "filter_products",
  "check_availability",
  "evaluate_dietary",
  "get_bestsellers",
  "get_sales_stats",
  "get_recommendation_candidates",
]);
export type ToolName = z.infer<typeof toolNameSchema>;

export const modelToolCallSchema = z.object({
  type: z.literal("tool"),
  name: toolNameSchema,
  args: z.record(z.string(), z.unknown()).default({}),
});
export type ModelToolCall = z.infer<typeof modelToolCallSchema>;

export const modelFinalSchema = z.object({
  type: z.literal("final"),
  text: z.string().min(1).max(4000),
});
export type ModelFinal = z.infer<typeof modelFinalSchema>;

export const modelResponseSchema = z.discriminatedUnion("type", [
  modelToolCallSchema,
  modelFinalSchema,
]);
export type ModelResponse = z.infer<typeof modelResponseSchema>;

export const chatRequestSchema = z.object({
  message: z.string().min(1).max(2000),
  conversation_id: z.string().uuid().optional(),
  grounding: groundingModeSchema.optional(),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const chatResponseSchema = z.object({
  reply: z.string(),
  grounding_mode: groundingModeSchema,
  used_tools: z.array(toolNameSchema).default([]),
  products: z.array(productSchema).default([]),
});
export type ChatResponse = z.infer<typeof chatResponseSchema>;

export const evalConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  mode: groundingModeSchema,
  description: z.string().optional(),
});
export type EvalConfig = z.infer<typeof evalConfigSchema>;

/** The four experimental configurations (research-only, gated server-side). */
export const EVAL_CONFIGS = {
  A: {
    id: "A",
    name: "Model without menu grounding",
    mode: "none",
    description: "Baseline: model answers from its own knowledge only.",
  },
  B: {
    id: "B",
    name: "Model with menu context",
    mode: "menu_context",
    description: "Prompt includes a static summary of the menu.",
  },
  C: {
    id: "C",
    name: "Model with structured retrieval",
    mode: "retrieval",
    description: "Model may request deterministic database lookups.",
  },
  D: {
    id: "D",
    name: "Model with retrieval + deterministic validation",
    mode: "retrieval_validation",
    description:
      "Production default: retrieval validated against the database before replying.",
  },
} as const satisfies Record<string, EvalConfig>;
