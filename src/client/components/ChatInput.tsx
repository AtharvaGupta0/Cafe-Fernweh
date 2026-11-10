interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => Promise<void>;
  disabled: boolean;
}

export function ChatInput({ value, onChange, onSubmit, disabled }: ChatInputProps) {
  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!value.trim() || disabled) return;
    await onSubmit(value.trim());
  }

  return (
    <form onSubmit={handleSubmit} className="sticky bottom-0 w-full pt-3 pb-4 backdrop-blur bg-brown-50/80 border-t border-brown-200">
      <div className="max-w-2xl mx-auto px-4">
        <div className="relative">
          <input
            id="chat-input"
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Ask about the menu, prices, ingredients, or dietary needs…"
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-full border border-brown-300 bg-white px-5 py-3 text-brown-900 placeholder-brown-400 focus:outline-none focus:ring-2 focus:ring-brown-500 focus:border-transparent disabled:opacity-60 disabled:cursor-not-allowed"
            aria-label="Your message"
          />
          <button
            type="submit"
            disabled={disabled || !value.trim()}
            className="absolute right-2 top-2 rounded-full bg-brown-600 text-white px-4 py-2.5 text-sm font-medium hover:bg-brown-700 focus:outline-none focus:ring-2 focus:ring-brown-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            aria-label="Send message"
          >
            Send
          </button>
        </div>
      </div>
    </form>
  );
}
