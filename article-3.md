# My agent ignored its own failure memories until I fixed this

The feature I was proudest of didn't work at first. An on-call engineer clicks "✕ This suggestion failed", I store that as a memory, and the next diagnosis is supposed to avoid the fix. I clicked the button, re-ran the alert, and got the same answer back.

This is the story of two bugs in Déjà Vu, the on-call agent I built for PayNest's payments platform on top of Hindsight memory ([Hindsight on GitHub](https://github.com/vectorize-io/hindsight)):

1. The agent ignored explicit feedback.
2. The agent paraphrased the team's runbook commands into generic advice.

Both came down to the same lesson: *what's in memory* and *what the agent says* are different things, and you have to check both.

![Déjà Vu console with the Memory Inspector](https://raw.githubusercontent.com/SANTHOSHINI-CHIDIRALA/deja-vu/main/docs/console.png)

## How the feedback loop is supposed to work

Every memory-ON hypothesis has two buttons: "✓ Resolved — this fix worked" and "✕ This suggestion failed". A click becomes a first-person *experience* memory, retained synchronously so the very next run can see it:

```ts
const text =
  fb.outcome === "failed"
    ? `Feedback on my suggestion for alert ${fb.incidentId} (${fb.alertname} on ${fb.service}): I suggested "${fb.hypothesisTitle}" with the fix "${fb.fix}". The on-call engineer tried it and reported that this suggestion FAILED — it did not resolve ${fb.incidentId}.${note} For similar ${fb.service} alerts I must not recommend "${fb.fix}" again without saying it failed in ${fb.incidentId}, and I should rank "${fb.hypothesisTitle}" lower.`
    : /* …the WORKED variant… */;
```

It is tagged `source:feedback`, `outcome:failed`, `service:payments-api` and `incident:INC-2369`. The bank's mission and directives already say "if a fix previously failed for a similar incident, say so explicitly." On paper this is enough.

## Bug 1: the verdict was in memory, but not in the answer

The test incident was INC-2369: checkout success rate at 71%, and a deploy that doubled gunicorn workers. The first diagnosis recommended rolling back that deploy. I clicked "failed" and re-ran. The top hypothesis and recommended fix were unchanged, and the new "fixes to avoid" list didn't mention the rollback I had just rejected.

So I looked at what Hindsight had actually stored for the feedback document. Extraction had produced two facts:

- an **experience**: "The agent suggested rolling back commit cabd556 to fix Database Connection Pool Exhaustion, but the on-call engineer reported this fix failed to resolve INC-2369."
- a **world** fact: "Incident INC-2369 occurred on payments-api service, triggered by CheckoutSuccessRateLow alert."

The verdict was stored correctly. But in the Memory Inspector, the fact recall surfaced for my feedback was the bland world fact, the one *without* the verdict, and reflect never weighed the experience.

The fix was to stop hoping general recall would find the verdict. I ask for it explicitly, by tag, before reflect runs:

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

`any_strict` matters: it excludes untagged memories, so I only get on-call verdicts. I then filter them to the same service or incident, and hand them to reflect as authoritative, with explicit instructions:

```text
ON-CALL FEEDBACK MEMORIES (authoritative verdicts from engineers on my earlier suggestions for similar alerts):
${feedback.map((f) => `- ${f.text}`).join("\n")}
Apply them: a fix reported as FAILED must appear in fixesToAvoid (cite the alert ID it failed for) and must
NOT be recommended again; lower the confidence of the hypothesis it came from, or keep the hypothesis only if
the evidence still supports it and recommend a DIFFERENT fix that worked in past incidents.
```

I also added a line to the bank's retain mission: "For on-call feedback on the agent's own suggestions, always keep the verdict (WORKED or FAILED), the exact fix and the incident ID in the same fact."

After that, the loop worked. On today's data, INC-2369's first answer recommends `RB-PG-07: pnctl db pool-cap payments-api --size 5 --overflow 5`. After one "failed" click:

- the progress panel reports **"1 on-call verdict (1 failed fix)"**;
- `RB-PG-07` moves to *fixes to avoid*;
- the recommendation switches to **`RB-REL-02: pnctl config rollback payments-api-config`**.

## Bug 2: memory stored the command, the agent paraphrased it

The second bug showed up when I started measuring whether the agent recommends *PayNest's* fix: the specific runbook, not a generic equivalent. Early smoke runs scored zero.

INC-2204, the first Redis eviction storm in the replay, was resolved with a runbook, and Hindsight's facts for it were perfect:

> Arjun Mehta resolved INC-2204 by running runbook RB-CACHE-04: `pnctl cache harden vpa:resolve:*` (CACHE_TTL_JITTER_PCT=20 + singleflight on the prefix) and `pnctl redis resize redis-cache --maxmemory 24gb`.

But when the next Redis incident came in (INC-2210, on `auth-svc`), the memory-ON agent recommended "Implement TTL jitter, request coalescing, and increase Redis maxmemory." That is the right idea, and the wrong answer for an engineer who needs the command at 3am.

**Fix, part one:** I told it in words. I added "Keep … runbook IDs (RB-...), pnctl commands, config keys and route names verbatim" to the retain mission, and told the reflect query to quote the exact runbook ID and command. INC-2210's answer improved to "Revert deployment and apply cache hardening with CACHE_TTL_JITTER_PCT and singleflight." It was closer, but still a paraphrase.

**Fix, part two: the schema.** Reflect returns structured output via a JSON schema, and that projection is a separate pass over the agent's answer. The field description is what that pass reads, so that's where the instruction had to live:

```ts
recommendedFix: {
  type: "string",
  description:
    "The fix that worked for the cited incidents, adapted to this alert. Quote PayNest's runbook ID and exact command(s) VERBATIM (e.g. 'RB-XX-00: `pnctl ...`'), not a paraphrase.",
},
```

The answer for the next Redis incident, INC-2254, was `RB-CACHE-04: pnctl cache harden vpa:resolve:* and pnctl redis resize redis-cache --maxmemory 24gb`, correctly adapted to that incident's key prefix.

## What both fixes bought

On a replay of 40 incidents starting from an empty bank:

| | Memory OFF | Memory ON |
|---|---|---|
| Right fix first try | 0% | **70%** (82% when a failure recurs) |
| Recommended a fix that already failed | **9** | **2** |

![Learning curve: right fix first try and known-failed fixes repeated](https://raw.githubusercontent.com/SANTHOSHINI-CHIDIRALA/deja-vu/main/docs/learning.png)

It's not perfect:
- Memory ON still repeated a failed fix twice (restarting pods for INC-2244, resetting consumer offsets for INC-2427).
- It sometimes leaves a placeholder in a command, e.g. `--psp [BANK]`.
- When a rejected fix bundled two actions, the replacement can overlap with half of it.

## Lessons

1. **Look at the stored facts, not just the answer.** The Memory Inspector showing type, text and score for every recalled memory is what exposed Bug 1 in minutes.
2. **Recall the memories that must never be missed explicitly.** General semantic recall optimises relevance, not authority. Tag feedback and fetch it deliberately.
3. **Structured output is its own extraction step.** Instructions in the prompt didn't survive it; the schema's field description did.
4. **Test the loop end to end.** I check click → retain → re-run in a headless browser, and "1 on-call verdict (1 failed fix)" is the line I look for.

If you're wondering [what agent memory is](https://vectorize.io/what-is-agent-memory) beyond a vector store, this is my answer: memory the agent is *made* to act on. The [Hindsight documentation](https://hindsight.vectorize.io/) covers the tags, fact types and reflect options used here.
