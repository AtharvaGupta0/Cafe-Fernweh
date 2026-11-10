# Café Fernweh — Experimental Baseline (Sprint 1)

## Purpose
This directory captures the lightweight evaluation foundation for the academic
AI behaviour study. The four experimental configurations are selectable
server-side only (never an unrestricted customer-facing setting):

- **A** — Model without menu grounding (baseline)
- **B** — Model with static menu context in the prompt
- **C** — Model with structured database retrieval (tool use)
- **D** — Model with retrieval + deterministic validation (production default)

Configuration is gated by `DEV_ADMIN_TOKEN` via the `Authorization` /
`X-Fernweh-Admin-Token` header; public customers always receive mode **D**.

## Baseline status
**No baseline results have been captured.** Sprint 1 running in this
environment uses `AI_PROVIDER=demo` (no `GEMINI_API_KEY` available), so no
real-model inference has been executed and no latency/outcome data exists.
The dataset at `experiments/eval-dataset.json` defines the cases, expected
outcomes and failure categories. When `GEMINI_API_KEY` is provisioned, run
`experiments/eval-runner.ts` against mode A first to capture the baseline,
then B, C and D, recording: prompt version, model identifier, experimental
configuration, test identifier, timestamp, actual response, latency and
evaluation outcome. Results must not be fabricated.

## How to run
1. Copy `.env.example` to `.env` and set `GEMINI_API_KEY` and
   `AI_PROVIDER=gemini`.
2. Start the backend: `npm run dev:server`.
3. Run the eval runner: `npx tsx experiments/eval-runner.ts` (writes
   `experiments/results.jsonl`).
4. Review results per failure category; no result may be recorded unless it
   was produced by a live model call.

## Dataset
See `experiments/eval-dataset.json` (12 cases across invented products,
incorrect prices, unknown allergens, dietary restrictions, unavailable items,
unsupported sales claims, multiple constraints, ambiguous requests, prompt
injection and equivalent re-wordings).
