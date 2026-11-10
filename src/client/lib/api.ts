export interface ChatResponse {
  reply: string;
  conversation_id: string;
  grounding_mode: string;
  used_tools: string[];
  products: Array<{
    id: number;
    category: string | undefined;
    name: string;
    price_inr: string;
    available: boolean;
    dietary_classification: string;
    ingredients: string[];
  }>;
}

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) || "http://localhost:8787";

export async function postChat({
  message,
  conversationId,
  groundingMode,
}: {
  message: string;
  conversationId?: string;
  groundingMode?: string;
}): Promise<ChatResponse> {
  const response = await fetch(`${API_BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      conversation_id: conversationId,
      grounding: groundingMode || "retrieval_validation",
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(body || `Request failed (${response.status})`);
  }

  return response.json();
}

export async function fetchHealth(): Promise<{ status: string }> {
  const response = await fetch(`${API_BASE}/health`);
  if (!response.ok) throw new Error(`Health check failed (${response.status})`);
  return response.json();
}
