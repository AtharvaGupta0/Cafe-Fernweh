import { useState, useCallback, useEffect, useRef } from "react";
import { postChat } from "../lib/api";
import { MessageBubble } from "./MessageBubble";
import { ChatInput } from "./ChatInput";
import { ProductCard } from "./ProductCard";

interface MenuProduct {
  id: number;
  category: string | undefined;
  name: string;
  price_inr: string;
  available: boolean;
  dietary_classification: string;
  ingredients: string[];
}

interface ChatProps {
  apiBase?: string;
}

export function Chat({ apiBase }: ChatProps = {}) {
  const [messages, setMessages] = useState<Array<{ role: "customer" | "assistant"; content: string }>>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [products, setProducts] = useState<MenuProduct[] | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };
  useEffect(() => { scrollToBottom(); }, [messages, products, loading, error]);

  const handleSubmit = useCallback(
    async (value: string) => {
      setError(null);
      setLoading(true);
      try {
        const data = await postChat({
          message: value,
          conversationId,
          groundingMode: "retrieval_validation",
        });
        setConversationId(data.conversation_id);
        setMessages((prev) => [...prev, { role: "customer", content: value }, { role: "assistant", content: data.reply }]);
        setProducts(data.products || null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      } finally {
        setLoading(false);
      }
    },
    [conversationId]
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex-shrink-0 px-6 py-4 border-b border-brown-200 bg-brown-50/60">
        <h1 className="text-xl font-serif font-semibold text-brown-900 tracking-tight">Café Fernweh</h1>
        <p className="text-[12px] text-brown-500 mt-0.5">Chatbot demo · fictional menu · server-grounded responses</p>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-8">
        {messages.length === 0 && (
          <div className="max-w-xl mx-auto text-center text-brown-400 text-sm italic">
            Welcome to Café Fernweh. Ask me about our menu, prices, availability, ingredients,
            dietary needs, or recommendations.
          </div>
        )}
        {error && (
          <div className="max-w-xl mx-auto rounded-lg border border-red-200 bg-red-50 p-4 text-red-800 text-sm mb-6">
            {error}
          </div>
        )}
        {messages.map((m, i) => (
          <MessageBubble key={i} role={m.role} content={m.content} />
        ))}
        {loading && (
          <div className="flex justify-start mb-6">
            <div className="max-w-[85%] rounded-2xl border border-brown-200 bg-white p-3 text-sm text-brown-500 italic">
              Café Fernweh is thinking…
            </div>
          </div>
        )}
        {products && products.length > 0 && (
          <div className="max-w-2xl mx-auto mb-6">
            <p className="text-[12px] uppercase tracking-wider font-bold text-brown-500 mb-2">Related menu items</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {products.map((p) => (
                <ProductCard key={p.id} product={p} />
              ))}
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <ChatInput value={input} onChange={setInput} onSubmit={handleSubmit} disabled={loading} />
    </div>
  );
}
