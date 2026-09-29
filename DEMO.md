# Déjà Vu — 3-minute demo script

The exact click path, what to say, and what should appear on screen. The incidents were picked because they show the biggest, most **repeatable** gap between memory OFF and memory ON. Each was re-run 3× before this was written; see "Why these incidents" at the bottom.

## Before you go on stage (5 min)

1. Reset the demo bank so no feedback from rehearsals leaks in:
   ```bash
   npm run seed -- --clear-feedback
   ```
   It should end with `documents=40`.
2. Open two tabs: **Console** (`/`) and **Learning curve** (`/learning`).
3. On a projector, zoom the browser to 125–150%. Both columns stay side by side above 1024px; below that they become tabs.
4. Do one throw-away **Diagnose** on any *other* incident to warm up Groq and Hindsight. Don't use INC-2369 or INC-2411, and don't click feedback buttons.

> Memory-ON answers are generated live, so the wording changes between runs. What stays stable: the root-cause family, citing past incidents of the same kind, the known-failed fixes and the suggested expert. Narrate those rather than exact sentences.

---

## 0:00 – 0:15 · The hook

**Screen:** Console. The picker already shows **`INC-2369 · SEV1 · payments-api — Checkout success rate drop — payments-api worker timeouts`** (the default selection).

**Say:** *"It's 2:47am. Checkout success rate at PayNest just dropped to 71%. You're on call. The alert fired at 02:47 IST, and a deploy went out 38 minutes ago that bumped gunicorn workers from 8 to 16."*

Point at the red alert card: `CheckoutSuccessRateLow`, recent change `cabd556` by Rohan Gupta, and the `WORKER TIMEOUT` log lines.

## 0:15 – 0:50 · Same alert, two agents

**Click:** **Diagnose ▶**

**What appears:**
- **Left, Without memory** (about 2 s): a generic answer, typically *"Gunicorn overload after config change"*, advising more CPU/memory or a rollback. It cites no past incidents.
- **Right, With Déjà Vu memory:** a live checklist ticks off real pipeline steps:
  - ✓ *Recalled similar incidents* ("44 memories from 16 past incidents")
  - ✓ *Checked fixes that failed before*
  - ⟳ *Reasoning over evidence…*, with an elapsed timer
  
  **Talk over the ~13 s wait:** *"It's searching every past PayNest outage, checking what already failed, then reasoning over the evidence."*
- Then the memory answer: **#1 DB connection pool exhaustion**, about 90% confidence. It explains that `cabd556` doubled workers, citing past worker-bump incidents (e.g. INC-2237, INC-2304). There is a red **Known-failed fixes** list (restarting pods, scaling the HPA, raising `max_connections`), and destructive commands carry a **needs human approval** badge. At the bottom: **Page Priya Raman**, who resolved most of these.

**Say:** *"Same alert, same evidence on screen. The difference is memory: it knows restarting pods didn't work last time, and it knows who fixed it."*

## 0:50 – 1:15 · Show the evidence

**Click:** scroll to the **Memory Inspector** below the right column.
- The **Recalled** tab lists memories with type badges (`WORLD`, `EXPERIENCE`, `OBSERVATION`), dates and recall scores.
- Click the **Observations** tab to show consolidated patterns about the service.
- Click any cited **`INC-xxxx`** chip. A drawer opens with that past incident: root cause, **Fix that worked** (green), **Fixes that failed** (red, e.g. *"restarted payments-api pods — pool re-exhausted within 4 minutes"*), the on-call chat timeline and the post-mortem.

**Say:** *"Every claim is cited. You can audit exactly which memories it used."* Close the drawer with Esc.

## 1:15 – 1:55 · It learns from you

**Click:** on the right column's **#1 hypothesis**, click **✕ This suggestion failed**. Optionally first click "+ note" and type *"capping the pool didn't help, still 503s"*.

**What appears:** *"✕ Recorded: this suggestion failed. Retained as an experience memory."* A purple banner appears with **Re-run with updated memory ↻**.

**Click:** **Re-run with updated memory ↻**. The checklist runs again, and *Checked fixes that failed before* now reports **"1 on-call verdict (1 failed fix)"**.

**What appears:** a purple **"What changed after your feedback"** box, with:
- the **Recommended fix** struck through and replaced by a different proven fix (e.g. pgbouncer transaction pooling or a rollback);
- **New fixes to avoid**, listing the fix you just rejected.

In the Memory Inspector, your feedback shows at the top of **Recalled** as a purple **on-call feedback** `EXPERIENCE` memory.

**Say:** *"That was one click. It's now a memory. The next engineer who gets this alert won't be told to try it again."*

## 1:55 – 2:30 · The red herring

**Click:** in the picker choose **`INC-2411 · SEV2 · upi-gateway — upi-gateway long GC pauses and latency`**, then **Diagnose ▶**.

**Say while it loads:** *"Here's a nasty one. The JVM is in 4-second GC pauses, and 3 hours ago someone bumped the logging library. Obvious suspect, right?"*

**What appears:**
- **Without memory:** *"Logging library upgrade caused memory pressure / GC storms"*, recommending rollback of the logging change. This happened in 3 of 3 rehearsal runs. It's **wrong**.
- **With Déjà Vu:** **#1 NPCI / SBI bank switch degradation**, citing earlier NPCI timeout incidents (e.g. INC-2336, INC-2330, INC-2362). It points out that 30 s ReqPay timeouts to SBI are filling the npci-client queue, which is *why* the heap is full. Known-failed fixes include *restarting upi-gateway pods* and *raising the npci-client timeout*. It suggests paging **Rahul Verma**.

**Say:** *"The GC pauses are a symptom. PayNest has seen this pattern before: a partner bank slows down and the thread pool backs up. Without memory you'd roll back a harmless logging change at 3am."*

(Backup if needed: **INC-2387, "Festive sale day 1 — payments-api DB pool timeouts"**. Without memory it says "DB pool exhaustion" (3/3); with memory it finds the Redis eviction storm underneath.)

## 2:30 – 2:55 · It gets measurably better

**Click:** the **Learning curve** tab.

**Top section, Cold start:** point at the stat tiles and the two stacked charts.
- The top chart shows rolling 10-incident accuracy for memory ON vs OFF over 60 incidents, with the bank starting **empty**.
- The bottom chart shows **memories in the bank** growing from 0 to 664 as incidents are resolved.

**Say, honestly:** *"Starting from nothing, memory ON was right on all 60 incidents. The plain LLM was also perfect on the easy ones. But once the misleading incidents arrive in October, it drops to 80–90% while memory ON stays at 100%, with 460+ memories to cite."* Point at the hollow blue dots in October: INC-2369, INC-2387 and INC-2411, the incidents you just demoed. Don't claim the ON line climbs; it's flat.

**Scroll to Warm start:** 20 held-out October incidents with 40 past incidents in memory. **Memory ON 100% vs OFF 80%**. The OFF misses are exactly the red herrings, INC-2411 among them. The per-incident table shows what each agent said.

## 2:55 – 3:00 · Close

**Say:** *"Every team has this knowledge. It's in post-mortems nobody reads at 3am and in the heads of people who are asleep. Déjà Vu makes sure it's never lost."*

---

## If something goes wrong

| Symptom | What to do |
|---|---|
| A column shows "Diagnosis failed" | Groq/Hindsight rate limit. Wait 5 s and click **Diagnose** again. The other column is unaffected. |
| A yellow ⚠ warning appears above the memory answer | Hindsight reflect fell back to recall + Groq. The answer is still memory-based and cited, so carry on. |
| The re-run shows "(unchanged)" for the top hypothesis | Expected when the root cause is still right. Point at the changed **Recommended fix** and **New fixes to avoid** lines instead. |
| Feedback from rehearsal is showing up | Run `npm run seed -- --clear-feedback` and reload. |

## Why these incidents

Re-running each candidate 3× against the demo bank (`paynest-sre`, 40 history incidents):

| Incident | Ground truth | Memory OFF (3 runs) | Memory ON |
|---|---|---|---|
| INC-2369 | DB pool exhaustion after worker bump | "Gunicorn overload" / resource limits (wrong family in warm eval) | DB pool exhaustion, cites worker-bump incidents, pages Priya |
| **INC-2411** | NPCI/SBI bank timeout | ✗ logging library → GC, **3/3 wrong** | ✓ SBI bank degradation, pages Rahul |
| INC-2387 | Redis eviction storm (festive sale) | ✗ DB pool exhaustion, **3/3 wrong** | ✓ Redis eviction storm / cache stampede |
| INC-2371 | NPCI/Axis bank timeout (flag push red herring) | 2/3 wrong | ✓ NPCI remitter bank timeout |
