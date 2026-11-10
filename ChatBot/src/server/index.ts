import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { prettyJSON } from "hono/pretty-json";

import { wrapD1, wrapSqlJs, type D1Database, execStatements, readOne } from "./lib/db";
import { SCHEMA_SQL, SEED_SQL } from "./lib/init-sql";
import { runConversation, escapeHtml } from "./lib/orchestration";
import { createConversationState, type ConversationState } from "./lib/state";
import { createProvider, getInferenceConfigFromEnv } from "./inference";
import { chatRequestSchema, type ChatResponse, type GroundingMode } from "@shared/schema";

interface Env {
  DB?: D1Database;
  AI_PROVIDER?: string;
  AI_MODEL?: string;
  GEMINI_API_KEY?: string;
  AI_REQUEST_TIMEOUT_MS?: string;
  MAX_CONVERSATION_TURNS?: string;
  MAX_MESSAGE_LENGTH?: string;
  CORS_ALLOW_ORIGINS?: string;
  DEV_ADMIN_TOKEN?: string;
}

const DEFAULT_MAX_MESSAGE_LENGTH = 2000;
const DEFAULT_MAX_TURNS = 10;

// In-memory conversation store for the standalone demo (bounded per session).
// Not persistent across Worker isolates; sufficient for a single deployment.
const conversations = new Map<string, Array<{ role: "user" | "assistant"; content: string }>>();
const conversationStates = new Map<string, ConversationState>();

// Very simple in-memory rate limiter (requests per window per IP).
const rateLimit = new Map<string, { count: number; resetAt: number }>();
function allowRequest(ip: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = rateLimit.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimit.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count += 1;
  return true;
}

function getCorsOrigins(env: Env): string[] {
  const raw = env.CORS_ALLOW_ORIGINS || "http://localhost:5173";
  return raw.split(",").map((o) => o.trim()).filter(Boolean);
}

function getDatabase(env: Env) {
  if (env.DB && typeof (env.DB as D1Database).prepare === "function") {
    return wrapD1(env.DB as unknown as D1Database);
  }
  // Standalone fallback: sql.js in-memory database (no D1 binding available).
  try {
    const sqljs = require("sql.js");
    const Database = (sqljs as { default: unknown }).default || sqljs;
    const db = new (Database as any)();
    execStatements(db as any, SCHEMA_SQL);
    return wrapSqlJs(db as any);
  } catch {
    return null;
  }
}

let dbInitPromise: Promise<void> | null = null;
async function ensureInitialized(db: ReturnType<typeof getDatabase>): Promise<void> {
  if (!db) return;
  if (dbInitPromise) return dbInitPromise;
  dbInitPromise = (async () => {
    try {
      const row = (await readOne(db, "SELECT COUNT(*) AS c FROM categories") as { c?: unknown } | null);
      if (Number(row?.c ?? 0) > 0) return;
      await execStatements(db as any, SCHEMA_SQL);
      await execStatements(db as any, SEED_SQL);
    } catch {
      // Best-effort initialization; endpoints will report if the DB is not ready.
    }
  })();
  return dbInitPromise;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const app = new Hono<{ Bindings: Env }>();

    app.use("*", prettyJSON());
    app.use(
      "*",
      cors({
        origin: getCorsOrigins(env),
        allowMethods: ["GET", "POST", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization", "X-Fernweh-Eval"],
        credentials: false,
        maxAge: 600,
      })
    );

    // Rate limiting: 60 requests per minute per IP.
    app.use("*", async (c, next) => {
      const ip = c.req.header("CF-Connecting-IP") || "unknown";
      if (!allowRequest(ip, 60, 60_000)) {
        throw new HTTPException(429, { message: "Too many requests. Please slow down." });
      }
      await next();
    });

    app.get("/health", (c) => c.json({ status: "ok", service: "cafe-fernweh" }));

    app.get("/menu", async (c) => {
      const db = getDatabase(env);
      await ensureInitialized(db as any);
      if (!db) throw new HTTPException(503, { message: "Database not available." });
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { searchProducts } = await import("./lib/menu");
      const products = await searchProducts(db as any, { query: "", limit: 100 });
      return c.json({ products });
    });

    app.get("/menu/:id", async (c) => {
      const db = getDatabase(env);
      await ensureInitialized(db as any);
      if (!db) throw new HTTPException(503, { message: "Database not available." });
      const { getProduct } = await import("./lib/menu");
      const id = Number(c.req.param("id"));
      const product = await getProduct(db as any, id);
      if (!product) throw new HTTPException(404, { message: "Product not found." });
      return c.json({ product });
    });

    app.get("/bestsellers", async (c) => {
      const db = getDatabase(env);
      await ensureInitialized(db as any);
      if (!db) throw new HTTPException(503, { message: "Database not available." });
      const { getBestsellers } = await import("./lib/menu");
      const items = await getBestsellers(db as any, 10);
      return c.json({ items });
    });

    app.get("/sales-stats", async (c) => {
      const db = getDatabase(env);
      await ensureInitialized(db as any);
      if (!db) throw new HTTPException(503, { message: "Database not available." });
      const { getSalesStats } = await import("./lib/menu");
      return c.json({ stats: await getSalesStats(db as any) });
    });

    app.post("/chat", async (c) => {
      const db = getDatabase(env);
      await ensureInitialized(db as any);
      if (!db) throw new HTTPException(503, { message: "Database not available." });

      const raw = await c.req.json<{ message?: unknown; conversation_id?: unknown; grounding?: unknown }>();
      const parsed = chatRequestSchema.safeParse(raw);
      if (!parsed.success) {
        throw new HTTPException(400, { message: "Invalid request body." });
      }

      const { message, conversation_id, grounding } = parsed.data;

      // Experimental grounding configs are gated: only honoured with the dev
      // admin token. Otherwise customers always get the production config.
      let groundingMode: string;
      if (grounding && env.DEV_ADMIN_TOKEN) {
        const adminToken = c.req.header("Authorization") || c.req.header("X-Fernweh-Admin-Token") || "";
        if (adminToken === `Bearer ${env.DEV_ADMIN_TOKEN}`) {
          groundingMode = grounding;
        } else {
          groundingMode = "retrieval_validation";
        }
      } else {
        groundingMode = "retrieval_validation";
      }

      const config = getInferenceConfigFromEnv({
        AI_PROVIDER: env.AI_PROVIDER,
        AI_MODEL: env.AI_MODEL,
        GEMINI_API_KEY: env.GEMINI_API_KEY,
        AI_REQUEST_TIMEOUT_MS: env.AI_REQUEST_TIMEOUT_MS,
      });
      const provider = createProvider(config);

      const id = conversation_id || crypto.randomUUID();
      const history = conversations.get(id) || [];
      const state = conversationStates.get(id) || createConversationState();
      const maxTurns = Number(env.MAX_CONVERSATION_TURNS || DEFAULT_MAX_TURNS);
      const maxMessageLength = Number(env.MAX_MESSAGE_LENGTH || DEFAULT_MAX_MESSAGE_LENGTH);

      if (message.length > maxMessageLength) {
        throw new HTTPException(400, { message: "Message too long." });
      }

      const {
        reply,
        groundingMode: usedMode,
        usedTools,
        products,
        state: nextState,
      } = await runConversation(
        {
          db: db as any,
          provider,
          groundingMode,
          maxMessageLength,
          maxTurns,
          state,
        },
        message,
        history
      );

      history.push({ role: "user", content: message });
      history.push({ role: "assistant", content: reply });
      conversations.set(id, history.slice(-maxTurns));
      conversationStates.set(id, nextState);

      const response: ChatResponse = {
        reply,
        grounding_mode: usedMode as GroundingMode,
        used_tools: usedTools,
        products,
      };
      return c.json({ ...response, conversation_id: id });
    });

    app.onError((err, c) => {
      // Safe error responses: never leak stack traces or internal details to the client.
      const status = err instanceof HTTPException ? err.status : 500;
      const message = err instanceof HTTPException ? (err.message as string) : "Internal server error.";
      return c.json({ error: message }, status);
    });

    return app.fetch(request, env);
  },
};
