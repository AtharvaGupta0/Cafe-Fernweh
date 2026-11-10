import { describe, it, expect } from "vitest";
import {
  hashToken,
  verifyToken,
  createSession,
  getSession,
  destroySession,
  adminSessionCookie,
  clearAdminSessionCookie,
  csrfTokenCookie,
  clearCsrfTokenCookie,
  generateCsrfToken,
  validateCsrf,
} from "../src/server/lib/admin-auth";

describe("admin auth", () => {
  it("hashToken is deterministic and differs across tokens", () => {
    const a = hashToken("secret-token");
    const b = hashToken("secret-token");
    const c = hashToken("other-token");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.length).toBe(64); // sha256 hex
  });

  it("verifyToken accepts matching token and rejects wrong/malformed", () => {
    const stored = hashToken("correct-token");
    expect(verifyToken("correct-token", stored)).toBe(true);
    expect(verifyToken("wrong-token", stored)).toBe(false);
    expect(verifyToken("", stored)).toBe(false);
    expect(verifyToken("correct-token", "not-a-hex-hash")).toBe(false);
    // Constant-time comparison: different-length hash returns false without throwing.
    expect(verifyToken("a".repeat(100), "short")).toBe(false);
  });

  it("session create/get/destroy round trip", () => {
    const sid = createSession("token-x", 3600_000);
    expect(typeof sid).toBe("string");
    expect(sid.length).toBeGreaterThan(0);
    const session = getSession(sid);
    expect(session).not.toBeNull();
    expect(session!.tokenHash).toBe(hashToken("token-x"));
    destroySession(sid);
    expect(getSession(sid)).toBeNull();
  });

  it("session stores hashed token", () => {
    const sid = createSession("token-y", 3600_000);
    expect(getSession(sid)!.tokenHash).toBe(hashToken("token-y"));
  });

  it("admin session cookie is HttpOnly, SameSite=Lax, Secure only over https", () => {
    const secureCookie = adminSessionCookie("sid", true);
    const insecureCookie = adminSessionCookie("sid", false);
    expect(secureCookie).toContain("HttpOnly");
    expect(secureCookie).toContain("SameSite=Lax");
    expect(secureCookie).toContain("Secure");
    expect(secureCookie).toContain("Max-Age=3600");
    expect(secureCookie).toContain("cafe_session=sid");
    expect(insecureCookie).toContain("HttpOnly");
    expect(insecureCookie).toContain("SameSite=Lax");
    expect(insecureCookie).not.toContain("Secure");
    const cleared = clearAdminSessionCookie(true);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("Secure");
  });

  it("csrf token cookie round trip via validateCsrf", () => {
    const token = generateCsrfToken();
    const cookie = csrfTokenCookie(token, false);
    expect(validateCsrf(cookie, token)).toBe(true);
    expect(validateCsrf(cookie, "different-token")).toBe(false);
    expect(validateCsrf(cookie, null)).toBe(false);
    expect(validateCsrf(null, token)).toBe(false);
    expect(validateCsrf("", token)).toBe(false);
    // Cookie without csrf_token should fail even if header present.
    expect(validateCsrf("cafe_session=abc", token)).toBe(false);
    const cleared = clearCsrfTokenCookie(true);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("Secure");
    expect(cleared).not.toContain("HttpOnly"); // JS-readable
  });

  it("generateCsrfToken produces unique tokens", () => {
    const a = generateCsrfToken();
    const b = generateCsrfToken();
    expect(a).not.toBe(b);
    expect(a.length).toBe(64);
  });
});
