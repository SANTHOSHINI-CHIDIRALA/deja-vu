# I measured whether Hindsight memory made my agent better

Every "memory makes the agent smarter" demo I've seen compares one hand-picked question with and without memory. I wanted a number I'd trust: start from an empty memory, replay months of incidents in order, and measure whether the agent actually gets better at the part of on-call that matters.

The agent is Déjà Vu, an on-call assistant for PayNest's UPI payments platform. When an alert fires, it diagnoses the incident twice:

- once as a plain LLM call;
- once through recall and reflect over a Hindsight memory bank ([Hindsight on GitHub](https://github.com/vectorize-io/hindsight)) holding the team's past incidents: root causes, fixes that worked, fixes that failed, and who resolved them.

![Déjà Vu console: the same alert diagnosed without memory and with memory](https://raw.githubusercontent.com/SANTHOSHINI-CHIDIRALA/deja-vu/main/docs/console.png)

(The incident corpus is a generated but realistic replay: six recurring failure families across `payments-api`, `upi-gateway`, `ledger-svc`, `auth-svc` and `notif-worker`.)

## The design: an empty bank, a strict clock

`npm run eval:cold` creates a fresh bank, `paynest-sre-cold`. It is configured exactly like production: same mission, same three directives, same disposition. Then it replays incidents chronologically: 20 historical incidents (every second one from March to September) followed by 20 held-out October incidents.

The core rule is ordering. Each incident is diagnosed and scored **before** its own resolution is stored. Memory can only ever know the past:

```ts
const fixContext = { earlierFailed: earlierFailedFixes(incident, ALL_INCIDENTS) };
const [off, on] = await Promise.all([
  scoreSide(incident, () => diagnoseWithoutMemory(input), fixContext),
  scoreSide(incident, () => diagnoseWithMemory(input, { bankId: COLD_BANK }), fixContext),
]);
```

Only after both sides are judged does the "team" resolve the incident:

```ts
// The team resolves the incident: retain its post-mortem synchronously so the
// next incident can recall it. (Observation consolidation continues in the background.)
await retainResolution(incident, COLD_BANK, phase, { async: false });
```

The retain is synchronous on purpose. With async retain, the next incident can race ahead of extraction and you end up measuring your queue, not your memory. Hindsight's consolidation into observations still runs in the background. That is realistic: a team's lessons take a while to become patterns.

The bank went from 0 to 450 memories over the 40 incidents. The whole run took 20.5 minutes, with memory-ON answers averaging about 12 seconds.

## Three metrics, one judge

I score each answer with an LLM judge against ground truth. The same judge model scores both sides of every incident.

1. **Root-cause family accuracy.** Does the top hypothesis name the right failure family (DB pool exhaustion, Redis eviction storm, NPCI bank timeout …)?
2. **Right fix first try.** Is the top recommended action *specifically* the fix that resolved this incident? At PayNest that's a runbook like `RB-PG-07: pnctl db pool-cap payments-api --size 5 --overflow 5`. The judge is told plainly what doesn't count:

```text
A generic equivalent ("reduce pool size", "fail over to a backup", "add a circuit breaker",
"revert the config") is NOT enough unless it names the same specific mechanism.
```

3. **Repeated a known-failed fix.** Does the recommendation tell on-call to do something that already failed in an *earlier* incident of the same family? "Earlier" is computed from the timeline, not from the model:

```ts
export function earlierFailedFixes(incident: Incident, all: Incident[]): { id: string; fix: string }[] {
  return all
    .filter((i) => i.family === incident.family && i.startedAt < incident.startedAt)
    .flatMap((i) => i.fixesThatFailed.map((fix) => ({ id: i.id, fix })));
}
```

One design choice here is conservative for memory: `all` includes the historical incidents the subsample skipped. The judge will flag "restart the pods" as a repeat even when memory ON never saw the incident where it failed.

## Results

![Learning curve: cumulative right-fix-first-try rate and known-failed fixes repeated](https://raw.githubusercontent.com/SANTHOSHINI-CHIDIRALA/deja-vu/main/docs/learning.png)

From `data/eval-cold-results.json`, in blocks of ten incidents:

| Incidents | Memories at start | Right fix, OFF | Right fix, ON | Repeated failed fixes, OFF / ON | Family accuracy, OFF / ON |
|---|---|---|---|---|---|
| 1–10 | 0 | 0% | 40% | 0 / 1 | 90% / 80% |
| 11–20 | 117 | 0% | 80% | 3 / 0 | 90% / 100% |
| 21–30 | 236 | 0% | 80% | 4 / 0 | 80% / 100% |
| 31–40 | 352 | 0% | 80% | 2 / 1 | 90% / 80% |
| **All 40** | 0 → 450 | **0%** | **70%** | **9 / 2** | 88% / 90% |

The breakdown that convinced me it's real learning, not luck:

- **First incident of each family: 0 of 6 for memory ON.** Nothing to recall, and it doesn't pretend otherwise.
- **Recurrences: 28 of 34 (82%) for memory ON, 0 for memory OFF.** By family: Kafka 5/5, DB pool 6/6, NPCI 6/7, config 5/6, Redis 4/5, TLS/secrets 2/5. TLS is the weakest because it has four distinct mechanisms, so its "recurrences" are often a different sub-problem.
- **It learns from a single example.** INC-2212, the first Kafka consumer-lag incident, got generic advice ("increase the number of partitions/consumer instances"). INC-2219 was the second, diagnosed with just 16 memories in the bank. Memory ON answered `RB-KAFKA-02: pnctl kafka stabilize notif-worker`, the exact fix the team had used once before.
- **The held-out October incidents,** which include deliberately misleading symptoms: right fix 16/20 vs 0/20; repeated failed fixes 1 vs 6.

Memory OFF's nine repeats were the moves every model reaches for: restarting `redis-cache-0`, restarting pods, raising `max_connections`, scaling notif-worker to 30 replicas. Each one had already failed at PayNest. That's the gap [what agent memory is](https://vectorize.io/what-is-agent-memory) supposed to close, and here it's measurable.

## What the numbers don't say

I want to be precise about the limits:

- **Root-cause accuracy is roughly a tie** (90% vs 88%). Guessing the category from logs is easy for a strong model. That's exactly why I stopped using it as the headline.
- **Memory OFF wasn't always the same model.** Earlier runs that day exhausted Groq's free-tier daily token quota for `gpt-oss-120b`. The memory-OFF answers came from `qwen3.8-27b` (25), `gpt-oss-20b` (13) and `gpt-oss-120b` (2). None of them could know PayNest's runbooks, but it's a confound for the family-accuracy column.
- **It's one run of 40 incidents,** not a distribution. I haven't measured run-to-run variance, so I wouldn't quote the 82% to two significant figures.
- **The judges are LLMs too** (`gpt-oss-20b` for both metrics). The rubric is strict and identical for both sides, but it's still a model reading text.

## What I'd tell anyone evaluating agent memory

1. **Replay chronologically from empty.** A warm bank shows recall, not learning. My earlier warm-start eval (100% vs 80% family accuracy) looked great and told me almost nothing about learning.
2. **Split first occurrences from recurrences.** Memory can't help on something it has never seen; the "0 of 6" row keeps the headline honest.
3. **Store every raw answer.** My previous results file kept only scores, so the fix-level metrics required a full re-run. Now each row keeps the full diagnosis, so new metrics can be rescored offline.
4. **Pick metrics that only memory can win.** Company-specific fixes and known-failed fixes are knowledge; root-cause families are mostly pattern-matching.

The eval, the judge prompts and the raw results are all in the repo. The [Hindsight documentation](https://hindsight.vectorize.io/) covers the retain/recall/reflect APIs used here if you want to build the same loop.
