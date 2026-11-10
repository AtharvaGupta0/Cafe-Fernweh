interface MessageBubbleProps {
  role: "customer" | "assistant";
  content: string;
}

export function MessageBubble({ role, content }: MessageBubbleProps) {
  const isCustomer = role === "customer";
  return (
    <div
      className={`flex w-full mb-6 ${
        isCustomer ? "justify-end" : "justify-start"
      }`}
    >
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm ${
          isCustomer
            ? "bg-brown-600 text-white"
            : "bg-white text-brown-800 border border-brown-200"
        }`}
      >
        {content}
      </div>
    </div>
  );
}
