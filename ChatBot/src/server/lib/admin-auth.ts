/**
 * Administrative authentication (server-side only).
 *
 * Minimal secure authentication for the prototype admin interface.
 * Credentials are verified server-side; nothing secret reaches the browser.
 * Sessions are in-memory (sufficient for a single Worker deployment; not
 * globally reliable across Cloudflare Worker isolates).
 *
 * CSRF uses a double-submit cookie that is additionally bound to the server
 * side session: the session stores a hash of the CSRF token issued at login,
 * and state-changing requests must present the same token in the readable
 * cookie and the X-CSRF-Token header. This prevents a token minted for one
 * session from being replayed against another.
 */

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { z } from "zod";

const ADMIN_TOKEN_SCHEMA = z.string().min(1);

interface AdminSession {
  tokenHash: string;
  csrfTokenHash: string;
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
 * set as an HttpOnly, SameSite cookie by the caller, plus the CSRF token that
 * is bound to that session.
 */
export function createSession(
  token: string,
  ttlMs: number
): { sessionId: string; csrfToken: string } {
  const sessionId = randomBytes(32).toString("hex");
  const csrfToken = randomBytes(32).toString("hex");
  sessions.set(sessionId, {
    tokenHash: hashToken(token),
    csrfTokenHash: hashToken(csrfToken),
    createdAt: Date.now(),
    ttlMs,
  });
  return { sessionId, csrfToken };
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

function cookieValue(
  cookieHeader: string | null | undefined,
  name: string
): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? (match[1] ?? null) : null;
}

/**
 * Parse the session id from a Cookie header. Returns null when missing.
 */
export function sessionIdFromCookie(cookieHeader: string | null | undefined): string | null {
  return cookieValue(cookieHeader, "cafe_session");
}

/** Parse the CSRF token from a Cookie header. */
export function csrfTokenFromCookie(cookieHeader: string | null | undefined): string | null {
  return cookieValue(cookieHeader, "csrf_token");
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

/** Generate a random CSRF token. */
export function generateCsrfToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Verify the double-submit part of CSRF protection: the X-CSRF-Token header
 * must match the csrf_token cookie value. Returns false when either is missing
 * or they differ.
 */
export function validateCsrf(
  cookieHeader: string | null | undefined,
  headerToken: string | null | undefined
): boolean {
  if (!headerToken) return false;
  const cookieToken = csrfTokenFromCookie(cookieHeader);
  if (!cookieToken) return false;
  if (cookieToken.length !== headerToken.length) return false;
  return timingSafeEqual(
    Buffer.from(cookieToken, "utf8"),
    Buffer.from(headerToken, "utf8")
  );
}

/**
 * Full CSRF validation for an authenticated request: the double-submit pair
 * must match AND the token must match the hash bound to the active session.
 */
export function validateSessionCsrf(
  sessionId: string,
  cookieHeader: string | null | undefined,
  headerToken: string | null | undefined
): boolean {
  if (!sessionId || !headerToken) return false;
  if (!validateCsrf(cookieHeader, headerToken)) return false;
  const session = getSession(sessionId);
  if (!session) return false;
  const headerHash = hashToken(headerToken);
  return timingSafeEqual(
    Buffer.from(headerHash, "utf8"),
    Buffer.from(session.csrfTokenHash, "utf8")
  );
}

export type { AdminSession };
