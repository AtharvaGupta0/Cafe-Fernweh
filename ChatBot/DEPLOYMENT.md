# Café Fernweh — Deployment readiness

Deployment checklist for Cloudflare Workers + D1. Nothing here authorises a public deploy; a deploy requires explicit authorisation and account access.

## Prerequisites (never commit)

- `GEMINI_API_KEY` — Workers secret (never in git).
- `ADMIN_TOKEN` — strong random value, Workers secret/variable. No default; login fails if unset.
- `AI_PROVIDER=gemini`, `AI_MODEL=gemini-3.5-flash-lite`.
- `CORS_ALLOW_ORIGINS` — your site origins (same-origin default in `wrangler.toml`).
- `DEV_ADMIN_TOKEN` — **leave unset in production** (experimental configs A–C disabled).
- `SEED_DEMO_DATA` — unset in production (demo seed disabled; default).
- No paid resources; D1 free tier is sufficient for the prototype.

## Database readiness (order matters)

1. Provision D1 database, bind as `DB` in `wrangler.toml`.
2. Apply `db/migrations/0001_initial.sql` (schema).
3. Apply `db/migrations/0002_seed.sql` ONLY with explicit approval for fictional demonstration data in that environment.
4. Schema is always initialized idempotently by `ensureInitialized` on startup, but migrations are the source of truth for production.

## Static assets and API routing

- `wrangler.toml`: `[assets] directory = "./public" binding = "ASSETS"` (single-table form).
- Explicit `API_ROUTES` so `/admin/`, `/chat`, `/health`, `/eval/status` are handled by the Hono app; everything else is served as a same-origin asset.
- Build all three bundles before deploying:
  - `npm run build:client` → `public/client/`
  - `npm run build:admin` → `public/admin/`
  - `npm run build:widget` → `public/widget/`
- Verify: `npx wrangler deploy --dry-run` should list the expected assets (24 at last check).

## Same-origin requirement

- Client, admin dashboard, and widget are served from the same origin as the API so HttpOnly admin session cookies work in browsers.

## Config gating in production

- `AI_PROVIDER=demo` (default in `wrangler.toml`) runs clearly-labelled demo mode without spending model quota.
- With `AI_PROVIDER=gemini` + `GEMINI_API_KEY`, live inference runs; free-tier quota applies.
- `DEV_ADMIN_TOKEN` unset → `/chat` returns 403 for any non-D grounding request; only D (production default) is available.

## Rollback and backup

- Rollback: previous Worker deployment via `wrangler deploy --rollback` or redeploy the prior bundle version; D1 migrations are additive and idempotent.
- Backup: export D1 data before any migration; the in-memory dev database (sql.js) is not persistent.
- Do not insert fictional sales into a real production DB without approval.

## Known operational notes

- Sessions and rate-limit state are in-memory per Worker isolate; not shared across instances.
- Live Gemini inference is quota-limited; experimental A–D runs are one observation per case per config and may be incomplete if quota is exhausted (see `experiments/live-results.jsonl` and `VALIDITY-AUDIT.md`).