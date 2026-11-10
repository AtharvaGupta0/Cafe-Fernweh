# Café Fernweh ChatBot

The Café Fernweh chatbot is a standalone AI-powered café assistant and academic
AI behaviour research prototype. It runs independently of the main café website
and can later be embedded into it as a framework-independent widget.

## What it does

- Natural-language customer questions about a fictional café menu
- Multi-turn conversational context with constraint carry-over
- Menu browsing, price/category/availability filtering
- Ingredient, dietary-restriction and allergen handling
- Bestseller and sales-based recommendations from recorded transactions
- Deterministic validation of model-generated factual claims
- Four experimental grounding configurations (A–D) for AI behaviour research
- Administrative interface (protected) and sales management (manual + CSV import)
- Embeddable framework-independent chat widget

## Tech stack

- React + TypeScript + Vite (frontend)
- Tailwind CSS (styling)
- Cloudflare Workers + Hono (backend)
- Cloudflare D1 / SQLite (database)
- Gemini 2.5/3.5 Flash-Lite (inference, server-side only)
- Vitest (testing)
- Zod (runtime validation)

## Directory layout

```
ChatBot/
├── src/
│   ├── client/     # React frontend (standalone + widget)
│   ├── server/     # Cloudflare Workers backend (Hono)
│   └── shared/     # Zod schemas and types shared by client and server
├── db/             # D1 schema, migrations and seed data
├── tests/          # Vitest suite
├── experiments/    # AI behaviour evaluation dataset and runner
├── scripts/        # local database seeding
├── public/         # built client output + static assets
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── tailwind.config.js
├── postcss.config.js
└── wrangler.toml
```

## Setup

```bash
cd ChatBot
npm install
cp .env.example .env        # fill in GEMINI_API_KEY for live inference
npm run db:init             # seed the local database (sql.js)
npm run typecheck
npm test
```

## Running

Standalone demonstration (two terminals):

```bash
# Terminal 1: backend
npm run dev:server          # http://localhost:8787

# Terminal 2: frontend
npm run dev:client          # http://localhost:5173
```

Or run the backend against a local D1:

```bash
npm run dev:server -- --local
```

## Experimental configurations

Four grounding configurations are supported server-side:

- **A** — model without menu grounding (baseline)
- **B** — model with static menu context in the prompt
- **C** — model with structured database retrieval
- **D** — model with retrieval + deterministic validation (production default)

D is always available. A, B and C are experimental and require both
`DEV_ADMIN_TOKEN` on the Worker and a matching `EVAL_ADMIN_TOKEN` in the
runner. If the token is missing or wrong, `/chat` returns **403** rather than
silently falling back to D. `GET /eval/status` (protected) reports the
server's actual provider, model, prompt version and generation parameters
without spending model quota.

See `ChatBot/experiments/` for the evaluation dataset, runner, metrics and
`VALIDITY-AUDIT.md`. Historical raw files are append-only and are not rewritten;
new runs must use a new results file (the runner defaults to
`experiments/live-results.jsonl`).

## Security

- Inference credentials are server-side only and gitignored (`.dev.vars`,
  `.env`); nothing secret reaches the browser.
- Experimental/admin endpoints require authorisation (`DEV_ADMIN_TOKEN` for
  configs, `ADMIN_TOKEN` + session cookie for admin). A non-production
  grounding request without a valid token is rejected with 403; it is never
  silently downgraded.
- Admin sessions use HttpOnly, SameSite=Lax cookies with SHA-256-hashed token
  verification and constant-time comparison. CSRF protection is
  session-bound: the `csrf_token` cookie and `X-CSRF-Token` header must match
  each other and the active server-side session. Login attempts are throttled
  per IP (5 failures / 5 minutes).
- All database operations use parameterised SQL; all admin input is validated
  with Zod at the boundary.
- Rate limiting is per IP per endpoint using in-memory state, which is per
  Worker isolate and not shared across Cloudflare Worker instances. For
  production, back rate-limit state with a distributed store (KV/Redis).
- Errors return generic messages; no stack traces or internals leak to the
  client. Assistant replies are HTML-escaped before rendering.

## Admin dashboard

The admin dashboard is a React application built to `ChatBot/public/admin/`.
It is served from the same origin as the API so HttpOnly session cookies work
in production.

1. Copy `.env.example` to `.dev.vars` and set `ADMIN_TOKEN` to a strong,
   randomly generated value (never commit it).
2. Start the backend: `npm run dev:server -- --local`.
3. Open `http://localhost:8787/admin/` and sign in with the admin token.
4. Endpoints: `POST /admin/login`, `POST /admin/logout`,
   `GET/POST/DELETE /admin/menu`, `GET/POST /admin/sales`,
   `POST /admin/sales/import`, `GET /admin/sales`.

All write endpoints require a valid session and a `X-CSRF-Token` header
matching the `csrf_token` cookie (double-submit CSRF protection).

## Deployment

The Worker is deployed to Cloudflare Workers with the D1 database bound as
`DB`.

```bash
cd ChatBot
npm run build:client      # frontend bundle -> public/client/
npm run build:widget      # widget bundle -> public/widget/
npm run build:server      # wrangler deploy --dry-run (verify)
npx wrangler deploy       # deploy to Cloudflare Workers (requires auth)
```

### Production environment

Set these as Cloudflare Workers secrets/variables in the dashboard:

- `AI_PROVIDER=gemini`
- `AI_MODEL=gemini-3.5-flash-lite`
- `GEMINI_API_KEY=<your key>` (secret — never commit)
- `ADMIN_TOKEN=<strong random token>` (secret — required for admin access)
- `CORS_ALLOW_ORIGINS=<your site origins>`
- `DEV_ADMIN_TOKEN` — leave unset in production (experimental configs disabled)

`AI_PROVIDER` defaults to `demo` in `wrangler.toml`, so the Worker runs in
clearly-labelled demonstration mode unless `GEMINI_API_KEY` and
`AI_PROVIDER=gemini` are configured.

`wrangler.toml` uses the supported single-table form
`[assets] directory = "./public" binding = "ASSETS"` with explicit API routes.
The Worker serves the client, admin dashboard and widget from the same origin,
so HttpOnly admin session cookies work in production. Build all three static
bundles before deploying:

```bash
npm run build:client
npm run build:admin
npm run build:widget
```

## Database

Schema and seed data live in `db/`:
- `db/schema.sql` — human-readable reference schema.
- `db/migrations/0001_initial.sql` — D1 migration.
- `db/migrations/0002_seed.sql` — idempotent fictional menu + sales seed.
- `db/seeds/seed.sql` — same seed content, reusable via `scripts/init-db.js`.

Local development uses a sql.js in-memory database. The schema is always
created idempotently, but fictional menu/sales demo rows are inserted only when
`SEED_DEMO_DATA=true`. For a real deployment, provision D1, apply
`db/migrations/0001_initial.sql`, and do **not** run `0002_seed.sql` unless you
have explicit approval to use fictional demonstration data in that environment.
See `DEPLOYMENT.md` for the deployment and rollback checklist.

## Known limitations

- The in-memory rate limiter and conversation store are per Worker isolate
  and are not shared across Cloudflare Worker instances.
- The admin dashboard must be served from the same origin as the API for
  HttpOnly session cookies to work in the browser.
- Live Gemini inference is subject to the provider's free-tier rate limits;
  experimental runs are quota-conscious (bounded retries, pacing) and may be
  incomplete if quota is exhausted.
- The experimental evaluation runner records genuinely generated responses;
  objectively checkable claims are validated against the database, while
  generative responses that cannot be objectively checked are marked
  "unverified" and require manual review. Demo-provider records are excluded
  from all primary denominators.
- Historical evaluation records contain mislabelled Config A attempts that
  actually ran Config D. See `experiments/VALIDITY-AUDIT.md`; they are preserved
  but not used as A evidence. A corrected A–D comparison must be collected with
  `DEV_ADMIN_TOKEN`/`EVAL_ADMIN_TOKEN` and the returned-mode check.
- Statistical significance is not claimed: the design has one observation per
  case per configuration, and any category-level count may have a denominator
  of only a few cases.

## Commands

| Command | Purpose |
|---------|---------|
| `npm run typecheck` | TypeScript check |
| `npm test` | Vitest suite |
| `npm run build:client` | Production client build |
| `npm run build:widget` | Production widget build |
| `npm run build:admin` | Production admin dashboard build |
| `npm run build:server` | Wrangler deploy dry-run (verify) |
| `npm run dev:server` | Local Worker (`--local` for D1) |
| `npm run dev:client` | Local Vite dev server |
| `npm run dev:server -- --local` | Local Worker with local D1 |
| `npm run db:init` | Seed local database (sql.js) |
| `npx tsx experiments/runner.ts` | Run the configured live evaluation (append-only) |
| `npx tsx experiments/metrics.ts [file]` | Metrics with exclusions and per-config denominators |
| `npx tsx experiments/eval-runner.ts` | Offline demo/tooling checks only (not model evidence) |

