import { describe, it, expect } from "vitest";
import app from "../src/server/index";

function envWith(token: string) {
  return {
    ADMIN_TOKEN: token,
    AI_PROVIDER: "demo",
    AI_MODEL: "gemini-3.5-flash-lite",
    CORS_ALLOW_ORIGINS: "http://localhost:5173",
  } as any;
}

async function postJson(app: any, env: any, path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    env
  );
}

describe("admin routes", () => {
  const validToken = "admin-secret-token-for-testing";
  const env = envWith(validToken);

  it("login rejects when ADMIN_TOKEN not configured", async () => {
    const res = await postJson(app, { ...env, ADMIN_TOKEN: "" }, "/admin/login", {
      token: "anything",
    });
    expect(res.status).toBe(401);
  });

  it("login rejects wrong token", async () => {
    const res = await postJson(app, env, "/admin/login", { token: "wrong" });
    expect(res.status).toBe(401);
  });

  it("login succeeds with correct token and sets session + csrf cookies", async () => {
    const res = await postJson(app, env, "/admin/login", { token: validToken });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("cafe_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("csrf_token=");
  });

  it("state-changing endpoint requires authentication (no cookie = 401)", async () => {
    const res = await postJson(app, env, "/admin/menu", {
      category_id: 1,
      name: "X",
      description: "d",
      price_cents: 100,
    });
    expect(res.status).toBe(401);
  });

  it("state-changing endpoint requires CSRF token (cookie but no header = 403)", async () => {
    // First log in to get a session cookie.
    const login = await postJson(app, env, "/admin/login", { token: validToken });
    const cookie = login.headers.get("Set-Cookie") ?? "";
    const sessionMatch = cookie.match(/(?:^|;\s*)cafe_session=([^;]+)/);
    const sessionCookie = sessionMatch ? `cafe_session=${sessionMatch[1]}` : "";

    const res = await postJson(
      app,
      env,
      "/admin/menu",
      {
        category_id: 1,
        name: "X",
        description: "d",
        price_cents: 100,
      },
      { Cookie: sessionCookie }
    );
    expect(res.status).toBe(403);
  });

  it("logout without CSRF token is rejected (403)", async () => {
    const login = await postJson(app, env, "/admin/login", { token: validToken });
    const cookie = login.headers.get("Set-Cookie") ?? "";
    const res = await app.fetch(
      new Request("http://localhost/admin/logout", {
        method: "POST",
        headers: { Cookie: cookie },
      }),
      env
    );
    expect(res.status).toBe(403);
  });
});
