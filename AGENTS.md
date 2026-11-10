# Café Fernweh — Agent & Contributor Guidelines

## Team ownership boundaries

This repository is shared by two independent development teams. Each team owns
exactly one top-level directory and must not modify the other team's directory.

| Directory | Owning team | Purpose |
|-----------|-------------|---------|
| `ChatBot/` | Chatbot team | AI-powered café chatbot: frontend, backend, database, inference, evaluation |
| `Website/` | Website team | Café website (chatbot embeds here as a widget) |

## Rules

1. **Never modify files under `Website/`** unless you are a member of the
   website development team. The chatbot team owns only `ChatBot/`.
2. **Never modify files under `ChatBot/`** unless you are a member of the
   chatbot development team.
3. Keep shared repository-level configuration at the root only when necessary
   (`.gitignore`, `AGENTS.md`, `README.md`).
4. All chatbot source, config, database, tests and experiments live under
   `ChatBot/`.
5. Do not commit credentials, API keys, `.env`, `.dev.vars`, local databases,
   or temporary logs. Credentials are gitignored.
6. Use feature-based Conventional Commits (`feat`, `fix`, `test`, `docs`,
   `chore`, `refactor`, `security`, `perf`).
7. Do not push to GitHub without explicit authorisation.

## Running the chatbot

All chatbot commands run from `ChatBot/`:

```bash
cd ChatBot
npm install        # install dependencies (once)
npm run typecheck  # TypeScript check
npm test           # Vitest suite
npm run build:client  # production client build
npm run dev:server  # Cloudflare Worker (localhost:8787)
npm run dev:client  # Vite dev server (localhost:5173)
```

See `ChatBot/README.md` for full setup and embedding instructions.
