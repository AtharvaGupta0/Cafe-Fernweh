/**
 * Administrative authentication (server-side only).
 *
 * Minimal secure authentication for the prototype admin interface.
 * Credentials are verified server-side; nothing secret reaches the browser.
 * Sessions are in-memory (sufficient for a single Worker deployment; not
 * globally reliable across Cloudflare Worker isolates).
 */

import { createHash, timingSafeEqual } from "crypto";
import { z } from "zod";

const ADMIN_TOKEN_SCHEMA = z.string().min(1);

interface AdminSession {
  tokenHash: string;
  createdAt: number;
  ttlMs: number;
}

// In-memory session store keyed by a random session id.
// Not persistent across Worker isolates; prototype-appropriate.
const sessions = new Map<string, AdminSession>();

/**
 * Derive a storable hash from the raw admin token. Never store or log the
 * raw token.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Verify a candidate admin token against a stored hash using constant-time
 * comparison. Returns false for malformed input.
 */
export function verifyToken(candidate: string, storedHash: string): boolean {
  const parsed = ADMIN_TOKEN_SCHEMA.safeParse(candidate);
  if (!parsed.success) return false;
  const candidateHash = createHash("sha256").update(parsed.data).digest("hex");
  if (candidateHash.length !== storedHash.length) return false;
  return timingSafeEqual(
    Buffer.from(candidateHash, "utf8"),
    Buffer.from(storedHash, "utf8")
  );
}

/**
 * Create a session for a verified admin token. Returns a session id to be
 * set as an HttpOnly, SameSite cookie by the caller.
 */
export function createSession(token: string, ttlMs: number): string {
  const sessionId = createHash("sha256")
    .update(`${token}${Date.now()}${Math.random()}`)
    .digest("hex");
  sessions.set(sessionId, {
    tokenHash: hashToken(token),
    createdAt: Date.now(),
    ttlMs,
  });
  return sessionId;
}

/**
 * Validate an existing session id. Returns null when absent or expired.
 */
export function getSession(sessionId: string): AdminSession | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (Date.now() - session.createdAt > session.ttlMs) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

/**
 * Destroy a session.
 */
export function destroySession(sessionId: string): void {
  sessions.delete(sessionId);
}

/**
 * Parse the session id from a Cookie header. Returns null when missing.
 */
export function sessionIdFromCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)cafe_session=([^;]+)/);
  return match ? (match[1] ?? null) : null;
}

/** Build a Set-Cookie header for the admin session. */
export function adminSessionCookie(sessionId: string, secure: boolean): string {
  return `cafe_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600${secure ? "; Secure" : ""}`;
}

/** Build a Set-Cookie header to clear the admin session. */
export function clearAdminSessionCookie(secure: boolean): string {
  return `cafe_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

/** Build a Set-Cookie header for the double-submit CSRF token (readable by JS). */
export function csrfTokenCookie(token: string, secure: boolean): string {
  return `csrf_token=${token}; Path=/; SameSite=Lax; Max-Age=3600${secure ? "; Secure" : ""}`;
}

/** Build a Set-Cookie header to clear the CSRF token. */
export function clearCsrfTokenCookie(secure: boolean): string {
  return `csrf_token=; Path=/; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

/** Generate a random double-submit CSRF token. */
export function generateCsrfToken(): string {
  return createHash("sha256")
    .update(`${Date.now()}${Math.random()}`)
    .digest("hex");
}

/**
 * Verify the double-submit CSRF token: the X-CSRF-Token header must match the
 * csrf_token cookie value. Returns false when either is missing or they differ.
 */
export function validateCsrf(
  cookieHeader: string | null | undefined,
  headerToken: string | null | undefined
): boolean {
  if (!headerToken) return false;
  const cookieToken = sessionIdFromCookie(cookieHeader);
  // sessionIdFromCookie looks for cafe_session; reuse the pattern for csrf_token.
  const csrfMatch = cookieHeader
    ? cookieHeader.match(/(?:^|;\s*)csrf_token=([^;]+)/)
    : null;
  const cookieCsrf = csrfMatch ? (csrfMatch[1] ?? null) : null;
  if (!cookieCsrf || !cookieCsrf.length) return false;
  if (cookieCsrf.length !== headerToken.length) return false;
  return timingSafeEqual(
    Buffer.from(cookieCsrf, "utf8"),
    Buffer.from(headerToken, "utf8")
  );
}

export type { AdminSession };
