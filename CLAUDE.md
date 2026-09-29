# Déjà Vu — the on-call agent that remembers every outage

## One-liner
When production breaks, Déjà Vu recalls how every similar incident was diagnosed and fixed before, suggests the most likely root cause with cited past incidents, and learns from each resolution — including fixes that FAILED — so it gets measurably better over time.

## Stack
- Next.js (App Router) + TypeScript + Tailwind. Deployed on Vercel.
- Hindsight Cloud via the official Hindsight TypeScript SDK (fall back to the HTTP API if the SDK gives trouble).
  READ THESE BEFORE WRITING HINDSIGHT CODE — do not guess method names:
  - https://hindsight.vectorize.io/sdks/nodejs
  - https://hindsight.vectorize.io/developer/api/quickstart
  - https://hindsight.vectorize.io/developer/api/retain
  - https://hindsight.vectorize.io/developer/api/recall
  - https://hindsight.vectorize.io/developer/api/reflect
  - https://hindsight.vectorize.io/developer/api/memory-banks
  - https://hindsight.vectorize.io/developer/api/mental-models
  - https://hindsight.vectorize.io/developer/api/operations
- LLM: Groq, OpenAI-compatible endpoint https://api.groq.com/openai/v1
  - primary model `openai/gpt-oss-120b`, fallback `qwen/qwen3-32b`
  - wrap every call: timeout, 2 retries, fallback model, and zod validation of JSON output with one "repair" retry. Tool/function-calling errors must never crash the UI.

## Env vars (never commit; keep .env.example up to date)
```
GROQ_API_KEY=
HINDSIGHT_API_KEY=
HINDSIGHT_API_URL=
HINDSIGHT_BANK_ID=paynest-sre
```

## Fictional company + data (realism matters a lot to judges)
**PayNest** — an Indian UPI payments startup, ~2M daily transactions.
Services: `payments-api`, `upi-gateway`, `ledger-svc`, `auth-svc`, `notif-worker`, plus `postgres-primary`, `redis-cache`, `kafka`.
On-call engineers: Priya Raman, Arjun Mehta, Sneha Kulkarni, Rahul Verma, Fatima Sheikh, Karthik Iyer.

Generate with a script (deterministic, committed as JSON under /data):
1. `data/history.json` — 40 past incidents, Mar–Sep 2026, drawn from 6 recurring failure families with realistic variation:
   - DB connection pool exhaustion after a deploy raised worker count
   - Redis eviction storm / cache stampede during peak (salary day, festival sale)
   - NPCI/bank partner timeout at upi-gateway (external dependency, fix = circuit breaker + failover route)
   - Kafka consumer lag in notif-worker after partition rebalance
   - Expired TLS cert / rotated secret on auth-svc
   - Bad feature flag / config push causing 5xx on payments-api
   Each incident: `id` (INC-2xxx), `startedAt`, `service`, `severity`, alert payload (Prometheus/Grafana style), 5–10 realistic log lines, preceding deploy/config change (with commit sha + author), on-call chat timeline, `rootCause`, `family`, `fixThatWorked`, `fixesThatFailed` (0–2), `resolvedBy`, `ttrMinutes`, short post-mortem.
2. `data/eval.json` — 20 NEW held-out incidents (Oct 2026 timestamps), same families, different surface symptoms, with ground-truth `family` and `rootCause`, ordered chronologically.

## Hindsight design
- One memory bank: `paynest-sre`. Configure at setup:
  - Mission: "I am the on-call SRE memory for PayNest's payments platform. I prioritise past incidents, root causes, what fixed them, what did not, and who fixed them."
  - Directives: "Always cite past incident IDs for any claim." "Never recommend destructive commands (DROP, rm -rf, force failover of primary) without flagging them as requiring human approval." "If a fix previously failed for a similar incident, say so explicitly."
  - Disposition: high skepticism, high literalism, moderate empathy.
- **Retain**: every history incident (as a document with timestamp + tags service/family), every agent suggestion, every user feedback event ("fix X worked" / "fix Y failed") as experience.
  Retain may process asynchronously — use the Operations API to wait for completion in scripts/eval.
- **Recall**: on a new alert, recall with the alert + logs + recent deploy info; use a token budget; surface results in the Memory Inspector with memory type and score.
- **Reflect**: produce the diagnosis: ranked hypotheses (max 3) with confidence, cited INC ids, recommended next checks/commands, known-failed fixes to avoid, and suggested expert ("Priya fixed 3 of these").
- **Observations**: show consolidated observations about the affected service in the inspector.
- **Mental models** (P1): "Living Runbook" per service, refreshed after each resolution.

## Features
### P0 — must ship
1. **Incident Console** (`/`): choose an eval incident from a dropdown (or paste an alert). Two columns:
   - LEFT "Without memory": plain Groq call, no Hindsight.
   - RIGHT "With Déjà Vu memory": recall + reflect.
   A big toggle/tab on mobile. The difference must be dramatic.
2. **Memory Inspector** panel: for the right-hand answer, list the memories used (type world/experience/observation, text, date, score) and cited incidents (clickable → incident detail drawer).
3. **Feedback loop**: buttons "Resolved — this fix worked" / "This suggestion failed" (+ optional note). Retains an experience memory. Re-running a similar alert must visibly change the answer (e.g., demotes the failed fix).
4. **Learning Curve** (`/learning`): chart of cumulative root-cause accuracy over the 20 eval incidents, memory OFF vs memory ON. Data from `data/eval-results.json` produced by `scripts/eval.ts`. Also show average "time-to-hypothesis" style stats.
5. **Seed + eval scripts**: `npm run seed` (create/configure bank, retain history, wait for ops), `npm run eval` (replay eval chronologically; memory ON retains each resolution after scoring; score by LLM-judge family match with the ground truth; write results JSON). Idempotent; a `--reset` flag recreates the bank.
### P1 — only after P0 is deployed
6. Living Runbook page per service (mental models).
7. "Ask memory" box: temporal questions like "what broke after deploys in August?"

## UI
Dark ops-console aesthetic (think Grafana/PagerDuty, not a chat app). Monospace for logs/alerts. Severity colours. Must work well on a phone screen AND a projector. Loading skeletons, clear empty/error states. Header tagline: "The on-call agent that remembers every outage."

## Repo quality (graded)
- README: problem, 60-second demo GIF/screenshot placeholders, architecture (mermaid diagram), **"How Hindsight memory is used"** section mapping retain/recall/reflect/observations/mental models/mission/directives to features, learning-curve result, setup steps, env vars, scripts.
- `.env.example`, typed code, small modules (`lib/hindsight.ts`, `lib/llm.ts`, `lib/agent.ts`, `lib/eval.ts`), no secrets, MIT license.
- Commit and push small, frequent commits with clear messages.

## Demo story (3 min) — build toward this
1. "It's 2:47am. payments-api is throwing 5xx. You're on call." Pick the alert.
2. Without memory: generic advice. With Déjà Vu: "This matches INC-2291 and INC-2318 — DB pool exhaustion after deploy a41f9c raised workers. Priya fixed it by capping pool size. Note: restarting pods FAILED last time."
3. Open the Memory Inspector: the exact memories and observations used.
4. Click "This suggestion failed" → re-run → the agent adapts.
5. Learning Curve: memory OFF stays flat; memory ON climbs across 20 incidents.
6. "Every team has this knowledge. Déjà Vu makes sure it's never lost."
