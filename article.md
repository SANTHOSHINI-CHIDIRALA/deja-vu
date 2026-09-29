# My on-call agent stopped repeating failed fixes with Hindsight

At 2:47am the worst thing an assistant can say is "try restarting the pods", especially when the post-mortem from last time says the pool re-exhausted within four minutes of doing exactly that.

This post is about Déjà Vu, the on-call agent I built for PayNest, a UPI payments platform. I built it so the agent remembers what this team actually did, including what didn't work.

![Déjà Vu incident console: the same alert diagnosed without memory (left) and with Hindsight memory (right)](https://raw.githubusercontent.com/SANTHOSHINI-CHIDIRALA/deja-vu/main/docs/console.png)

## What it does

An alert fires. The console runs two diagnoses side by side on the same alert, logs and recent deploy:

- **Without memory:** a plain LLM call (Groq, `gpt-oss-120b` with fallbacks).
- **With memory:** recall and reflect over a Hindsight memory bank holding every past PayNest incident. For each one it has the root cause, the fix that worked, the fixes that failed, and who resolved it.

The memory side returns ranked hypotheses with cited incident IDs, a recommended fix, a list of known-failed fixes to avoid, and an engineer to page. A Memory Inspector shows exactly which memories were used. Under each hypothesis are two buttons: "this fix worked" and "this suggestion failed".

The architecture is deliberately small:

- a Next.js app on Vercel;
- `lib/llm.ts`, a Groq client with timeouts, retries, model fallback and zod-validated JSON;
- `lib/hindsight.ts`, a thin wrapper over the official TypeScript SDK;
- `lib/agent.ts`, which has two pipelines and a feedback path.

The memory pipeline streams its real progress to the UI, so the ~13-second reflect reads as work, not a spinner.

(The incident corpus is a generated but realistic replay: 40 past incidents across six recurring failure families, plus 20 held-out ones with misleading symptoms.)

## The through-line: guessing the root cause isn't the value

My first evaluation scored root-cause *family*: is this DB pool exhaustion, a Redis stampede, an NPCI bank timeout? Memory won, but not by much. From an empty bank, memory ON was right 100% of the time and memory OFF 95%.

The reason is that family is guessable from symptoms. `QueuePool limit reached` plus a deploy that doubled gunicorn workers reads like pool exhaustion to any decent model.

What a strong model *can't* guess is company-specific:

1. **The fix this team actually uses.** At PayNest that's a runbook step like `RB-PG-07: pnctl db pool-cap payments-api --size 5 --overflow 5`, not "consider reducing pool size".
2. **What already failed here.** Restarting pods, scaling the HPA, raising `max_connections`: the generic moves every model suggests, and the ones this team's post-mortems say didn't work.

So I changed the headline metric to two per-incident checks, scored by an LLM judge against ground truth:

- **Right fix first try:** the top recommendation *specifically* matches the fix that worked, not a generic equivalent.
- **Repeated a known-failed fix:** the recommendation includes a fix that failed in an *earlier* incident of the same family.

Here's the core of the judge prompt:

```text
rightFix = true ONLY if the agent's TOP recommended fix is specifically the ground-truth fix:
the same concrete action — same internal tool/command or runbook, or the same specific config
change and values, or the same named failover route. A generic equivalent ("reduce pool size",
"fail over to a backup", "add a circuit breaker") is NOT enough …
```

## How Hindsight makes that work

**Retain.** Every resolved incident is retained as a document with its real timestamp and tags: `service:*`, `family:*`, `incident:*`. The bank's retain mission tells extraction what matters most:

```ts
const RETAIN_MISSION =
  "Extract incident facts: … the fix that worked, every fix that was tried and FAILED, who resolved it … Keep incident IDs, runbook IDs (RB-...), pnctl commands, config keys and route names verbatim — the exact fix command is the most valuable fact. …";
```

**Mission and directives.** The reflect mission is "the on-call SRE memory for PayNest's payments platform". The bank also has three hard directives: always cite incident IDs, never recommend destructive commands without flagging human approval, and "if a fix previously failed for a similar incident, say so explicitly." Disposition is set to high skepticism and high literalism, so the agent distrusts deploys that merely coincide in time.

**Recall and observations.** The alert, logs and recent change form the recall query. A second recall pulls Hindsight's consolidated observations for the service: which changes tend to precede which failures, which fixes keep working, which keep failing. Both appear in the inspector with type, date and score.

**Feedback as experience.** When on-call clicks "this suggestion failed", I retain a first-person *experience* memory synchronously, so the very next run sees it. Early on, the verdict was stored correctly but ranked below generic world facts, and reflect didn't weigh it. The fix was to recall feedback explicitly by tag and hand it to reflect as authoritative:

```ts
const feedback = await recallMemories(alertText, {
  bankId,
  types: ["experience"],
  tags: ["source:feedback"],
  tagsMatch: "any_strict",
  maxTokens: 800,
  budget: "low",
});
```

**Reflect.** Reflect produces the structured diagnosis, using a JSON schema and the bank's mission, directives and disposition. One field's description turned out to matter a lot:

```ts
recommendedFix: {
  type: "string",
  description: "… Quote PayNest's runbook ID and exact command(s) VERBATIM (e.g. 'RB-XX-00: `pnctl ...`'), not a paraphrase.",
},
```

## Before and after: INC-2369

The alert: checkout success rate drops to 71% at 02:47 IST. Thirty-eight minutes earlier, deploy `cabd556` bumped gunicorn from 8 to 16 workers. The logs show `WORKER TIMEOUT`.

**Without memory,** the model called it "Gunicorn worker timeout due to increased concurrency" and recommended rolling back the deploy. That's plausible, it's the wrong failure family, and it isn't what PayNest does.

**With memory** (249 memories in the bank at that point in the replay):

- It called DB pool exhaustion, citing INC-2237 (an earlier gunicorn worker bump) and INC-2265.
- It recommended **`RB-PG-07: pnctl db pool-cap payments-api --size 5 --overflow 5`**, the exact runbook that resolved every earlier pool-exhaustion incident.
- It listed "restarting pods" and "scaling the HPA" under *known-failed fixes*.

Then the feedback loop. I marked `RB-PG-07` as failed and re-ran. The progress panel reported "1 on-call verdict (1 failed fix)". The new answer moved `RB-PG-07` into fixes to avoid and switched the recommendation to **`RB-REL-02: pnctl config rollback payments-api-config`**, which undoes the worker bump itself. One click, and the next engineer won't be told to repeat it.

## Results: learning from an empty memory

To measure learning rather than recall, `npm run eval:cold` starts from an **empty** bank and replays 40 incidents chronologically. Each incident is diagnosed and judged *before* its resolution is retained. Memory only ever knows the past.

![Learning curve: cumulative right-fix-first-try rate and known-failed fixes repeated](https://raw.githubusercontent.com/SANTHOSHINI-CHIDIRALA/deja-vu/main/docs/learning.png)

From `data/eval-cold-results.json`:

| | Memory OFF | Memory ON |
|---|---|---|
| Right fix first try (all 40) | **0%** | **70%** |
| Right fix on recurrences of a family (34) | 0% | **82%** |
| Right fix on the first incident of a family (6) | 0% | 0% |
| Known-failed fixes repeated | **9** | **2** |
| Root-cause family accuracy | 88% | 90% |

- **Memory OFF never produced PayNest's fix.** It couldn't, because those runbooks only exist in the team's history.
- **Memory ON's rate climbed** from 40% in the first ten incidents to 80% and held there. If you've wondered [what agent memory is](https://vectorize.io/what-is-agent-memory) actually for, this is it.
- **Memory OFF kept recommending moves that had already failed:** restarting `redis-cache-0`, raising `max_connections`, scaling notif-worker to 30 replicas. Memory ON did that twice.

## Lessons

1. **Pick a metric that only memory can win.** Root-cause accuracy was roughly even (90% vs 88%), and ON was a bit lower than in an earlier run: it misclassified two incidents while the bank was nearly empty and two later ones, including a red herring where "all banks are down" was really our own expired mTLS certificate. Measuring the fix, not the category, is what exposed the real gap.
2. **Check what your memory stores versus what it says.** Hindsight kept `pnctl cache harden sess:*` verbatim in its facts, but reflect's structured-output pass paraphrased it into "implement TTL jitter". Until I told it, in the retain mission, the reflect query and the schema description, to quote runbook commands verbatim, my smoke runs didn't get a single runbook fix right.
3. **Treat feedback as first-class memory, not a log line.** Retain it synchronously, tag it, recall it explicitly, and tell reflect it's authoritative.
4. **Budget for your LLM provider's quotas.** My evals exhausted Groq's free-tier daily token quota for `gpt-oss-120b`, and each call burned ~100 seconds in retries before falling back. Now a 429 whose `retry-after` is over a minute falls through to the next model immediately. That is also why the memory-OFF answers in this run came partly from fallback models.

The code, data generator and evals are all in the repo. If you're building agents that should get better with every incident, start with [Hindsight on GitHub](https://github.com/vectorize-io/hindsight) and the [Hindsight documentation](https://hindsight.vectorize.io/).
