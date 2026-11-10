# Café Fernweh

Café Fernweh is an AI-powered café chatbot and academic AI behaviour research
project. It is developed by two independent teams sharing this repository.

## Repository layout

```
Cafe-Fernweh/
├── ChatBot/        # AI chatbot application (chatbot team)
└── Website/        # Café website (website team)
```

- **ChatBot/** — the standalone conversational chatbot: React/Vite frontend,
  Cloudflare Workers backend, Cloudflare D1 database, Gemini inference, and the
  AI behaviour evaluation harness. See `ChatBot/README.md` for how to run it.
- **Website/** — owned exclusively by the website development team. The chatbot
  is designed to be embedded here as a framework-independent widget (see
  `ChatBot/README.md` for embedding instructions). Do not modify this directory
  unless you are on the website team.

## Ownership

See `AGENTS.md` for team ownership boundaries and contribution guidelines.
