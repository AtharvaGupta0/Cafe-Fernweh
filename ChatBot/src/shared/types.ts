export type DietaryEvaluation = {
  status: "safe" | "unsafe" | "unknown";
  reason: string;
};

export type ToolResult =
  | { kind: "products"; products: import("@shared/schema").Product[] }
  | { kind: "product"; product: import("@shared/schema").Product | null }
  | { kind: "availability"; available: boolean; product: import("@shared/schema").Product | null }
  | { kind: "dietary"; evaluation: DietaryEvaluation; product: import("@shared/schema").Product | null }
  | { kind: "bestsellers"; items: Array<{ product: import("@shared/schema").Product; units_sold: number; revenue_cents: number }> }
  | { kind: "sales_stats"; stats: Record<string, unknown> }
  | { kind: "error"; message: string };

export interface DatabaseLike {
  prepare(sql: string): Prepared;
}

export interface Prepared {
  bind: (...values: unknown[]) => Prepared;
  run: () => Promise<unknown>;
  first: () => Promise<unknown>;
  all: () => Promise<unknown[]>;
}

export interface InferenceProvider {
  generate(messages: Array<{ role: "system" | "user" | "assistant"; content: string }>): Promise<{
    text: string;
  }>;
}
