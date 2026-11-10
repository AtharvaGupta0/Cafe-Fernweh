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
  validateSessionCsrf,
  csrfTokenFromCookie,
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
    const { sessionId, csrfToken } = createSession("token-x", 3600_000);
    expect(typeof sessionId).toBe("string");
    expect(sessionId.length).toBeGreaterThan(0);
    expect(typeof csrfToken).toBe("string");
    expect(csrfToken.length).toBe(64);
    const session = getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.tokenHash).toBe(hashToken("token-x"));
    destroySession(sessionId);
    expect(getSession(sessionId)).toBeNull();
  });

  it("session stores hashed token and hashed CSRF token", () => {
    const { sessionId, csrfToken } = createSession("token-y", 3600_000);
    const session = getSession(sessionId)!;
    expect(session.tokenHash).toBe(hashToken("token-y"));
    expect(session.csrfTokenHash).toBe(hashToken(csrfToken));
    expect(session.csrfTokenHash).not.toBe(csrfToken);
    destroySession(sessionId);
  });

  it("expired sessions are rejected and removed", () => {
    const { sessionId } = createSession("token-z", -1);
    expect(getSession(sessionId)).toBeNull();
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
    expect(csrfTokenFromCookie(cookie)).toBe(token);
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

  it("CSRF token is bound to the session that issued it", () => {
    const first = createSession("token-a", 3600_000);
    const second = createSession("token-b", 3600_000);
    const firstCookie = `${csrfTokenCookie(first.csrfToken, false)}; cafe_session=${first.sessionId}`;
    const secondCookie = `${csrfTokenCookie(second.csrfToken, false)}; cafe_session=${second.sessionId}`;

    // Correct pair for the first session.
    expect(validateSessionCsrf(first.sessionId, firstCookie, first.csrfToken)).toBe(true);
    // A valid token replayed against another session must fail.
    expect(validateSessionCsrf(second.sessionId, firstCookie, first.csrfToken)).toBe(false);
    // Header and cookie must still match.
    expect(validateSessionCsrf(first.sessionId, firstCookie, second.csrfToken)).toBe(false);
    // Expired/destroyed sessions fail closed.
    destroySession(first.sessionId);
    expect(validateSessionCsrf(first.sessionId, firstCookie, first.csrfToken)).toBe(false);
    destroySession(second.sessionId);
  });
});
