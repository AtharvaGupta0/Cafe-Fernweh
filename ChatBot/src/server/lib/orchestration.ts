import {
  DatabaseLike,
  InferenceProvider,
} from "@shared/types";
import {
  groundingModeSchema,
  modelResponseSchema,
  modelToolCallSchema,
  productSchema,
  productSearchArgsSchema,
  productGetArgsSchema,
  productFilterArgsSchema,
  availabilityArgsSchema,
  dietaryArgsSchema,
  bestsellersArgsSchema,
  salesStatsArgsSchema,
  recommendationArgsSchema,
  type Product,
  type ToolName,
  type DietaryRestriction,
} from "@shared/schema";
import {
  searchProducts,
  getProduct,
  checkAvailability,
  evaluateDietary,
  filterProducts,
  getBestsellers,
  getSalesStats,
  getRecommendationCandidates,
} from "./menu";
import {
  ConversationState,
  createConversationState,
  updateFromToolResult,
  clearConstraint,
  inheritIntoArgs,
  formatInherited,
} from "./state";

/** Maximum conversation turns retained per session (bounded history). */
const DEFAULT_MAX_TURNS = 10;

/** Escape HTML so assistant text can never inject markup into the chat UI. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function stripCodeFences(text: string): string {
  return text.replace(/```(?:json)?\s*/g, "").replace(/```\s*$/g, "").trim();
}

export interface ParsedModelResponse {
  type: "tool" | "final";
  name?: string;
  args?: Record<string, unknown>;
  finalText?: string;
}

function parseModelResponse(text: string): ParsedModelResponse {
  const cleaned = stripCodeFences(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { type: "final", finalText: text.trim() };
  }

  const validated = modelResponseSchema.safeParse(parsed);
  if (validated.success) {
    if (validated.data.type === "tool") {
      return { type: "tool", name: validated.data.name, args: validated.data.args };
    }
    return { type: "final", finalText: validated.data.text };
  }

  const tool = modelToolCallSchema.safeParse(parsed);
  if (tool.success) {
    return { type: "tool", name: tool.data.name, args: tool.data.args };
  }

  // Lenient: accept any tool-call shape so an unknown tool name surfaces as a
  // handleTool error instead of leaking raw JSON to the customer.
  if (
    parsed &&
    typeof parsed === "object" &&
    (parsed as { type?: unknown }).type === "tool" &&
    typeof (parsed as { name?: unknown }).name === "string"
  ) {
    return {
      type: "tool",
      name: (parsed as { name: string }).name,
      args: ((parsed as { args?: unknown }).args ?? {}) as Record<string, unknown>,
    };
  }

  return { type: "final", finalText: text.trim() };
}

const TOOL_CATALOG = `
Available database tools (call at most one per turn; only the names below):
- search_products: Search menu products by name or description.
  args: { query: string, limit?: number }
- get_product: Get one product by ID.
  args: { id: number }
- check_availability: Check whether a product is available.
  args: { id: number }
- evaluate_dietary: Check dietary suitability for a restriction.
  args: { id: number, restriction: "vegan" | "dairy_free" | "lactose_free" | "nut_free" | "gluten_free" | "vegetarian" }
- filter_products: Filter products by category, price, dietary, allergen or availability. Valid categories: Coffee, Tea, Cold Drinks, Snacks, Bakery.
  args: { category?, min_price_cents?, max_price_cents?, dietary?, allergen?, available?, limit? }
- get_bestsellers: Bestsellers ranked by units sold from recorded transactions.
  args: { limit? }
- get_sales_stats: Sales statistics from recorded transactions.
  args: {}
- get_recommendation_candidates: Products matching multiple constraints.
  args: { constraints: { category?, max_price_cents?, dietary?, allergen_exclude: string[], taste?, temperature? }, limit? }
`;

function systemPromptFor(mode: string, state: ConversationState): string {
  const base = `You are the assistant for Café Fernweh, a café. Be helpful, concise, and warm.
You must never invent menu facts (prices, availability, ingredients, allergens, sales).
When a customer asks about the menu, prices, availability, dietary suitability, or recommendations,
use the available database tools. Ground every factual claim in tool results.
All prices are in Indian Rupees (₹). Monetary values in tool arguments are in paise (minor currency
units): ₹1 = 100 paise, so ₹200 = 20000 paise. Distinguish lactose-free, dairy-free and vegan.
Treat unknown allergen information as unknown; never label an item allergen-safe without verified evidence.
Do not output HTML or markdown code fences in your final answer.`;

  const inherited = formatInherited(state);
  const contextLine = inherited === "none"
    ? ""
    : `\nActive conversation context (carried forward unless the customer overrides it): ${inherited}.`;

  switch (mode) {
    case "none":
      return `${base}

You are running WITHOUT menu grounding. Answer from your own general knowledge.
Be honest that you do not have access to Café Fernweh's live menu and may be wrong about specifics.`;
    case "menu_context":
      return `${base}

The café menu (fictional, for demonstration) includes:
- Coffee: Espresso ₹90, Americano ₹110, Cappuccino ₹160, Latte ₹170, Flat White ₹175, Mocha ₹190, Cold Brew ₹140, Iced Latte ₹165
- Tea: Masala Chai ₹60, English Breakfast ₹70, Green Tea ₹75, Iced Lemon Tea ₹90
- Cold Drinks: Iced Coffee ₹150, Mango Lassi ₹120, Mint Lemonade ₹100, Iced Matcha Latte ₹180
- Snacks: Veg Samosa ₹50, Paneer Tikka Wrap ₹140, Aloo Tikki Burger ₹110, Masala Peanuts ₹60
- Bakery: Butter Croissant ₹110, Banana Muffin ₹100, Chocolate Brownie ₹130, Almond Cake ₹140, Vegan Cookie ₹70

Use this context when helpful, but prefer database tools for exact facts.`;
    case "retrieval":
      return `${base}${TOOL_CATALOG}${contextLine}

Output either a tool-call JSON object
{ "type": "tool", "name": "...", "args": {...} } or a final response
{ "type": "final", "text": "..." }. After receiving a tool result, produce your final answer
using only the data returned.`;
    case "retrieval_validation":
    default:
      return `${base}${TOOL_CATALOG}${contextLine}

Output either a tool-call JSON object
{ "type": "tool", "name": "...", "args": {...} } or a final response
{ "type": "final", "text": "..." }.

CRITICAL: For prices, availability and dietary eligibility, your final answer MUST use the
server-validated product data returned by the tools. Do not restate prices or availability from
memory. If a tool result says an item is unavailable or an allergen is unknown, say so explicitly.
Never contradict a deterministic tool result.`;
  }
}

type ToolResult =
  | { kind: "products"; products: Product[] }
  | { kind: "product"; product: Product | null }
  | { kind: "availability"; available: boolean; product: Product | null }
  | { kind: "dietary"; evaluation: { status: "safe" | "unsafe" | "unknown"; reason: string }; product: Product | null }
  | { kind: "bestsellers"; items: Array<{ product: Product; units_sold: number; revenue_cents: number }> }
  | { kind: "sales_stats"; stats: Record<string, unknown> }
  | { kind: "error"; message: string };

const argValidators: Record<string, { safeParse: (x: unknown) => any }> = {
  search_products: productSearchArgsSchema,
  get_product: productGetArgsSchema,
  filter_products: productFilterArgsSchema,
  check_availability: availabilityArgsSchema,
  evaluate_dietary: dietaryArgsSchema,
  get_bestsellers: bestsellersArgsSchema,
  get_sales_stats: salesStatsArgsSchema,
  get_recommendation_candidates: recommendationArgsSchema,
};

async function handleTool({
  db,
  name,
  args,
}: {
  db: DatabaseLike;
  name: ToolName;
  args: Record<string, unknown>;
}): Promise<ToolResult> {
  const validator = argValidators[name];
  if (!validator) {
    return { kind: "error", message: `Unknown tool: ${name}` };
  }

  const parsed = (validator as { safeParse: (x: unknown) => { success: boolean; data: unknown } }).safeParse(args);
  if (!parsed.success) {
    return { kind: "error", message: `Invalid arguments for ${name}.` };
  }

  const data = parsed.data as Record<string, unknown>;

  switch (name) {
    case "search_products":
      return { kind: "products", products: await searchProducts(db, { query: String(data.query ?? ""), limit: Number(data.limit ?? 10) }) };
    case "get_product":
      return { kind: "product", product: await getProduct(db, Number(data.id)) };
    case "check_availability": {
      const result = await checkAvailability(db, Number(data.id));
      return { kind: "availability", available: result.available, product: result.product };
    }
    case "evaluate_dietary": {
      const result = await evaluateDietary(db, Number(data.id), data.restriction as DietaryRestriction);
      return { kind: "dietary", evaluation: result, product: result.product };
    }
    case "filter_products":
      return { kind: "products", products: await filterProducts(db, data as { category?: string; min_price_cents?: number; max_price_cents?: number; dietary?: DietaryRestriction; allergen?: string; available?: boolean; limit?: number }) };
    case "get_bestsellers":
      return { kind: "bestsellers", items: await getBestsellers(db, Number(data.limit ?? 10)) };
    case "get_sales_stats":
      return { kind: "sales_stats", stats: await getSalesStats(db) };
    case "get_recommendation_candidates":
      return { kind: "products", products: await getRecommendationCandidates(db, data as { constraints: { category?: string; max_price_cents?: number; dietary?: DietaryRestriction; allergen_exclude: string[]; taste?: string; temperature?: string; }; limit?: number }) };
  }
  return { kind: "error", message: `Unhandled tool: ${name}` };
}

function formatPrice(cents: number): string {
  return `₹${(cents / 100).toFixed(2)}`;
}

function toolResultToText(result: ToolResult): string {
  if (result.kind === "products") {
    if (result.products.length === 0) return "No matching products found.";
    return result.products
      .map((p) => `- ${p.name} (${p.category}): ${p.price_inr}, ${p.available ? "available" : "unavailable"}, ${p.dietary_classification}. Ingredients: ${p.ingredients.join(", ")}.`)
      .join("\n");
  }
  if (result.kind === "product") {
    if (!result.product) return "Product not found.";
    const p = result.product;
    return `${p.name} (${p.category}): ${p.price_inr}, ${p.available ? "available" : "unavailable"}, ${p.dietary_classification}. Ingredients: ${p.ingredients.join(", ")}.`;
  }
  if (result.kind === "availability") {
    const p = result.product;
    return p ? `${p.name} is ${result.available ? "available" : "unavailable"}.` : "Product not found.";
  }
  if (result.kind === "dietary") {
    const p = result.product;
    if (!p) return "Product not found.";
    return `${p.name}: dietary suitability is "${result.evaluation.status}". ${result.evaluation.reason}`;
  }
  if (result.kind === "bestsellers") {
    return result.items
      .map((i) => `- ${i.product.name}: ${i.units_sold} units sold (₹${formatPrice(i.product.price_cents)} each).`)
      .join("\n");
  }
  if (result.kind === "sales_stats") {
    const s = result.stats as { total_transactions?: number; total_revenue_inr?: string; average_order_value_inr?: string };
    return `Total transactions: ${s.total_transactions ?? 0}. Total revenue: ${s.total_revenue_inr ?? "₹0.00"}. Average order value: ${s.average_order_value_inr ?? "₹0.00"}.`;
  }
  if (result.kind === "error") return `Lookup error: ${result.message}.`;
  return JSON.stringify(result);
}

export interface ConversationDependencies {
  db: DatabaseLike;
  provider: InferenceProvider;
  groundingMode: string;
  maxMessageLength?: number;
  maxTurns?: number;
}

export interface ConversationResult {
  reply: string;
  groundingMode: string;
  usedTools: ToolName[];
  products: Product[];
  state: ConversationState;
}

export async function runConversation(
  deps: ConversationDependencies & { state: ConversationState },
  message: string,
  history: Array<{ role: "user" | "assistant"; content: string }>
): Promise<ConversationResult> {
  const maxTurns = deps.maxTurns ?? DEFAULT_MAX_TURNS;
  const boundedHistory = history.slice(-maxTurns);

  const mode = groundingModeSchema.safeParse(deps.groundingMode).success
    ? deps.groundingMode
    : "retrieval_validation";

  let state = deps.state;

  const system = { role: "system" as const, content: systemPromptFor(mode, state) };
  const messages = [system, ...boundedHistory, { role: "user" as const, content: message }];

  const usedTools: ToolName[] = [];
  let products: Product[] = [];

  let response = await deps.provider.generate(messages);
  let parsed = parseModelResponse(response.text);

  if (parsed.type === "tool" && mode !== "none" && mode !== "menu_context") {
    // Explicitly cleared constraints (null values) take effect before inheritance.
    for (const [field, value] of Object.entries(parsed.args || {})) {
      if (value === null) {
        state = clearConstraint(state, field);
      }
    }

    // Merge active conversation state into unset tool arguments so follow-up
    // questions inherit relevant constraints (category, price, dietary, …).
    const modelArgs: Record<string, unknown> = { ...(parsed.args || {}) };
    const inheritedArgs = inheritIntoArgs(state, parsed.name as string, modelArgs);

    const toolResult = await handleTool({
      db: deps.db,
      name: parsed.name as ToolName,
      args: inheritedArgs,
    });
    usedTools.push(parsed.name as ToolName);
    state = updateFromToolResult(state, parsed.name as string, inheritedArgs, toolResult);

    if (toolResult.kind === "products") products = toolResult.products;
    else if (toolResult.kind === "product" && toolResult.product) products = [toolResult.product];

    messages.push({ role: "assistant" as const, content: response.text });
    messages.push({
      role: "user" as const,
      content: `TOOL RESULT (server-validated, do not contradict): ${toolResultToText(toolResult)}\n\nNow produce your final reply as JSON: { "type": "final", "text": "..." }.`,
    });
    response = await deps.provider.generate(messages);
    parsed = parseModelResponse(response.text);
  }

  const finalText =
    parsed.type === "final" && parsed.finalText
      ? parsed.finalText
      : toolResultToText({ kind: "error", message: "No response generated." });

  return {
    reply: escapeHtml(finalText),
    groundingMode: mode,
    usedTools,
    products,
    state,
  };
}
