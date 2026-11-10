/**
 * Structured conversational state.
 *
 * Tracks the constraints that are active across a multi-turn conversation so
 * that follow-up questions can inherit them without relying exclusively on the
 * language model to remember constraints from raw conversation history.
 *
 * State is derived from deterministic tool results (not model prose), so it
 * only ever reflects verified database facts. The model's explicit tool
 * arguments always win over inherited state; inheritance only fills in fields
 * the model left unset, and only when the request is otherwise ambiguous.
 *
 * Constraints decay naturally: a new explicit value supersedes an old one, and
 * a field explicitly cleared (null) is removed from active state.
 */

import { type DietaryRestriction, productSchema, type Product } from "@shared/schema";

export interface ConversationState {
  category?: string;
  temperature?: string; // e.g. "hot", "iced", "warm"
  maxPriceCents?: number;
  dietary?: DietaryRestriction;
  available?: boolean;
  taste?: string;
  /** Product IDs referenced in the current conversation context. */
  referencedProductIds: number[];
  updatedAt: number;
}

export function createConversationState(): ConversationState {
  return {
    referencedProductIds: [],
    updatedAt: Date.now(),
  };
}

/** Update state from a deterministic tool result. */
export function updateFromToolResult(
  state: ConversationState,
  name: string,
  args: Record<string, unknown>,
  result: unknown
): ConversationState {
  const next: ConversationState = { ...state, updatedAt: Date.now() };

  const r = result as { products?: Product[]; product?: Product };

  // Record referenced products from any result that returns them.
  const products = Array.isArray(r?.products) ? r.products : r?.product ? [r.product] : [];
  for (const p of products) {
    if (p.id && !next.referencedProductIds.includes(p.id)) {
      next.referencedProductIds.push(p.id);
    }
  }
  // Keep the list bounded.
  next.referencedProductIds = next.referencedProductIds.slice(-20);

  if (name === "filter_products") {
    if (args.category) next.category = String(args.category);
    if (args.max_price_cents != null) next.maxPriceCents = Number(args.max_price_cents);
    if (args.dietary) next.dietary = args.dietary as DietaryRestriction;
    if (args.available !== undefined) next.available = Boolean(args.available);
    if (args.temperature) next.temperature = String(args.temperature);
    if (args.taste) next.taste = String(args.taste);
  } else if (name === "get_recommendation_candidates") {
    const c = args.constraints as Record<string, unknown> | undefined;
    if (c?.category) next.category = String(c.category);
    if (c?.max_price_cents != null) next.maxPriceCents = Number(c.max_price_cents);
    if (c?.dietary) next.dietary = c.dietary as DietaryRestriction;
    if (c?.temperature) next.temperature = String(c.temperature);
    if (c?.taste) next.taste = String(c.taste);
  } else if (name === "search_products") {
    // A search narrows context only when it returns a single clear product.
    if (products.length === 1) {
      const p = products[0];
      if (p) next.referencedProductIds = [p.id];
    }
  }

  return next;
}

/**
 * Clear an explicitly-named constraint field from state. Used when the
 * customer asks to drop a previous restriction (e.g. "ignore the vegan rule").
 */
export function clearConstraint(state: ConversationState, field: string): ConversationState {
  const next: ConversationState = { ...state, updatedAt: Date.now() };
  switch (field) {
    case "category": delete next.category; break;
    case "temperature": delete next.temperature; break;
    case "maxPriceCents": delete next.maxPriceCents; break;
    case "dietary": delete next.dietary; break;
    case "available": delete next.available; break;
    case "taste": delete next.taste; break;
    case "referencedProducts": next.referencedProductIds = []; break;
  }
  return next;
}

/**
 * Merge inherited state into a model-supplied tool argument set. Only fields
 * the model left unset are filled in, so an explicit model choice always wins.
 */
export function inheritIntoArgs(
  state: ConversationState,
  name: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...args };

  const fill = (field: string, value: unknown) => {
    if (merged[field] === undefined || merged[field] === null) {
      merged[field] = value;
    }
  };

  if (name === "filter_products") {
    if (state.category) fill("category", state.category);
    if (state.maxPriceCents != null) fill("max_price_cents", state.maxPriceCents);
    if (state.dietary) fill("dietary", state.dietary);
    if (state.available !== undefined) fill("available", state.available);
    if (state.temperature) fill("temperature", state.temperature);
    if (state.taste) fill("taste", state.taste);
  } else if (name === "get_recommendation_candidates") {
    const c = (merged.constraints ?? {}) as Record<string, unknown>;
    if (state.category) fill("category", state.category);
    if (state.maxPriceCents != null) fill("max_price_cents", state.maxPriceCents);
    if (state.dietary) fill("dietary", state.dietary);
    if (state.temperature) fill("temperature", state.temperature);
    if (state.taste) fill("taste", state.taste);
    merged.constraints = c;
  } else if (name === "search_products") {
    if (state.category) fill("query", state.category);
  }

  return merged;
}

/** Human-readable summary of active constraints, for the system prompt. */
export function formatInherited(state: ConversationState): string {
  const bits: string[] = [];
  if (state.category) bits.push(`category: ${state.category}`);
  if (state.temperature) bits.push(`temperature: ${state.temperature}`);
  if (state.maxPriceCents != null)
    bits.push(`maximum price: ₹${(state.maxPriceCents / 100).toFixed(2)}`);
  if (state.dietary) bits.push(`dietary: ${state.dietary}`);
  if (state.available !== undefined)
    bits.push(`availability: ${state.available ? "available only" : "any"}`);
  if (state.taste) bits.push(`taste: ${state.taste}`);
  if (!bits.length) return "none";
  return bits.join("; ");
}

export function productToSummary(p: Product): string {
  return `${p.name} (${p.category}): ${p.price_inr}, ${p.available ? "available" : "unavailable"}, ${p.dietary_classification}.`;
}
