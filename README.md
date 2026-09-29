# Déjà Vu — the on-call agent that remembers every outage

**Live demo:** https://deja-vu-lake.vercel.app · **Demo video:** https://youtu.be/ggVOoQiVPHc

> When production breaks, Déjà Vu recalls how every similar incident was diagnosed and fixed before, ranks the most likely root cause with **cited past incidents**, warns you about **fixes that already failed**, tells you **who fixed it last time** — and learns from every resolution, so it gets measurably better over time.

Built on [Hindsight](https://hindsight.vectorize.io) agent memory + Groq.

| Incident console (memory OFF vs ON) | Learning curve |
|---|---|
| ![Incident console: the same alert without and with memory](docs/console.png) | ![Learning curve: right fix first try and known-failed fixes repeated](docs/learning.png) |

_Demo video: [watch the walkthrough on YouTube](https://youtu.be/ggVOoQiVPHc)._

---

## The problem

Every engineering org with an on-call rotation re-learns the same outages. The knowledge of *"last time payments-api threw 5xx after a worker bump, restarting pods didn't help — Priya capped the pool size"* lives in a post-mortem nobody reads at 2:47am, or in the head of someone who is asleep. Generic LLM assistants don't help: they don't know **your** systems, **your** past incidents, or **which fixes already failed**.

Déjà Vu is an incident console, not a chatbot. The same alert is diagnosed twice, side by side:

- **Without memory** — a strong LLM with no history (Groq `openai/gpt-oss-120b`). Plausible, generic.
- **With Déjà Vu memory** — Hindsight recall + reflect over PayNest's incident history. Specific, cited, and aware of what failed before.

## 60-second demo

> The full 3-minute stage script, with exact clicks and what should appear at each step, is in **[DEMO.md](DEMO.md)**.

1. *"It's 2:47am. Checkout success rate is dropping. You're on call."* — pick **INC-2369** and hit **Diagnose**.
2. **Without memory** (e.g.): "Gunicorn overload, raise pod CPU limits." **With Déjà Vu:** "DB pool exhaustion — deploy `cabd556` doubled workers; same as INC-2237 / INC-2304. Restarting pods FAILED in INC-2292 and INC-2357. Page Priya Raman — she resolved 4 of these."
3. Open the **Memory Inspector**: the exact world facts, experiences and consolidated observations used, with recall scores. Click any `INC-xxxx` to open the past incident.
4. Click **"✕ This suggestion failed"** on the top fix → **Re-run**. The failed fix moves to *Known-failed fixes*, and a different proven fix is recommended. A purple "What changed" banner shows the diff.
5. Open **Learning curve**: 40 incidents replayed chronologically from an **empty** memory bank. **Right fix first try: memory OFF 0% vs memory ON 70%.**

## Architecture

```mermaid
flowchart LR
  subgraph UI["Next.js app (Vercel)"]
    C["Incident Console /"]
    L["Learning Curve /learning"]
    MI["Memory Inspector + incident drawer"]
  end
  subgraph API["API routes (Node)"]
    D["/api/diagnose"]
    F["/api/feedback"]
    I["/api/incidents/:id"]
  end
  subgraph Agent["lib/agent.ts"]
    OFF["diagnoseWithoutMemory"]
    ON["diagnoseWithMemory"]
    FB["recordFeedback"]
  end
  G[("Groq<br/>gpt-oss-120b → qwen3.8-27b → gpt-oss-20b")]
  H[("Hindsight Cloud<br/>bank: paynest-sre")]
  DATA[("data/*.json<br/>40 history + 20 eval incidents")]

  C --> D --> OFF --> G
  D --> ON
  ON -- "recall (alert + logs + change)" --> H
  ON -- "recall observations" --> H
  ON -- "recall feedback experiences (tag source:feedback)" --> H
  ON -- "reflect (mission, directives, disposition, JSON schema)" --> H
  ON -. "fallback: structure / recall+LLM" .-> G
  C --> F --> FB -- "retain experience (sync)" --> H
  MI --> I --> DATA
  S["npm run seed"] -- "create bank + retain history + wait (Operations API)" --> H
  E["npm run eval"] -- "replay eval, judge, retain resolutions" --> H
  E --> R[("data/eval-results.json")] --> L
  EC["npm run eval:cold"] -- "empty bank; diagnose, judge, then retain each incident" --> H
  EC --> RC[("data/eval-cold-results.json")] --> L
```

Code layout (small, typed modules):

| File | Responsibility |
|---|---|
| `lib/llm.ts` | Groq client: per-call timeout, 2 retries with backoff (honours `retry-after`), model fallback chain, request spacing for free-tier limits, **zod-validated JSON with one repair turn** |
| `lib/hindsight.ts` | Official `@vectorize-io/hindsight-client` wrapper: bank config (mission/directives/disposition), retain, recall, reflect, Operations API polling |
| `lib/agent.ts` | Memory OFF / ON diagnosis pipelines and the feedback → experience loop |
| `lib/eval.ts` | LLM-judge scoring and result summaries |
| `lib/seed.ts` | Seeds a bank with history and waits for processing |
| `lib/incidents.ts` | Data loading, alert/document rendering |
| `lib/types.ts` | Shared types + the `Diagnosis` zod schema and its JSON-Schema twin |
| `scripts/generate-data.ts` | Deterministic incident generator (seeded PRNG) |

## How Hindsight memory is used

| Hindsight feature | Where | What it does in Déjà Vu |
|---|---|---|
| **Memory bank** | `paynest-sre` (`lib/hindsight.ts → configureBank`) | One bank holds PayNest's entire on-call memory. Eval runs in an isolated `paynest-sre-eval` bank. |
| **Mission** | bank `reflectMission` | *"I am the on-call SRE memory for PayNest's payments platform. I prioritise past incidents, root causes, what fixed them, what did not, and who fixed them."* A `retainMission` tells extraction to keep incident IDs, failed fixes and resolvers; an `observationsMission` steers consolidation toward per-service failure patterns. |
| **Directives** | `createDirective` ×3 | "Always cite past incident IDs for any claim." · "Never recommend destructive commands (DROP, rm -rf, force failover of primary) without flagging them as requiring human approval." · "If a fix previously failed for a similar incident, say so explicitly." — visible in the UI as citations, **needs human approval** badges and the *Known-failed fixes* list. |
| **Disposition** | `updateBankConfig` | Skepticism 5, literalism 5, empathy 3 — the agent distrusts coincidental changes and sticks to what the record says. |
| **Retain (world)** | `npm run seed` | Each of the 40 historical incidents is retained as a document (`document_id = INC-xxxx`) with its real timestamp, a context string, and tags `service:*`, `family:*`, `incident:*`, `source:history`. Retained async; the script waits via the **Operations API** + bank stats until extraction and consolidation finish. |
| **Retain (experience)** | `/api/feedback` → `recordFeedback` | "✓ this fix worked" / "✕ this suggestion failed" (+ note) is retained **synchronously** as a first-person agent experience, tagged `source:feedback`, `outcome:*`, `service:*`, `incident:*`. |
| **Retain (learning in eval)** | `npm run eval` | After each eval incident is scored, its resolution is retained into the memory-ON bank — so later incidents can use it. |
| **Recall** | `diagnoseWithMemory` | The alert + logs + recent deploy are used as the recall query (`budget: mid`, `maxTokens: 3000`, types world/experience/observation). A second tag-filtered recall (`tags: [source:feedback]`, `any_strict`) fetches on-call verdicts. Results populate the **Memory Inspector** with type, date and score. |
| **Reflect** | `diagnoseWithMemory` | Produces the diagnosis with the bank's mission, directives and disposition, using `response_schema` for structured output (ranked hypotheses with confidence and cited INC ids, next checks, known-failed fixes, suggested expert) and `include.facts` so the inspector shows the facts reflect actually used. Feedback verdicts are passed in explicitly so failed fixes are demoted. |
| **Observations** | recall `types: [observation]` | Consolidated, per-service patterns ("payments-api pool exhaustion follows worker/replica bumps; restarts don't help") shown in the inspector's *Observations* tab and used by reflect. |
| **Mental models** | _P1 — not built_ | Planned "Living Runbook" per service refreshed after each resolution. |

## Resilience

- **LLM:** every Groq call has a timeout, 2 retries with exponential backoff / `retry-after`, a fallback model chain, and zod validation with one repair turn. JSON mode is dropped automatically if a model rejects it.
- **Hindsight:** if reflect's structured output is missing/invalid, its markdown answer is structured by Groq; if reflect fails entirely, the agent diagnoses from recalled memories via Groq. Warnings are surfaced in the UI rather than crashing it.
- **UI:** the memory-ON column streams real pipeline progress (NDJSON from `/api/diagnose`: similar-incident recall → failed-fix verdicts → reflect) so the ~13 s wait is visible work, not a spinner. Also: empty states, per-column error states, inline feedback errors. Every API route sets `maxDuration = 60` for Vercel.

> Note: the spec's fallback model `qwen/qwen3-32b` is no longer served on Groq (`404 model_not_found`), so the chain is `openai/gpt-oss-120b → qwen/qwen3.8-27b → openai/gpt-oss-20b`.
> Hindsight reflect's `response_schema` rejects JSON-Schema union types (`["string","null"]` → HTTP 500), so the schema uses empty strings for "none".

## Learning curve result

### Headline: does memory give you PayNest's *actual* fix? (`npm run eval:cold`)

Root-cause *family* turned out to be too coarse. Both agents can usually guess "DB pool exhaustion" from the symptoms. The on-call value of memory is **company-specific knowledge**, so the headline metrics are scored per incident by an LLM judge against ground truth:

- **Right fix first try:** the agent's top recommended action is *specifically* the fix that worked for that incident. That means PayNest's runbook action (e.g. `RB-PG-07: pnctl db pool-cap …`, `RB-UPI-03: pnctl upi failover … --route npci-dc2`), not a generic equivalent like "reduce the pool size".
- **Repeated a known-failed fix:** the recommendation (top fix or next checks) tells you to do something that already FAILED in an earlier incident of the same family (restart pods, scale up, FLUSHALL, raise `max_connections` …).

**Setup:** `data/eval-cold-results.json` holds **40 incidents**: every 2nd history incident (20, Mar–Sep) plus all 20 held-out (Oct). They were replayed chronologically against **`paynest-sre-cold`, which starts empty**. Each alert is diagnosed with memory OFF and ON and judged, **then** its resolution is retained. The run took 20.5 min. History was subsampled because the Groq free-tier daily token quota had been used up by earlier runs.

| Incidents | Memories at start | Right fix first try, OFF | Right fix first try, ON | Known-failed fixes repeated (OFF / ON) | Family accuracy (OFF / ON) |
|---|---|---|---|---|---|
| 1–10 | 0 | 0% | 40% | 0 / 1 | 90% / 80% |
| 11–20 | 117 | 0% | 80% | 3 / 0 | 90% / 100% |
| 21–30 | 236 | 0% | 80% | 4 / 0 | 80% / 100% |
| 31–40 | 352 | 0% | 80% | 2 / 1 | 90% / 80% |
| **All 40** | 0 → 450 | **0%** | **70%** | **9 / 2** | 88% / 90% |

**What this shows:**
- **Memory OFF never gets PayNest's fix (0/40).** It can't: the runbooks and internal tools exist only in the team's history.
- **Memory ON learns the fixes.** It scores 0% on the *first* incident of each family (nothing to recall yet), then **82% on recurrences** (28/34) vs 0% for OFF. The block curve climbs from 40% to 80% and holds.
- **It stops repeating what already failed: 9 vs 2.** Memory OFF told on-call to restart pods, restart `redis-cache-0`, raise `max_connections` or scale `notif-worker` to 30 after those had failed before. Memory ON did it twice (INC-2244 restart pods, INC-2427 offset reset).
- **Held-out October only:** right fix OFF 0% vs ON 80%; repeated failed fixes OFF 6 vs ON 1.

**Honest caveats:**
- **Root-cause family accuracy is roughly even here** (ON 90% vs OFF 88%), and lower for ON than in the previous run (100%). ON misclassified INC-2212 and INC-2244 while memory was nearly empty. It also got INC-2420 and INC-2435 wrong, including the "all banks down" red herring, which is actually our own expired mTLS cert. This run's reflect prompt pushes harder for proven runbook actions, and that may bias it toward frequent families. We report it rather than tune it away.
- **The data was tightened for this metric.** Each family now has one consistent PayNest fix (per mechanism for TLS/secrets and flag/config), which makes the metric learnable. IDs, symptoms, root causes, failed fixes and red herrings are unchanged. See the "Data" section.
- **Memory OFF's serving model varied.** `gpt-oss-120b` hit Groq's daily token quota mid-afternoon, so memory OFF answered via the fallback models (`gpt-oss-20b` / `qwen3.8-27b`); each result records its model. Both judges ran on `gpt-oss-20b` for both sides.
- **"Earlier failed fixes"** include every earlier incident of the family in the full dataset, including history incidents skipped by the subsample, which memory ON never saw. That is conservative for memory ON.

### Root-cause family accuracy, cold start (previous 60-incident run)

Before the fix-level metrics existed, a 60-incident cold run scored family accuracy only: memory ON 100% (60/60) vs OFF 95% (57/60). ON was flat from an empty bank; the only gap was the October red herrings. That is why family accuracy is now a secondary chart.

### Warm start: 40 past incidents already in memory (`npm run eval`)

From `data/eval-results.json`: the 20 held-out Oct 2026 incidents, replayed chronologically and LLM-judged on failure-family match.

| | Memory OFF (plain Groq) | Memory ON (Déjà Vu) |
|---|---|---|
| Top-1 root-cause accuracy | **80%** (16/20) | **100%** (20/20) |
| Right family anywhere in top 3 | 100% | 100% |
| Past incidents cited per answer | 0 | 7.6 |
| Accuracy, first 10 → last 10 incidents | 70% → 90% | 100% → 100% |
| Avg time to hypothesis | 2.2 s | 13.6 s |

Historical human mean time-to-resolve in `data/history.json` is ~76 min, so a cited hypothesis in ~14 s is the relevant comparison — the extra latency of memory buys a correct, sourced answer.

**What the numbers say, honestly:** memory ON did not need to "climb" on this set — the 40-incident history already covers all six families, so it was right from the first incident, and the gap vs memory OFF comes from the four incidents with misleading symptoms, which the memory-less agent got wrong:

| Incident | Ground truth | Memory OFF said | Memory ON said |
|---|---|---|---|
| INC-2369 | DB pool exhaustion | "Gunicorn overload" (raise CPU limits) | DB pool exhaustion after worker bump, citing past worker-bump incidents |
| INC-2371 | NPCI bank timeout (Axis) | DB pool exhaustion in upi-gateway | NPCI bank timeout — ignored the coincidental flag push |
| INC-2387 | Redis eviction storm (festive sale) | DB pool exhaustion | Redis eviction storm & cache stampede |
| INC-2411 | NPCI bank timeout (SBI) | Logging-library upgrade → GC pressure | SBI remitter-bank degradation |

The within-run learning mechanism (retaining each resolution after scoring) and the feedback loop are exercised by the eval and the console respectively; a harder eval with families absent from history would be needed to show a rising memory-ON curve.

## Data

Fictional **PayNest** — an Indian UPI payments startup (~2M txns/day). Services `payments-api`, `upi-gateway`, `ledger-svc`, `auth-svc`, `notif-worker`, `postgres-primary`, `redis-cache`, `kafka`. On-call: Priya Raman, Arjun Mehta, Sneha Kulkarni, Rahul Verma, Fatima Sheikh, Karthik Iyer.

- `data/history.json` — 40 incidents, Mar–Sep 2026, from 6 recurring families (DB pool exhaustion, Redis eviction storm, NPCI/bank timeout, Kafka consumer lag, expired TLS / rotated secret, bad flag/config push). Each has a Prometheus-style alert, realistic log lines, the preceding change (sha + author), an on-call chat timeline, root cause, fix that worked, 0–2 fixes that failed, resolver, TTR and a post-mortem. Generated deterministically by `npm run gen-data`.
- **Fixes that worked are PayNest-specific and consistent:** each family recurs with the same internal runbook action via the `pnctl` tool, e.g. `RB-PG-07` pool-cap, `RB-CACHE-04` cache harden, `RB-UPI-03` NPCI-DC2 failover, `RB-KAFKA-02` stabilize, `RB-SEC-01..04`, `RB-REL-01/02` (`scripts/data/fixes.ts`). Fixes that failed are the generic moves on-call reaches for: restart pods, scale up, FLUSHALL, raise timeouts, roll back the image.
- `data/eval.json` — 20 held-out incidents (Oct 2026) with different surface symptoms, several with **red herrings** (a flag push right before an NPCI outage, DB-pool errors that are really a Redis stampede, an "all banks down" that is actually our expired mTLS client cert).

## Setup

```bash
npm install
cp .env.example .env.local   # fill in keys
npm run check                # verify Groq + Hindsight connectivity
npm run seed                 # create/configure paynest-sre and retain history (~3-5 min)
npm run dev                  # http://localhost:3000
```

Deploy on Vercel: import the repo and set the env vars below. `data/eval-results.json` is committed, so `/learning` works without running the eval.

### Environment variables

| Var | Description |
|---|---|
| `GROQ_API_KEY` | Groq API key |
| `HINDSIGHT_API_KEY` | Hindsight Cloud API key |
| `HINDSIGHT_API_URL` | e.g. `https://api.hindsight.vectorize.io` |
| `HINDSIGHT_BANK_ID` | defaults to `paynest-sre` |

### Scripts

| Script | What it does |
|---|---|
| `npm run check` | Connectivity check for Groq and Hindsight |
| `npm run gen-data` | Regenerate `data/history.json` + `data/eval.json` (deterministic) |
| `npm run seed` | Create/configure the bank, retain history, wait for ops. Idempotent. `-- --reset` recreates the bank; `-- --clear-feedback` removes demo feedback memories |
| `npm run eval:cold` | Cold-start learning curve: replay incidents chronologically against an empty `paynest-sre-cold` bank, scoring each (family, right fix first try, repeated known-failed fix) before retaining its resolution. Stores every diagnosis in `data/eval-cold-results.json` so metrics can be rescored. `-- --history-stride 2` subsamples history (40 incidents, ~20 min); `-- --limit N` for a smoke run |
| `npm run eval` | Seed an isolated `paynest-sre-eval` bank, replay the 20 eval incidents (memory OFF vs ON), LLM-judge them, retain each resolution, write `data/eval-results.json`. `-- --limit N` for a quick run |
| `npm run build` / `start` | Production build / server |

## License

MIT
