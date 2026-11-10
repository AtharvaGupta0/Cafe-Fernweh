# Café Fernweh — Security audit

Café Fernweh is an AI chatbot and academic AI-behaviour research prototype. This document records the security design, the verified controls, the limitations that remain, and what must not be claimed about production readiness.

## Threat model and scope

- In scope: Worker backend (`src/server/`), admin dashboard + widget clients (`src/client/`), shared schemas (`src/shared/`), D1 database access, static asset serving, and the experimental evaluation runner (`experiments/`).
- Out of scope: any downstream website that embeds the widget (the widget is delivered as framework-independent static JS; embedding-site security is the embedder's responsibility).
- The prototype is not a payment system and stores no personal data. Sales records are fictional demonstration data only when `SEED_DEMO_DATA=true`.

## Credential isolation

- `GEMINI_API_KEY` and `ADMIN_TOKEN` are secrets configured server-side only (`.dev.vars` locally / Cloudflare Workers secrets in production). They are gitignored and never committed.
- The raw `ADMIN_TOKEN` is never stored: `admin-auth.ts` stores `sha256(token)` and compares with `timingSafeEqual`. The raw key never reaches the browser.
- Browser e2e checks confirm admin JS bundles contain no Gemini credentials.
- `DEV_ADMIN_TOKEN` gates experimental grounding modes A–C. It is unset in production; experimental configs are disabled there.

## Admin authentication

- Login: `POST /admin/login` verifies the bearer token against the stored `sha256` hash with constant-time comparison; on success it issues:
  - `cafe_session` cookie: `HttpOnly; SameSite=Lax; Max-Age=3600` (+ `Secure` on HTTPS).
  - `csrf_token` cookie: `SameSite=Lax; Max-Age=3600` (readable by JS for double-submit).
- Session expiry/invalidation: sessions are in-memory with a 1-hour TTL; `POST /admin/logout` destroys the session and clears both cookies (requires valid CSRF). Browser e2e verified logout invalidates the session and clears the cookie, and that state persists across reload only while authenticated.
- There are no default production credentials: if `ADMIN_TOKEN` is unset, login always fails with 401.

## CSRF binding to authenticated sessions

- Double-submit CSRF (`csrf_token` cookie + `X-CSRF-Token` header), PLUS session binding: the session stores a hash of the CSRF token issued at login, and `validateSessionCsrf` requires cookie/header match AND the active session's stored hash to match.
- All state-changing admin endpoints (`POST/DELETE /admin/menu`, `POST /admin/sales`, `POST /admin/sales/import`, `PUT .../ingredients`, `PUT .../allergens/verified`, `POST /admin/logout`) require this binding.
- GET endpoints require only a valid session (`requireAdmin`).
- Browser e2e verified: invalid CSRF → 403; valid session-bound CSRF → 200; logout CSRF works.

## Login throttling

- Per-IP login throttle: 5 failures within 5 minutes → 429 with `Retry-After`. Failures are cleared on successful login. Throttle state is in-memory per Worker isolate.

## Session scope limitation

- Sessions are stored in an in-memory `Map`, keyed by random session id. They are **per Worker isolate** and are not shared across Cloudflare Worker instances or deployments. For multi-instance production, back session state with a distributed store (KV/Durable Objects/Redis) or accept per-isolate login sessions.

## Experimental endpoint authorisation

- Grounding modes A (none), B (menu_context), C (retrieval) require `DEV_ADMIN_TOKEN` on the Worker AND a matching `EVAL_ADMIN_TOKEN`/`Authorization: Bearer` in the request.
- A non-production grounding request without a valid token returns **403**. It is never silently downgraded to D. (`GET /eval/status` is protected the same way and reports provider/model/prompt version/generation params without spending inference quota.)
- Mode D (retrieval_validation, production default) is publicly available without the admin token.

## Input validation

- All request bodies are validated with Zod at the boundary (`chatRequestSchema`, `adminProductSchema`, `ingredientIdsSchema`, `allergenVerifiedSchema`, sale items, etc.).
- `POST /chat` rejects malformed bodies with 400 before any inference.
- CSV import (`POST /admin/sales/import`) is capped at 5 MB, requires the `product_id,quantity,unit_price_cents` header, validates product ids/quantities/prices, rejects duplicate rows within an import, and returns per-row rejection reasons.

## Database security

- All database operations use parameterised SQL (sql.js locally, D1 bindings in production). No string interpolation of user input into queries.
- Schema is always initialized idempotently (`ensureInitialized`). Demo seed (`SEED_SQL`) runs only when `SEED_DEMO_DATA=true`; production must never auto-seed fictional menu/sales.

## Prompt-injection boundaries

- The system prompt (config-dependent) instructs the model to never invent menu facts and to prefer database tools for exact facts.
- The experimental runner sends only the user's question plus the grounding mode; no hidden menu/sales facts are injected into Config A prompts (see `VALIDITY-AUDIT.md`).
- The evaluation dataset includes a dedicated prompt-injection case (EVAL-010); live results are in `experiments/live-results.jsonl` and scored by `experiments/metrics.ts`.

## XSS-safe rendering

- Assistant replies are HTML-escaped before insertion into the DOM (`textContent`-only rendering in the widget; escaped output in the admin dashboard). Browser e2e verified an XSS payload renders as literal text, not executable markup.

## CORS

- `CORS_ALLOW_ORIGINS` is configurable (defaults to same-origin in `wrangler.toml`; local dev includes `http://127.0.0.1:5173`). The widget is same-origin with the API.

## Error handling

- All Worker errors return generic JSON messages with the appropriate status; stack traces and internals never leak to the client.

## Quota exhaustion and abuse protection

- Live Gemini inference is subject to the provider's free-tier rate limits. The runner is quota-conscious: bounded retries, 3s pacing between cases, consecutive-error abort, and resumable run IDs keyed by config+testId.
- Rate limiting is per IP per endpoint, in-memory, **per Worker isolate** — not global. An attacker distributed across isolates/instances is not globally rate-limited. For production, back rate-limit state with a distributed store.
- There is no global abuse protection beyond per-IP per-endpoint throttling on login and CSV size caps. Document or mitigate before exposing publicly.

## What must NOT be claimed

- "Production ready": do not claim production readiness while per-isolate session/rate state remains, there is no distributed abuse protection, and no WAF/DDoS layer is in place.
- "No credentials in bundles": verified for admin bundles only; never print or commit `GEMINI_API_KEY`.
- "Globally rate limited": the limiter is per-isolate; say so explicitly.

## Verification

- Browser e2e suite (`tests/browser/e2e.mjs`): login/logout, cookies (HttpOnly/SameSite=Lax/Secure-on-HTTPS), CSRF invalid/valid, menu API auth, logout persistence, no credentials in bundles, no console errors.
- Widget e2e: Shadow DOM CSS isolation, open/close/focus, `/chat` 200 + reply, XSS-safe rendering, keyboard Enter/Escape, mobile 390×844 layout, friendly offline error.
- Unit suite: 64 tests pass including 5 grounding-gating tests (403 on missing/wrong token, 200 on valid token, public D allowed, `/eval/status` protected).