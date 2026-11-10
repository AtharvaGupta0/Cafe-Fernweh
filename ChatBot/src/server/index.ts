import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { prettyJSON } from "hono/pretty-json";

import { wrapD1, wrapSqlJs, type D1Database, execStatements, readOne } from "./lib/db";
import { SCHEMA_SQL, SEED_SQL } from "./lib/init-sql";
import { runConversation, escapeHtml } from "./lib/orchestration";
import { createConversationState, type ConversationState } from "./lib/state";
import {
  listProductsAdmin,
  getProductAdmin,
  upsertProductAdmin,
  deleteProductAdmin,
  listSalesAdmin,
  salesStatsAdmin,
  recordSaleAdmin,
  importSalesCsvAdmin,
  listIngredients,
  listAllergens,
  listProductIngredients,
  setProductIngredients,
  listProductAllergens,
  setAllergenVerified,
  type AdminProductInput,
  ingredientIdsSchema,
  allergenVerifiedSchema,
} from "./lib/admin";
import {
  verifyToken,
  createSession,
  getSession,
  destroySession,
  sessionIdFromCookie,
  adminSessionCookie,
  clearAdminSessionCookie,
  csrfTokenCookie,
  clearCsrfTokenCookie,
  validateSessionCsrf,
  hashToken,
} from "./lib/admin-auth";
import { createProvider, getInferenceConfigFromEnv } from "./inference";
import { chatRequestSchema, type ChatResponse, type GroundingMode } from "@shared/schema";

interface Env {
  DB?: D1Database;
  ASSETS?: Fetcher;
  AI_PROVIDER?: string;
  AI_MODEL?: string;
  GEMINI_API_KEY?: string;
  AI_REQUEST_TIMEOUT_MS?: string;
  MAX_CONVERSATION_TURNS?: string;
  MAX_MESSAGE_LENGTH?: string;
  CORS_ALLOW_ORIGINS?: string;
  DEV_ADMIN_TOKEN?: string;
  ADMIN_TOKEN?: string;
  SEED_DEMO_DATA?: string;
}

const DEFAULT_MAX_MESSAGE_LENGTH = 2000;
const DEFAULT_MAX_TURNS = 10;

// API routes handled by the Worker. Everything else is served as a static
// asset (customer chat, admin dashboard, widget) from the same origin so
// HttpOnly session cookies work across dev and production.
const API_ROUTES = [
  "/health",
  "/menu",
  "/bestsellers",
  "/sales-stats",
  "/chat",
  "/admin/login",
  "/admin/logout",
  "/admin/menu",
  "/admin/sales",
  "/admin/ingredients",
  "/admin/allergens",
];
function isApiRoute(pathname: string): boolean {
  return API_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(route + "/")
  );
}

// In-memory conversation store for the standalone demo (bounded per session).
// Not persistent across Worker isolates; sufficient for a single deployment.
const conversations = new Map<string, Array<{ role: "user" | "assistant"; content: string }>>();
const conversationStates = new Map<string, ConversationState>();

// Very simple in-memory rate limiter (requests per window per IP + endpoint).
// NOTE: in-memory state is per Worker isolate and is NOT shared across
// Cloudflare Worker instances or deployments. For production use a distributed
// backing store (e.g. KV/Redis) for rate-limit state. This is a prototype-
// appropriate guard, not a production-grade abuse-prevention system.
const rateLimit = new Map<string, { count: number; resetAt: number }>();
function allowRequest(ip: string, endpoint: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const key = `${ip}:${endpoint}`;
  const entry = rateLimit.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimit.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count += 1;
  return true;
}

// Dedicated login throttle: 5 failed attempts per IP per 5 minutes. Like the
// general limiter this is per Worker isolate, so it slows brute force but is
// not a globally distributed lockout. See SECURITY.md.
const loginFailures = new Map<string, { count: number; resetAt: number }>();
const LOGIN_WINDOW_MS = 5 * 60_000;
const LOGIN_MAX_FAILURES = 5;
function loginAllowed(ip: string): boolean {
  const entry = loginFailures.get(ip);
  if (!entry) return true;
  if (Date.now() > entry.resetAt) {
    loginFailures.delete(ip);
    return true;
  }
  return entry.count < LOGIN_MAX_FAILURES;
}
function recordLoginFailure(ip: string): void {
  const now = Date.now();
  const entry = loginFailures.get(ip);
  if (!entry || now > entry.resetAt) {
    loginFailures.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}
function clearLoginFailures(ip: string): void {
  loginFailures.delete(ip);
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

let dbSchemaPromise: Promise<void> | null = null;
let dbSeedPromise: Promise<void> | null = null;

/**
 * Create the schema if needed. Demo menu/sales data is only inserted when
 * SEED_DEMO_DATA is explicitly enabled (local development); production
 * databases must be provisioned and seeded deliberately, never automatically.
 */
async function ensureInitialized(
  db: ReturnType<typeof getDatabase>,
  seedDemoData: boolean
): Promise<void> {
  if (!db) return;
  if (!dbSchemaPromise) {
    dbSchemaPromise = (async () => {
      try {
        await execStatements(db as any, SCHEMA_SQL);
      } catch {
        // Best-effort initialization; endpoints will report if the DB is not ready.
      }
    })();
  }
  await dbSchemaPromise;

  if (!seedDemoData) return;
  if (!dbSeedPromise) {
    dbSeedPromise = (async () => {
      try {
        const row = (await readOne(db, "SELECT COUNT(*) AS c FROM categories")) as { c?: unknown } | null;
        if (Number(row?.c ?? 0) === 0) {
          await execStatements(db as any, SEED_SQL);
        }
      } catch {
        // Seeding is best effort and never runs in production by default.
      }
    })();
  }
  await dbSeedPromise;
}

async function getReadyDatabase(env: Env) {
  const db = getDatabase(env);
  await ensureInitialized(db, env.SEED_DEMO_DATA === "true");
  return db;
}


export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const app = new Hono<{ Bindings: Env }>();

    // Rate limiting applies to every request (API + static assets).
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!allowRequest(ip, new URL(request.url).pathname, 60, 60_000)) {
      return new Response(
        JSON.stringify({ error: "Too many requests. Please slow down." }),
        { status: 429, headers: { "Content-Type": "application/json" } }
      );
    }

    app.use("*", prettyJSON());
    app.use(
      "*",
      cors({
        origin: getCorsOrigins(env),
        allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowHeaders: [
          "Content-Type",
          "Authorization",
          "X-Fernweh-Eval",
          "X-CSRF-Token",
        ],
        credentials: true,
        maxAge: 600,
      })
    );

    app.get("/health", (c) => c.json({ status: "ok", service: "cafe-fernweh" }));

    app.get("/menu", async (c) => {
      const db = await getReadyDatabase(env);
      if (!db) throw new HTTPException(503, { message: "Database not available." });
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { searchProducts } = await import("./lib/menu");
      const products = await searchProducts(db as any, { query: "", limit: 100 });
      return c.json({ products });
    });

    app.get("/menu/:id", async (c) => {
      const db = await getReadyDatabase(env);
      if (!db) throw new HTTPException(503, { message: "Database not available." });
      const { getProduct } = await import("./lib/menu");
      const id = Number(c.req.param("id"));
      const product = await getProduct(db as any, id);
      if (!product) throw new HTTPException(404, { message: "Product not found." });
      return c.json({ product });
    });

    app.get("/bestsellers", async (c) => {
      const db = await getReadyDatabase(env);
      if (!db) throw new HTTPException(503, { message: "Database not available." });
      const { getBestsellers } = await import("./lib/menu");
      const items = await getBestsellers(db as any, 10);
      return c.json({ items });
    });

    app.get("/sales-stats", async (c) => {
      const db = await getReadyDatabase(env);
      if (!db) throw new HTTPException(503, { message: "Database not available." });
      const { getSalesStats } = await import("./lib/menu");
      return c.json({ stats: await getSalesStats(db as any) });
    });

    app.post("/chat", async (c) => {
      const db = await getReadyDatabase(env);
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

    // ---- Admin routes (protected) ----
    function requireAdmin(c: any): { sessionId: string } | never {
      const sessionId = sessionIdFromCookie(c.req.header("Cookie") ?? null);
      if (!sessionId || !getSession(sessionId)) {
        throw new HTTPException(401, { message: "Admin authentication required." });
      }
      return { sessionId };
    }

    /** Secure flag: only set on HTTPS (production); local dev over HTTP omits it. */
    function isSecure(c: any): boolean {
      return c.req.url.startsWith("https://");
    }

    /**
     * Require a valid CSRF token on state-changing requests. The token must
     * match both the readable cookie (double submit) and the hash bound to the
     * authenticated server-side session.
     */
    function requireCsrf(c: any): void {
      const cookieHeader = c.req.header("Cookie") ?? null;
      const sessionId = sessionIdFromCookie(cookieHeader);
      const headerToken = c.req.header("X-CSRF-Token") ?? null;
      if (!sessionId || !validateSessionCsrf(sessionId, cookieHeader, headerToken)) {
        throw new HTTPException(403, { message: "Invalid or missing CSRF token." });
      }
    }

    app.post("/admin/login", async (c) => {
      const ip = c.req.header("CF-Connecting-IP") || "unknown";
      if (!loginAllowed(ip)) {
        c.header("Retry-After", "300");
        throw new HTTPException(429, { message: "Too many login attempts. Try again later." });
      }
      const body = await c.req.json<{ token?: unknown }>();
      const token = typeof body?.token === "string" ? body.token : "";
      const stored = env.ADMIN_TOKEN;
      if (!stored || !verifyToken(token, hashToken(stored))) {
        recordLoginFailure(ip);
        throw new HTTPException(401, { message: "Invalid admin token." });
      }
      clearLoginFailures(ip);
      const secure = isSecure(c);
      const { sessionId, csrfToken } = createSession(token, 3600_000);
      return c.json(
        { ok: true },
        200,
        {
          "Set-Cookie": [
            adminSessionCookie(sessionId, secure),
            csrfTokenCookie(csrfToken, secure),
          ],
        }
      );
    });

    app.post("/admin/logout", (c) => {
      requireCsrf(c);
      const sessionId = sessionIdFromCookie(c.req.header("Cookie"));
      if (sessionId) destroySession(sessionId);
      const secure = isSecure(c);
      return c.json(
        { ok: true },
        200,
        {
          "Set-Cookie": [
            clearAdminSessionCookie(secure),
            clearCsrfTokenCookie(secure),
          ],
        }
      );
    });

    app.get("/admin/menu", async (c) => {
      requireAdmin(c);
      const db = await getReadyDatabase(env);
      if (!db) throw new HTTPException(503, { message: "Database not available." });
      const products = await listProductsAdmin(db as any);
      return c.json({ products });
    });

    app.post("/admin/menu", async (c) => {
      requireAdmin(c);
      requireCsrf(c);
      const db = await getReadyDatabase(env);
      if (!db) throw new HTTPException(503, { message: "Database not available." });
      const input = await c.req.json<AdminProductInput>();
      const result = await upsertProductAdmin(db as any, input);
      return c.json(result);
    });

    app.delete("/admin/menu/:id", async (c) => {
      requireAdmin(c);
      requireCsrf(c);
      const db = await getReadyDatabase(env);
      if (!db) throw new HTTPException(503, { message: "Database not available." });
      const id = Number(c.req.param("id"));
      await deleteProductAdmin(db as any, id);
      return c.json({ id });
    });

    app.get("/admin/sales", async (c) => {
      requireAdmin(c);
      const db = await getReadyDatabase(env);
      if (!db) throw new HTTPException(503, { message: "Database not available." });
      const [list, stats] = await Promise.all([
        listSalesAdmin(db as any),
        salesStatsAdmin(db as any),
      ]);
      return c.json({ list, stats });
    });

    app.post("/admin/sales", async (c) => {
      requireAdmin(c);
      requireCsrf(c);
      const db = await getReadyDatabase(env);
      if (!db) throw new HTTPException(503, { message: "Database not available." });
      const input = await c.req.json<{ items: Array<{ product_id: number; quantity: number; unit_price_cents: number }> }>();
      const result = await recordSaleAdmin(db as any, input);
      return c.json(result);
    });

    app.post("/admin/sales/import", async (c) => {
      requireAdmin(c);
      requireCsrf(c);
      const db = await getReadyDatabase(env);
      if (!db) throw new HTTPException(503, { message: "Database not available." });
      const body = await c.req.json<{ csv?: unknown }>();
      const csv = typeof body?.csv === "string" ? body.csv : "";
      const maxBytes = 5 * 1024 * 1024; // 5 MB limit
      if (new TextEncoder().encode(csv).length > maxBytes) {
        throw new HTTPException(413, { message: "CSV file too large." });
      }
      const result = await importSalesCsvAdmin(db as any, csv);
      return c.json(result);
    });

    app.get("/admin/ingredients", async (c) => {
      requireAdmin(c);
      const db = await getReadyDatabase(env);
      if (!db) throw new HTTPException(503, { message: "Database not available." });
      const ingredients = await listIngredients(db as any);
      return c.json({ ingredients });
    });

    app.get("/admin/allergens", async (c) => {
      requireAdmin(c);
      const db = await getReadyDatabase(env);
      if (!db) throw new HTTPException(503, { message: "Database not available." });
      const allergens = await listAllergens(db as any);
      return c.json({ allergens });
    });

    app.get("/admin/menu/:id/ingredients", async (c) => {
      requireAdmin(c);
      const db = await getReadyDatabase(env);
      if (!db) throw new HTTPException(503, { message: "Database not available." });
      const id = Number(c.req.param("id"));
      const ingredients = await listProductIngredients(db as any, id);
      return c.json({ ingredients });
    });

    app.put("/admin/menu/:id/ingredients", async (c) => {
      requireAdmin(c);
      requireCsrf(c);
      const db = await getReadyDatabase(env);
      if (!db) throw new HTTPException(503, { message: "Database not available." });
      const id = Number(c.req.param("id"));
      const body = await c.req.json<{ ingredient_ids?: unknown }>();
      const parsed = ingredientIdsSchema.safeParse(body);
      if (!parsed.success) {
        throw new HTTPException(400, { message: "Invalid ingredient list." });
      }
      await setProductIngredients(db as any, id, parsed.data.ingredient_ids);
      return c.json({ id });
    });

    app.get("/admin/menu/:id/allergens", async (c) => {
      requireAdmin(c);
      const db = await getReadyDatabase(env);
      if (!db) throw new HTTPException(503, { message: "Database not available." });
      const id = Number(c.req.param("id"));
      const allergens = await listProductAllergens(db as any, id);
      return c.json({ allergens });
    });

    app.put("/admin/menu/:id/allergens/:allergenId/verified", async (c) => {
      requireAdmin(c);
      requireCsrf(c);
      const db = await getReadyDatabase(env);
      if (!db) throw new HTTPException(503, { message: "Database not available." });
      const id = Number(c.req.param("id"));
      const allergenId = Number(c.req.param("allergenId"));
      const body = await c.req.json<{ verified?: unknown }>();
      const parsed = allergenVerifiedSchema.safeParse(body);
      if (!parsed.success) {
        throw new HTTPException(400, { message: "Invalid verified flag." });
      }
      await setAllergenVerified(db as any, id, allergenId, parsed.data.verified);
      return c.json({ id, allergenId, verified: parsed.data.verified });
    });

    app.onError((err, c) => {
      // Safe error responses: never leak stack traces or internal details to the client.
      const status = err instanceof HTTPException ? err.status : 500;
      const message = err instanceof HTTPException ? (err.message as string) : "Internal server error.";
      return c.json({ error: message }, status);
    });

    // API routes are handled by the Hono app; everything else is served as a
    // static asset from the same origin (customer chat, admin dashboard,
    // widget). Assets are bound via wrangler [assets].
    if (isApiRoute(new URL(request.url).pathname)) {
      return app.fetch(request, env);
    }
    if (!env.ASSETS) {
      return new Response("Not found", { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },
};
