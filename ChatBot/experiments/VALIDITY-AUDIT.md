# Experimental validity audit — 2026-11-10

This document audits the existing evaluation artefacts for the Café Fernweh AI
behaviour study. It does **not** rewrite raw results. Raw JSONL files are kept
byte-for-byte as produced; corrections, reclassifications and exclusions are
recorded here and in the analysis/reporting code.

## 1. Sources audited

| Artefact | SHA-256 (at audit time) | Produced by |
|---|---|---|
| `baseline-results.jsonl` | `c2a63e205088a20171f0c88ed35c9e081e524871ebd89ecaa589d4774ee039c2` | `baseline-live.mjs` (legacy 12-case dataset, v1.0) |
| `results.jsonl` | `9897705251b4b52078ffe0d70cdedfabeed843cd0d1b41fe4f154544cad077b4` | `eval-runner.ts` demo pass + `runner.ts` runs |
| `results-v2.jsonl` | `6d6c5b23639481c958e4e3a802d6b1ac97bc8d5bec27d75962c68847879e9de2` | `runner.ts` run `cafe-1794323029753-6nc7kp` |
| `eval-dataset.json` | `880552b25e2c5d699ed4a3ad7002b79f26682d3c88fb362bbdf18916cf21754c` | Dataset v1.1, 24 cases |
| `baseline-live.mjs` | `c6c29c9fc75b6662dd5e0992dff55eb62dabeac094f485d55883a4c7da8e7192` | Legacy Config A runner |

Relevant code paths at audit time:

- `src/server/index.ts` `/chat`: requested experimental grounding was honoured
  only when `DEV_ADMIN_TOKEN` was configured **and** the bearer token matched;
  otherwise the request silently ran `retrieval_validation` (Config D).
- `experiments/runner.ts`: requested mode came from `EVAL_GROUNDING_MODE` or the
  dataset case, but `experimentalConfig` was written from the dataset case's
  default (`D`), and the server's returned `grounding_mode` was not recorded.
- `experiments/runner.ts` sent only `question` for the follow-up case, without
  `precedingQuestion` or a `conversation_id`.
- `experiments/metrics.ts` counted demo records and every HTTP-200 record
  regardless of whether the requested experimental mode was actually used.

## 2. Findings

### F1 — The legacy Config A baseline is genuine, with limitations

`baseline-results.jsonl` contains **9 live records** (`EVAL-001`, `-002`, `-003`,
`-004`, `-006`, `-007`, `-010`, `-011`, `-012`) with:

- `provider: "gemini"`, `model: "gemini-3.5-flash-lite"`, `simulated: false`
- `experimentId: "CAFE-FERNWEH-BASELINE-2026"`
- `groundingMode: "none"`, `experimentalConfig: "A - model without menu grounding"`
- `promptVersion: "sprint-1-system-prompt-v1"`, temperature 0.3, max output 800
- `httpStatus: 200`, no error

The responses contain **no exact café menu or sales facts**. They repeatedly say
the model is running without access to the live menu and declines to confirm
prices, allergens, availability or bestsellers. This is consistent with the
`systemPromptFor("none")` branch, which contains no menu data and no tool
catalog. Example (`EVAL-002`, question: “Is the Espresso ₹5.00?”):

> “Because I am running without access to Café Fernweh's live menu database
> right now, I cannot confirm the exact price of an espresso. However, I can
> tell you that ₹5.00 is quite low for an espresso…”

The supplied `₹5.00` is repeated only as a user premise (“quite low”), not as a
verified price. This is not evidence that the model knows the real price; it is
the opposite (correct abstention under A). `EVAL-003` similarly gives generic
espresso ingredients but refuses to declare the item safe without allergen
verification; `EVAL-007` declines to confirm the bestseller claim.

**Conclusion:** these 9 records are valid Config A observations. They are not a
complete A–D comparison: they cover only 9 of the 12 v1.0 cases, have no B/C/D
counterparts, and rely on a separate script for provenance rather than a
returned-mode field. They may be reported as a historical A-only baseline, with
that limitation stated.

### F2 — The newer “Config A” runs actually executed Config D and are invalid as A evidence

Two newer live runs requested `groundingMode: "none"` but their replies contain
facts that only the database tools / retrieval path can supply:

| Run | Case | Requested | Recorded label | Reply evidence |
|---|---|---|---|---|
| `cafe-1794322940161-jecsag` (`results.jsonl`) | `EVAL-014` | `none` | `D` | “total number of transactions … is **28**, with total revenue of **₹6,070.00**” |
| same | `EVAL-015` | `none` | `D` | “cheapest item … **Masala Chai**, priced at **₹60.00**” |
| same | `EVAL-013` | `none` | `D` | refuses a fake 50% latte discount (policy-compatible, but not A-proven) |
| `cafe-1794323029753-6nc7kp` (`results-v2.jsonl`) | `EVAL-002` | `none` | `D` | “No, the Espresso is **₹90.00**” |
| same | `EVAL-003` | `none` | `D` | no exact-price evidence in the stored reply; still not A-proven |
| same | `EVAL-001` | `none` | `D` | HTTP 500 error, no model output |

`28` transactions, `₹6,070.00`, `Masala Chai ₹60.00` and `Espresso ₹90.00` are
seeded database facts. They are not in the Config A system prompt, the user
questions, or any A-only history. They therefore demonstrate that the server
executed a retrieval/validation path, not Config A. The `grounding_mode` returned
by the server was not stored by the runner, so the raw records cannot prove the
mode directly; the content and the server gating code do.

**Root causes (all fixed or being fixed in this step):**

1. **Silent server downgrade.** If `DEV_ADMIN_TOKEN` was unset or the bearer
   token did not match, `/chat` silently ran `retrieval_validation` and returned
   HTTP 200. The exact environment used for these two runs was not recorded.
   This is an experimental-validity and least-surprise defect: a request for A
   must never silently become D.
2. **Misleading runner label.** `experiments/runner.ts` wrote
   `experimentalConfig: c.groundingMode`, i.e. the dataset case's default `D`,
   instead of the config actually requested. Even a correctly honoured A run
   would have been labelled D.
3. **No returned-mode check.** The runner did not read
   `grounding_mode` from the response, so it could not detect a downgrade.
4. **Follow-up case was not set up.** `EVAL-015` was sent as a bare “Which of
   those is the cheapest?” with no preceding question and no `conversation_id`.
   Even under A, the answer could not test whether the cold-coffee constraint
   was preserved. The `“Masala Chai ₹60”` answer is therefore a D-mode answer to
   an under-specified question, not a constraint-following result.
5. **Resumption keyed only by test ID.** `loadCompletedIds()` skipped a case if
   *any* record with that test ID existed, across all configurations. A D run
   would block a later A/B/C run in the same file.
6. **Retries were not actually bounded-retried.** `runCase()` caught network and
   HTTP failures and returned an error record, so the outer `runWithRetry()`
   saw a resolved promise and never retried. The EVAL-001 HTTP 500 was recorded
   as a single error, not a retried transient failure.

**Reclassification:** the live records in `results.jsonl` and
`results-v2.jsonl` that requested `none` are **not Config A evidence**. They are
single, mislabelled Config D observations. `EVAL-001` in `results-v2.jsonl` is an
infrastructure error, not a model-behaviour failure. None of these records may be
used to claim that Config A “refused a discount”, “corrected the price”, “cited
sales data” or “lost the follow-up constraint”. Those claims belonged to Config D
(if to any config), and only after a valid returned-mode check.

### F3 — Demo records are not model trials

`results.jsonl` also contains 24 records with `simulated: true` and
`provider: "demo"`, plus a demo/tooling SUMMARY. They were produced by
`eval-runner.ts` using deterministic database operations and the demo inference
provider. They are useful for tooling checks but are **not** observations of
model behaviour and must be excluded from every denominator. The original
metrics script did not exclude them; this is corrected in `metrics.ts`.

### F4 — Dataset defaults are not experimental assignments

All 24 cases in `eval-dataset.json` v1.1 carry `groundingMode: "D"`. That field
documents the production/expected mode of the scenario, not the configuration
for a particular trial. A comparative run must override it explicitly for each
of A, B, C and D. The old `baseline-live.mjs` hard-coded `none`; the old runner
used the dataset default unless `EVAL_GROUNDING_MODE` was set. The corrected
runner requires an explicit config/mode for non-default runs and records it.

## 3. Corrected evidence inventory

| Evidence class | Records | Valid for analysis? | Use |
|---|---:|---|---|
| Legacy A baseline (`baseline-results.jsonl`) | 9 live | Yes, A-only, historical | Descriptive A baseline; limitations stated |
| New live `none` requests (`results.jsonl`, `results-v2.jsonl`) | 5 HTTP 200 + 1 error | No as A; reclassified D | Excluded from A–D comparison; may be cited only as invalid/mislabel examples |
| Demo (`results.jsonl`) | 24 | No | Tooling/smoke only |
| SUMMARY/manifest rows | 4 | No | Operational metadata only |
| Genuine corrected A–D comparison | **0 at audit time** | — | Must be collected; see §5 |

There is therefore **no complete, valid 24-case × A/B/C/D dataset in the
repository at audit time**. Any report must say so rather than presenting the
legacy 9 A records or the mislabelled D records as a comparative result.

## 4. Remediation implemented with this audit

- `/chat` now **rejects** an experimental grounding request with HTTP 403 when
  `DEV_ADMIN_TOKEN` is not configured or the presented token does not match. It
  no longer silently downgrades to D. Public clients that request D (or omit
  `grounding`) are unaffected.
- A protected `GET /eval/status` endpoint lets the runner verify that
  experimental grounding is enabled and retrieve the server's actual provider,
  model, prompt version and generation parameters before spending quota.
- `/chat` responses include `prompt_version`; the runner records the returned
  `grounding_mode`, requested mode, config label and a validity flag.
- The runner maps A/B/C/D explicitly, requires an eval token for non-D runs,
  performs a no-inference preflight, sets up the two-turn follow-up case, keys
  resumption by config + test ID, records a run manifest (dataset version,
  prompt version, model, generation parameters, DB snapshot summary) and only
  marks a record valid when the returned mode matches the request and the
  provider is a real model.
- `metrics.ts` excludes demo, SUMMARY, errored and invalid/mislabelled records
  from primary denominators, separates documented legacy A records, and reports
  exclusions and per-config denominators explicitly.
- Regression tests cover the 403 gating and the returned-mode validity rules.

Raw JSONL files are not modified. New runs must go to a new append-only file
(e.g. `experiments/live-results.jsonl`) so the historical artefacts remain
auditable.

## 5. Remaining work / requirements for a defensible comparison

1. Configure `DEV_ADMIN_TOKEN` on the server and `EVAL_ADMIN_TOKEN` for the
   runner. Never commit either.
2. Probe Gemini quota with **one** minimal request. If quota is exhausted, stop
   and mark the comparison incomplete; do not loop or fabricate.
3. If quota is available, run all 24 cases sequentially for each of A, B, C, D
   into a new append-only file, with the same model, prompt version and
   generation parameters. The follow-up case must be a real two-turn
   conversation.
4. Do not make statistical significance claims from one observation per case.
   Report descriptive counts and denominators; repeat runs only if quota and
   design permit.
5. Record exclusions (demo, errors, invalid provenance) in the analysis and
   report. Missing categories are reported as incomplete, not as successes.
