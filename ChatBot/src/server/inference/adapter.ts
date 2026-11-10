import { InferenceProvider } from "@shared/types";

export interface InferenceConfig {
  provider: "gemini" | "demo";
  model: string;
  apiKey?: string;
  timeoutMs: number;
}

// Single source of truth for generation parameters. These are reported by
// /eval/status and recorded by the evaluation runner so trials are
// reproducible; change them only with a prompt-version bump.
export const GENERATION_TEMPERATURE = 0.3;
export const GENERATION_MAX_OUTPUT_TOKENS = 800;

export interface InferenceResult {
  text: string;
  provider: string;
  model: string;
  simulated: boolean;
}

/**
 * Reads inference configuration from environment variables.
 *
 * Provider credentials (GEMINI_API_KEY) are read server-side only and are
 * never returned to the browser.
 */
export function getInferenceConfigFromEnv(env: Record<string, string | undefined>): InferenceConfig {
  const provider = (env.AI_PROVIDER || "demo") as "gemini" | "demo";
  return {
    provider,
    model: env.AI_MODEL || "gemini-2.5-flash-lite",
    apiKey: env.GEMINI_API_KEY,
    timeoutMs: Number(env.AI_REQUEST_TIMEOUT_MS || 30000),
  };
}

/**
 * Factory for inference providers. Swapping providers only requires adding a
 * new provider and updating this factory; the rest of the backend is
 * provider-independent.
 */
export function createProvider(config: InferenceConfig): InferenceProvider {
  switch (config.provider) {
    case "gemini":
      return createGeminiProvider(config);
    case "demo":
    default:
      return createDemoProvider(config);
  }
}

/** -----------------------------------------------------------------------
 * Gemini provider (Google Generative Language API)
 * ---------------------------------------------------------------------- */

function createGeminiProvider(config: InferenceConfig): InferenceProvider {
  if (!config.apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. Set it server-side, or set AI_PROVIDER=demo for a demonstration mode."
    );
  }

  return {
    async generate(messages) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

      try {
        // Separate system instruction from conversation turns.
        const system = messages.find((m) => m.role === "system");
        const turns = messages.filter((m) => m.role !== "system");

        const contents = turns.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        }));

        const body: Record<string, unknown> = {
          contents,
          generationConfig: {
            temperature: GENERATION_TEMPERATURE,
            maxOutputTokens: GENERATION_MAX_OUTPUT_TOKENS,
          },
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
          ],
        };
        if (system) {
          body.systemInstruction = { parts: [{ text: system.content }] };
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`;
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        const responseText = await response.text();
        if (!response.ok) {
          let detail = responseText;
          try {
            const parsed = JSON.parse(responseText);
            detail = parsed.error?.message || responseText;
          } catch {
            // ignore parse errors
          }
          throw new Error(
            `Gemini API error (${response.status}): ${detail}`
          );
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(responseText);
        } catch {
          throw new Error("Gemini API returned a non-JSON response.");
        }

        const candidates = (parsed as { candidates?: unknown[] }).candidates;
        if (!Array.isArray(candidates) || candidates.length === 0) {
          throw new Error("Gemini API returned no candidates.");
        }
        const parts = (candidates[0] as { content?: { parts?: unknown[] } })
          .content?.parts;
        if (!Array.isArray(parts)) {
          throw new Error("Gemini API candidate had no text parts.");
        }
        const text = parts
          .map((p) => (p as { text?: unknown }).text)
          .filter((t): t is string => typeof t === "string")
          .join("");

        if (!text) {
          throw new Error("Gemini API returned an empty response.");
        }

        return { text, provider: "gemini", model: config.model, simulated: false };
      } finally {
        clearTimeout(timeoutId);
      }
    },
  };
}

/** -----------------------------------------------------------------------
 * Demo provider — development demonstration only.
 *
 * Returns clearly-labelled simulated responses. Never claims to be a real
 * model. Used when AI_PROVIDER=demo or no credentials are available.
 * ----------------------------------------------------------------------- */

const SIMULATED_MENU_NOTE =
  "[SIMULATED — this is a demonstration response, not generated by a real model. Set GEMINI_API_KEY and AI_PROVIDER=gemini for real inference.]";

function createDemoProvider(config: InferenceConfig): InferenceProvider {
  return {
    async generate(messages) {
      // Small deterministic simulation so the app is demonstrable without
      // credentials. It is grounded in a tiny hardcoded menu summary.
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const userText = (lastUser?.content || "").toLowerCase();

      let answer = "I'm running in demonstration mode without a real AI model. ";
      if (userText.includes("menu") || userText.includes("what")) {
        answer +=
          "Here is a simulated overview of Café Fernweh's menu: espresso ₹90, " +
          "americano ₹110, cappuccino ₹160, latte ₹170, masala chai ₹60, " +
          "mint lemonade ₹100, veg samosa ₹50, and butter croissant ₹110. " +
          "Prices are fictional and shown as a demonstration.";
      } else {
        answer += "I can help you browse our menu, check prices, availability, " +
          "and dietary information once connected to a real model.";
      }

      return {
        text: answer + "\n\n" + SIMULATED_MENU_NOTE,
        provider: "demo",
        model: config.model,
        simulated: true,
      };
    },
  };
}
