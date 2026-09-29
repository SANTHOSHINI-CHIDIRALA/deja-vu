# My agent's learning curve was flat. Hindsight wasn't the problem

I built a "learning curve" page for my on-call agent, ran the evaluation from an empty memory, and got a perfectly flat line at 100%. For about ten minutes that felt like a win. Then I realised a flat line at the top means the metric can't see learning at all.

Déjà Vu diagnoses production alerts for PayNest's UPI payments platform. It runs each alert twice, once as a plain LLM call and once through a Hindsight memory bank of past incidents ([Hindsight on GitHub](https://github.com/vectorize-io/hindsight)). This post is about how I measured it wrong, why the fault was in my metric and my data rather than the memory layer, and what the curve looked like once I fixed them.

![Déjà Vu console: memory OFF vs memory ON on the same alert](https://raw.githubusercontent.com/SANTHOSHINI-CHIDIRALA/deja-vu/main/docs/console.png)

(The incident corpus is a generated but realistic replay: six recurring failure families, 40 historical incidents and 20 held-out ones.)

## The flat line

My first metric was root-cause *family* accuracy: did the top hypothesis name the right failure family? An LLM judge compared it against ground truth.

- **Warm start** (40 past incidents already in memory, 20 held-out incidents): memory ON 100%, memory OFF 80%.
- **Cold start** (empty bank, all 60 incidents replayed in order, each resolution retained only after scoring):

| Incidents | Memories in bank at block start | Memory OFF | Memory ON |
|---|---|---|---|
| 1–40 (history) | 0, 113, 233, 341 | 100% | 100% |
| 41–50 (Oct) | 457 | 80% | 100% |
| 51–60 (Oct) | 570 | 90% | 100% |

Memory ON was right from incident #1, when the bank was empty. Memory OFF was also perfect on all 40 historical incidents. The only gap came from three October incidents with deliberately misleading symptoms, like JVM GC pauses that were really a bank timeout.

The memory bank grew from 0 to 664 memories and accuracy didn't move. My first instinct was to blame recall. It wasn't recall.

## Diagnosis 1: the metric was guessable

`QueuePool limit of size 20 overflow 10 reached` plus a deploy that doubled gunicorn workers *is* DB pool exhaustion. Any capable model reads that from the logs. The reflect call reasons from the alert even when memory has nothing to offer, so with an empty bank it did exactly what the plain LLM did.

Family accuracy measures pattern-matching on symptoms, and memory can't improve a skill that's already at ceiling. What a model *can't* get from logs is company-specific:

- the fix this team actually runs;
- the fixes this team already tried that didn't work.

## Diagnosis 2: the data had nothing company-specific to learn

When I audited the incident history, the "fix that worked" was the problem:

- **Inconsistent across recurrences.** DB pool exhaustion had three different fixes: cap the pool, roll back the deploy, switch pgbouncer to transaction pooling.
- **Generic.** "Added TTL jitter and singleflight" is textbook advice, not something only this team would know.

Even a perfect memory can't learn a convention that doesn't exist. (The fixes that *failed* were already right: restart pods, scale up, FLUSHALL, raise timeouts. Those are the generic moves on-call reaches for.)

## What I changed

**1. One canonical PayNest fix per family,** as a runbook plus an internal tool command:

```ts
dbPool: (service: string) =>
  `ran runbook RB-PG-07: \`pnctl db pool-cap ${service} --size 5 --overflow 5\` (sets PN_DB_POOL_SIZE=5 / PN_DB_MAX_OVERFLOW=5 and rolls ${service})`,
```

The generator is deterministic, and I needed incident IDs, alerts, logs, root causes, failed fixes and the red-herring incidents to stay byte-identical. So the random draw that used to pick a fix is still consumed:

```ts
fixThatWorked: (void rng.pick(fixes), PAYNEST_FIX.dbPool(service)), // PRNG draw kept so incident IDs stay stable
```

I verified it field by field: only `fixThatWorked`, and the timeline and post-mortem text that quote it, changed.

**2. Metrics that only memory can win.** Two per-incident checks, both LLM-judged against ground truth:
- *right fix first try*: the top recommendation is specifically the fix that worked, not "a generic equivalent";
- *repeated a known-failed fix*: it recommends something that failed in an earlier incident of the same family.

The judge rubric draws the line explicitly:

```text
rightFix = true ONLY if the agent's TOP recommended fix is specifically the ground-truth fix: the same
concrete action — same internal tool/command or runbook, or the same specific config change and values,
or the same named failover route.
```

**3. One agent fix.** Hindsight had stored the runbook commands verbatim all along. My reflect call's structured output paraphrased them ("implement TTL jitter…") until I told the schema's `recommendedFix` field to quote runbook IDs and commands verbatim.

## The curve, measured properly

Same design (empty bank, chronological, score then retain), 40 incidents:

![Learning curve: cumulative right-fix-first-try rate and known-failed fixes repeated](https://raw.githubusercontent.com/SANTHOSHINI-CHIDIRALA/deja-vu/main/docs/learning.png)

| Incidents | Right fix, OFF | Right fix, ON | Repeated failed fixes, OFF / ON |
|---|---|---|---|
| 1–10 | 0% | 40% | 0 / 1 |
| 11–20 | 0% | 80% | 3 / 0 |
| 21–30 | 0% | 80% | 4 / 0 |
| 31–40 | 0% | 80% | 2 / 1 |
| **All 40** | **0%** | **70%** | **9 / 2** |

- **Now the line moves.** Memory ON scores 0 of 6 on the first incident of each family, then 28 of 34 (82%) on recurrences.
- **Memory OFF never produces PayNest's fix.** It kept telling on-call to restart pods and raise `max_connections` after those had failed.
- **One example is enough.** The second Kafka incident, diagnosed with 16 memories in the bank, got `RB-KAFKA-02: pnctl kafka stabilize notif-worker` right.

The honest part: **family accuracy is now roughly even** (ON 90%, OFF 88%), and memory ON is lower than its 100% in the flat run.
- It misclassified two incidents while the bank was nearly empty.
- It also misclassified two later ones, including a red herring where "all banks are down" was really our own expired mTLS certificate.
- My guess is that pushing reflect to prefer proven runbook actions biases it toward frequent families. I haven't proven that, so it stays a guess in the README too.

## Why "Hindsight wasn't the problem"

At every step, the memory layer had what it needed:
- the extracted facts contained the runbook commands verbatim;
- recall surfaced the right incidents;
- observations consolidated the per-service patterns.

The flat line came from three things I owned:
- a metric at ceiling;
- data with no consistent company knowledge in it;
- a schema field that invited paraphrase.

If you want to know [what agent memory is](https://vectorize.io/what-is-agent-memory) worth for your use case, the first question isn't which memory system. It's whether your eval measures something a model couldn't know without it.

## Lessons

1. **A flat curve at 100% is a broken ruler, not a great agent.**
2. **Audit the ground truth before blaming retrieval.** If the "right answer" changes every time, nothing can learn it.
3. **Change data minimally and prove it.** Keep IDs stable, diff every field, and disclose the change.
4. **Report the metric that got worse.** Family accuracy dipping to 90% belongs in the write-up next to the 0% → 70%.

The eval code, both result files and the data generator are in the repo. The [Hindsight documentation](https://hindsight.vectorize.io/) covers retain missions, structured reflect and tags if you want to reproduce it.
