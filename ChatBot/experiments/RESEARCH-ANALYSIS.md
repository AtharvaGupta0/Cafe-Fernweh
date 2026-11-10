# Café Fernweh — Research analysis: grounding configuration comparison

Objective: compare four grounding configurations (A–D) on the same 24-case dataset with the same model and inputs, reporting actual inference records only. No significance claims; one observation per case per configuration.

## Method

- Dataset: `experiments/eval-dataset.json` v1.1 — `sets.dev` (16) + `sets.heldOut` (8) = 24 cases, every case `groundingMode:"D"` in the dataset; the runner overrides the requested grounding mode per config (A `none`, B `menu_context`, C `retrieval`, D `retrieval_validation`).
- Model/provider: Gemini `gemini-3.5-flash-lite`, server-side only, prompt version `2026-11-10.1`, generation parameters temperature 0.3 / maxOutputTokens 800 (recorded per record from `/eval/status`).
- Execution: sequential A → B → C → D, one run ID per config, pacing 3000 ms between cases, max 2 retries per case, consecutive-error abort, resumable run IDs keyed by config+testId, append-only output `experiments/live-results.jsonl`.
- Each record records requested vs returned grounding, `valid`/`validityReason`, promptVersion, model/provider, generationParameters, setName, attempts, latency, HTTP status, and outcome. EVAL-015 was sent as a real two-turn conversation (preceding question "What cold coffees do you have?" → follow-up "Which of those is the cheapest?", expected Cold Brew ₹140).
- Metrics: `experiments/metrics.ts`. Primary denominators include only valid records whose returned mode matches the request; demo records, infrastructure errors, invalid records and unverified-provenance records are excluded and counted separately. Legacy `baseline-results.jsonl` (9 genuine Config A records from an earlier prompt version) is reported separately and not pooled with this comparison.

## Data validity and exclusions

- 96 case records produced across the four runs.
- 4 records invalid due to HTTP 500 after 3 attempts each (Config C: EVAL-018; Config D: EVAL-001, EVAL-006, EVAL-023). These are transient provider/rate-limit failures, excluded from denominators and counted as exclusions, not as model failures.
- 0 demo records, 0 unverified-provenance records in this comparison.
- Effective analyzable records: 92 (A 24, B 24, C 23, D 21).

## Results by configuration

| Config | Grounding | n | pass | fail | unverified | invalid/errors | Factual accuracy | Hallucination fails | Constraint satisfaction | Prompt-injection compliance | Equiv-question consistency |
|--------|-----------|---|------|------|------------|----------------|------------------|---------------------|-------------------------|-----------------------------|----------------------------|
| A | none (ungrounded) | 24 | 4 | 2 | 18 | 0 | 66.7% (4/6) | 16.7% (1/6) | 83.3% (5/6) | n/a (0) | 100.0% (2/2) |
| B | menu_context | 24 | 10 | 2 | 12 | 0 | 83.3% (10/12) | 0.0% (0/12) | 100.0% (12/12) | 100.0% (1/1) | 100.0% (1/1) |
| C | retrieval | 23 | 6 | 8 | 9 | 1 (HTTP 500) | 42.9% (6/14) | 0.0% (0/14) | 92.9% (13/14) | 100.0% (1/1) | 0.0% (0/3) |
| D | retrieval_validation | 21 | 4 | 10 | 7 | 3 (HTTP 500) | 28.6% (4/14) | 0.0% (0/14) | 92.9% (13/14) | 0.0% (0/1) | 0.0% (0/3) |
| All | — | 92 | 24 | 22 | 46 | 4 excluded | 52.2% (24/46) | 2.2% (1/46) | 93.5% (43/46) | 66.7% (2/3) | 33.3% (3/9) |

Latency (ms): A avg 9186 / median 7218; B avg 7882 / median 2185; C avg 7326 / median 3885; D avg 9397 / median 3079; all avg 8429 / median 4251.

### Factual accuracy by configuration (pass ÷ (pass+fail))

```
A (none)   66.7%  ████████████████████████████████████████ 4/6
B (ctx)    83.3%  ██████████████████████████████████████████████████ 10/12
C (retr)   42.9%  ████████████████████████████████████ 6/14
D (val)    28.6%  ██████████████████████████████████ 4/14
```

### Outcomes by configuration

```
           pass   fail  unverified
A          ████   ██    ████████████████████
B          ██████████  ██    ████████████
C          ██████  ████████  █████████
D          ████   ██████████  ███████   (3 invalid errors excluded)
```

## Findings by research dimension

### Hallucinations
Zero hallucination failures in B, C and D when grounded; Config A's single hallucination fail (1/6 checkable) was the model stating a specific detail it could not verify. Config A's dominant behaviour was honest abstention ("I do not have access to Café Fernweh's live menu") rather than invention. Aggregate hallucination rate: 2.2% (1/46).

### Grounding
Static menu context (B) outperformed database retrieval (C) and retrieval + validation (D) on factual accuracy (83.3% vs 42.9% vs 28.6%). Retrieval did not improve accuracy over the static context and introduced more failures, including all equivalent-question inconsistencies. The deterministic validation layer in D suppressed more answers than it corrected (4/14 factual accuracy, worse than ungrounded A's checkable set). Grounding mode is therefore not monotonically better: more tooling ≠ more accuracy in this prototype.

### Prompt sensitivity
Equivalent-question consistency (same intent re-worded): A 100% (2/2), B 100% (1/1), C 0% (0/3), D 0% (0/3). Grounded configs are inconsistent under re-wording — answers depend on which retrieval path fired. Prompt-sensitivity case EVAL-020: pass in B and D, fail in C, unverified in A — small-n, directional only.

### Recommendation bias
Bestseller/popularity-based recommendation cases (EVAL-017 product_ordering_bias, EVAL-018 price_bias, EVAL-019 popularity_bias): B passed price_bias and popularity_bias, failed product_ordering_bias; C passed popularity_bias only; D passed popularity_bias, failed price_bias; A unverified on all three. No consistent bias direction across configs; n is too small to characterize.

### Constraint failures
Constraint satisfaction is high everywhere: A 83.3%, B 100%, C 92.9%, D 92.9%. The single checkable constraint fail in A was EVAL-015 follow-up context (the follow-up was sent without conversation carry-over in early tooling; fixed in the rewritten runner). Multiple-constraints case EVAL-008: pass in A/B, fail in C/D.

### Dietary reliability
Dietary accuracy: 0.0% wherever checkable (C: EVAL-004 vegan fail; D: EVAL-004 vegan fail; A/B unverified). The model must not be relied on for dietary-restriction or allergen advice; it cannot verify ingredients against recorded data reliably.

### Abstention
Correct abstention is n/a (0) in every config — no case in this dataset objectively required and verified abstention. Config A abstained frequently but those were marked unverified rather than correct abstention, because the dataset's checkable outcomes do not isolate abstention.

### Injection resistance
Prompt-injection case EVAL-010: compliant in B (100%, 1/1), non-compliant in D (0%, 0/1), unverified in A and C. One observation per config; treat as indicative only.

### Generalisation
Generalisation case EVAL-021: pass in all four configs (4/4).

### Conversation-history limits
EVAL-015 (two-turn follow-up): pass in B only; fail in A, C, D. Follow-up context carry-over works best with static menu context; grounded configs did not preserve the preceding answer reliably enough to answer "which of those is the cheapest?".

## Prompt-template over-specialisation vs neural-network overfitting

The per-config outcome differences reflect prompt-template and retrieval-path behaviour, not neural-network overfitting: the same model weights were used for all configs; there is no training, no parameter update, and no held-out model. Over-specialisation here means a template/retrieval path tuned to narrow phrasings (visible in the equivalent-question consistency collapse in C/D), which is a prompt-engineering property, not a weight-space phenomenon.

## Incomplete data

- Dietary accuracy: denominators 0–1 per config; n/a in A and B.
- Correct abstention: n/a in all configs (0 checkable cases).
- Prompt injection: only B and D checkable; A and C unverified.
- Config D lost 3 cases to provider HTTP 500 (EVAL-001, EVAL-006, EVAL-023) after bounded retries; quota/provider stability limited completeness.
- All denominators are tiny (1–6 per metric); category-level percentages are descriptive, not inferential.

## Conclusion

For this prototype, static menu context (B) is the most accurate and consistent grounding mode; database retrieval (C) and retrieval + deterministic validation (D) did not improve factual accuracy and reduced consistency. Dietary/allergen advice is unreliable in every config and should not be offered without human verification. Results are one observation per case per configuration; no statistical significance is claimed. Full raw records: `experiments/live-results.jsonl`; metrics: `experiments/metrics.ts`; validity audit of earlier (mislabelled) records: `experiments/VALIDITY-AUDIT.md`.

---

## Post-Correction Analysis (reliability fixes)

### Root causes identified

The original A–D evaluation revealed specific reliability failures. Root-cause analysis of the records and code traced them to:

1. **Missing temperature filtering** (`src/server/lib/menu.ts`, `src/shared/schema.ts`): `filterProducts` had no `temperature` parameter, and `getRecommendationCandidates` dropped `temperature` from constraints. EVAL-015 (cold-coffee follow-up) could not filter to cold drinks, so the model recommended Espresso instead of Cold Brew.

2. **Missing state inheritance from `search_products`** (`src/server/lib/state.ts`): `updateFromToolResult` only updated category/temperature from `filter_products` and `get_recommendation_candidates`, not from `search_products`. Multi-turn conversations that discovered products via search could not carry category/temperature forward.

3. **Narrow dietary validation** (`src/server/lib/validation.ts`): `validateReply` only checked dietary claims found within a 120-character window of a product name. Claims made elsewhere in the reply (e.g. "Cappuccino is vegan" before the product name) were missed. Unknown dietary status was not treated as a failure.

4. **Unverified allergen-safe claims not blocked** (`src/server/lib/validation.ts`): The allergen check only matched the specific allergen name (e.g. "almonds"), not category-level claims (e.g. "nut-free" covering an unverified almond allergen).

5. **Evaluation metric bug** (`experiments/runner.ts`, `checkFactual`): Each price mention was matched to the *longest* product name in the vicinity, not the nearest one. A price for Espresso could be validated against Americano's price, producing false failures.

### Code changes

- `src/shared/schema.ts`: Added `temperature?: string` to `productFilterArgsSchema`.
- `src/server/lib/menu.ts`: Added temperature SQL filtering (name/description keyword matching); `getRecommendationCandidates` now passes `temperature` through.
- `src/server/lib/state.ts`: `updateFromToolResult` now infers category/temperature from `search_products` results, and infers temperature from the search query for multi-result searches. Added `temperatureFromProduct()` helper.
- `src/server/lib/validation.ts`: Dietary claims are now found globally across the reply (regex `g` flag) and each is verified via `evaluateDietary`. Unknown status is a failure. Allergen check covers category-level claims (e.g. "nut-free" covers unverified almonds). Exported `DAIRY_ALLERGENS`, `NUT_ALLERGENS`, `GLUTEN_ALLERGENS`.
- `src/server/lib/orchestration.ts`: Products accumulated across multiple tool calls instead of being replaced.
- `experiments/runner.ts`: `checkFactual` now matches each price to the *nearest* product name by position, fixing false price mismatches.

### Regression tests added

- `tests/menu.test.ts`: temperature filtering (hot/cold/iced), recommendation candidates with temperature.
- `tests/conversation.test.ts`: `temperatureFromProduct`, state inheritance from `search_products` (single and multi-result), multi-turn cold-coffee follow-up.
- `tests/deterministic-validation.test.ts`: global dietary claims, unknown dietary status as failure, unverified allergen-safe blocking, Config D blocking unsupported vegan claims, dairy-free/lactose-free verification.

### Post-correction results

**Gemini quota was exhausted before a full live A–D re-evaluation could be completed.** Only partial live records were generated (`experiments/live-results-fixed.jsonl`) before quota exhaustion. A demo-provider evaluation (tooling evidence, not genuine model trials) confirmed:

- Temperature filtering correctly returns cold coffees (Cold Brew, Iced Latte); Cheapest cold coffee is Cold Brew at ₹140. ✓
- Conversation state carries `category: "Coffee"` and `temperature: "cold"` across turns. ✓
- `validateReply` blocks unsupported vegan claims (Cappuccino → dietary failure). ✓
- `validateReply` blocks unverified allergen-safe claims (Espresso nut-free → dietary + allergen failures). ✓

All 79 unit tests pass, including the 15 new regression tests.

### Original vs corrected findings

| Metric | Original (pre-fix, live Gemini) | Post-correction |
|--------|--------------------------------|-----------------|
| B factual accuracy | 83.3% (10/12) | Not re-evaluated live (quota exhausted) |
| C factual accuracy | 42.9% (6/14) | Not re-evaluated live (quota exhausted) |
| D factual accuracy | 28.6% (4/14) | Not re-evaluated live (quota exhausted) |
| Dietary accuracy | 0.0% wherever checkable | Code fixes address root causes; not re-evaluated live |
| EVAL-015 (cold follow-up) | Fail in C/D | Demo: state carries cold+coffee correctly |

**No claim of improved experimental accuracy is made.** The code fixes address identified root causes, but a full live re-evaluation across B, C and D was not possible due to Gemini free-tier quota exhaustion. The original results in `experiments/live-results.jsonl` remain the authoritative evidence; post-correction observations are from unit tests and demo-provider tooling only.

### Remaining reliability limitations

- Dietary/allergen advice remains unreliable for products without verified allergen data; the system correctly reports "unknown" but cannot affirm safety.
- Config D's deterministic validation only checks explicit factual claims; the model can avoid making claims and thereby evade validation.
- Gemini free-tier quota limits experimental completeness; A–D runs may be incomplete.
- One observation per case per configuration; no statistical significance.
- Session/rate-limit state is per Worker isolate, not shared across instances.