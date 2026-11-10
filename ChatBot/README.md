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

Four grounding configurations are supported server-side (gated behind the
`DEV_ADMIN_TOKEN`, never exposed publicly):

- **A** — model without menu grounding (baseline)
- **B** — model with static menu context in the prompt
- **C** — model with structured database retrieval
- **D** — model with retrieval + deterministic validation (production default)

See `ChatBot/experiments/` for the evaluation dataset and runner.

## Security

- Inference credentials are server-side only and gitignored.
- Experimental/admin endpoints require authorisation.
- No secrets are shipped to the browser.

## Embedding the widget

The widget is a framework-independent vanilla Web Component. It does not
require the host site to use React.

Build the widget bundle:

```bash
npm run build:widget   # -> ChatBot/public/widget/cafe-chatbot-widget.js
```

Embed on any page:

```html
<script src="/path/to/cafe-chatbot-widget.js"></script>
<cafe-chatbot api-base="https://your-worker.example.com"></cafe-chatbot>
```

- `api-base` points to the running Café Fernweh Worker (default
  `http://localhost:8787`). It is configurable per instance via the
  attribute.
- All styling lives in shadow DOM and will not conflict with the host site.
- No inference credentials are shipped to the browser; all AI calls go
  through the backend.
- The standalone chat (Vite dev server at `npm run dev:client`) continues to
  work independently.

## Security

- Inference credentials are server-side only and gitignored (`.dev.vars`,
  `.env`); nothing secret reaches the browser.
- Experimental/admin endpoints require authorisation (`DEV_ADMIN_TOKEN` for
  configs, `ADMIN_TOKEN` + session cookie for admin).
- Admin sessions use HttpOnly, SameSite cookies with SHA-256-hashed token
  verification and constant-time comparison.
- All database operations use parameterised SQL; all admin input is validated
  with Zod at the boundary.
- Rate limiting is per IP per endpoint using in-memory state, which is per
  Worker isolate and not shared across Cloudflare Worker instances. For
  production, back rate-limit state with a distributed store (KV/Redis).
- Errors return generic messages; no stack traces or internals leak to the
  client. Assistant replies are HTML-escaped before rendering.

## Commands

| Command | Purpose |
|---------|---------|
| `npm run typecheck` | TypeScript check |
| `npm test` | Vitest suite |
| `npm run build:client` | Production client build |
| `npm run dev:server` | Local Worker |
| `npm run dev:client` | Local Vite dev server |
| `npm run db:init` | Seed local database |
