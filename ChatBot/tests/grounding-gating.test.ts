import { describe, it, expect, beforeAll } from "vitest";
import app from "../src/server/index";
import { createTestDb } from "./helpers";

const baseEnv = {
  ADMIN_TOKEN: "admin-secret-token-for-testing",
  AI_PROVIDER: "demo",
  AI_MODEL: "gemini-3.5-flash-lite",
  CORS_ALLOW_ORIGINS: "http://localhost:5173",
} as any;

let testDb: any;
beforeAll(async () => {
  testDb = await createTestDb();
});
function envWithDb(extra: Record<string, unknown> = {}) {
  return { ...baseEnv, DB: testDb, ...extra } as any;
}

function postChat(env: any, body: unknown, headers: Record<string, string> = {}) {
  return app.fetch(
    new Request("http://localhost/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    env
  );
}

describe("experimental grounding gating", () => {
  it("rejects a non-production mode when DEV_ADMIN_TOKEN is not configured", async () => {
    const res = await postChat(envWithDb(), { message: "Hello", grounding: "none" });
    expect(res.status).toBe(403);
  });

  it("rejects a non-production mode with a wrong token instead of downgrading", async () => {
    const res = await postChat(
      envWithDb({ DEV_ADMIN_TOKEN: "eval-secret" }),
      { message: "Hello", grounding: "none" },
      { Authorization: "Bearer wrong-token" }
    );
    expect(res.status).toBe(403);
  });

  it("honours a non-production mode with the correct token and reports it", async () => {
    const res = await postChat(
      envWithDb({ DEV_ADMIN_TOKEN: "eval-secret" }),
      { message: "Hello", grounding: "none" },
      { Authorization: "Bearer eval-secret" }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      grounding_mode?: string;
      prompt_version?: string;
      reply?: string;
    };
    expect(body.grounding_mode).toBe("none");
    expect(body.prompt_version).toBeTruthy();
    expect(typeof body.reply).toBe("string");
  });

  it("keeps production mode available without a token", async () => {
    const res = await postChat(envWithDb(), {
      message: "Hello",
      grounding: "retrieval_validation",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { grounding_mode?: string };
    expect(body.grounding_mode).toBe("retrieval_validation");
  });

  it("protects the evaluation preflight endpoint", async () => {
    const denied = await app.fetch(
      new Request("http://localhost/eval/status"),
      baseEnv
    );
    expect(denied.status).toBe(403);

    const allowed = await app.fetch(
      new Request("http://localhost/eval/status", {
        headers: { Authorization: "Bearer eval-secret" },
      }),
      { ...baseEnv, DEV_ADMIN_TOKEN: "eval-secret" }
    );
    expect(allowed.status).toBe(200);
    const body = (await allowed.json()) as {
      ok?: boolean;
      prompt_version?: string;
      provider?: string;
      generation_parameters?: { temperature?: number; maxOutputTokens?: number };
    };
    expect(body.ok).toBe(true);
    expect(body.prompt_version).toBeTruthy();
    expect(body.provider).toBe("demo");
    expect(body.generation_parameters?.temperature).toBe(0.3);
  });
});
