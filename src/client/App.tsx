import { useState, useEffect } from "react";
import { Chat } from "./components/Chat";
import { fetchHealth } from "./lib/api";

export default function App() {
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
    fetchHealth()
      .then(() => setOnline(true))
      .catch(() => setOnline(false));
  }, []);

  return (
    <div className="min-h-screen bg-brown-50 text-brown-900">
      <main className="max-w-2xl mx-auto h-[calc(100vh-2rem)]">
        {online === null ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-brown-500">Connecting to Café Fernweh…</p>
          </div>
        ) : online === false ? (
          <div className="flex h-full flex-col items-center justify-center text-center px-6">
            <h2 className="text-xl font-serif font-semibold text-brown-900 mb-2">Café Fernweh</h2>
            <p className="text-brown-500 mb-4">
              Could not connect to the chatbot server. Make sure the backend is running
              (see PROJECT README / `npm run dev:server`) and that VITE_API_URL points to it.
            </p>
            <button onClick={() => window.location.reload()} className="rounded-full bg-brown-600 text-white px-5 py-2 text-sm font-medium hover:bg-brown-700">
              Retry
            </button>
          </div>
        ) : (
          <Chat />
        )}
      </main>
    </div>
  );
}
