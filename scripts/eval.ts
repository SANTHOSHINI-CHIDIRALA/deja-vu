/**
 * Replays the 20 held-out incidents chronologically against two agents:
 *   memory OFF — plain Groq, no history
 *   memory ON  — Hindsight recall + reflect; after each incident is scored its
 *                resolution is retained, so later incidents can learn from it.
 * Scores each top hypothesis with an LLM judge (family match vs ground truth)
 * and writes data/eval-results.json for the /learning page.
 *
 * Runs against an isolated bank (`<bank>-eval`), freshly seeded from history on
 * every run, so the demo bank never sees eval answers and results are reproducible.
 *
 * Usage: npm run eval            # seed eval bank, run all 20
 *        npm run eval -- --limit 5
 */
import "./env";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { diagnoseWithMemory, diagnoseWithoutMemory } from "../lib/agent";
import { judge, summarise, type EvalResults, type EvalRow, type SideResult } from "../lib/eval";
import { BANK_ID, describeError, retainItems, waitForOperations } from "../lib/hindsight";
import { seedBank } from "../lib/seed";
import { EVAL, incidentTags, renderIncidentDocument, toInput } from "../lib/incidents";
import { PRIMARY_MODEL } from "../lib/llm";
import type { DiagnoseResult, Incident } from "../lib/types";

const EVAL_BANK = `${BANK_ID}-eval`;

async function prepareEvalBank(): Promise<void> {
  // A fresh bank seeded from history only, so demo feedback and earlier eval runs never leak in.
  console.log(`Preparing isolated eval bank ${EVAL_BANK} from history...`);
  let lastProgress = 0;
  await seedBank(EVAL_BANK, {
    reset: true,
    log: (m) => {
      // Throttle the polling chatter.
      if (!m.startsWith("  tracked=") || Date.now() - lastProgress > 30_000) {
        lastProgress = Date.now();
        console.log(m);
      }
    },
  });
}

async function scoreSide(incident: Incident, run: () => Promise<DiagnoseResult>): Promise<SideResult> {
  try {
    const r = await run();
    const top = r.diagnosis.hypotheses[0]!;
    const j = await judge(incident, r.diagnosis);
    return {
      topTitle: top.title,
      topRootCause: top.rootCause,
      judgedFamilies: j.families,
      correct: j.families[0] === incident.family,
      top3Correct: j.families.slice(0, 3).includes(incident.family),
      confidence: top.confidence,
      latencyMs: r.latencyMs,
      citedIncidents: r.citedIncidents,
      fixesToAvoid: r.diagnosis.fixesToAvoid.length,
      model: r.model,
      judgeReason: j.reason,
    };
  } catch (err) {
    return {
      topTitle: "(error)",
      topRootCause: "",
      judgedFamilies: [],
      correct: false,
      top3Correct: false,
      confidence: 0,
      latencyMs: 0,
      citedIncidents: [],
      fixesToAvoid: 0,
      model: "",
      judgeReason: "",
      error: describeError(err),
    };
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : EVAL.length;

  await prepareEvalBank();
  const incidents = [...EVAL].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).slice(0, limit);
  const rows: EvalRow[] = [];
  let offCorrect = 0;
  let onCorrect = 0;

  for (const [index, incident] of incidents.entries()) {
    const input = toInput(incident);
    const [off, on] = await Promise.all([
      scoreSide(incident, () => diagnoseWithoutMemory(input)),
      scoreSide(incident, () => diagnoseWithMemory(input, { bankId: EVAL_BANK })),
    ]);
    offCorrect += off.correct ? 1 : 0;
    onCorrect += on.correct ? 1 : 0;
    rows.push({
      index: index + 1,
      id: incident.id,
      title: incident.title,
      service: incident.service,
      startedAt: incident.startedAt,
      family: incident.family,
      off,
      on,
      cumulative: { off: offCorrect, on: onCorrect, offAccuracy: offCorrect / (index + 1), onAccuracy: onCorrect / (index + 1) },
    });
    const mark = (s: SideResult) => (s.error ? "ERR" : s.correct ? "✓" : s.top3Correct ? "~" : "✗");
    console.log(
      `[${index + 1}/${incidents.length}] ${incident.id} ${incident.family.padEnd(22)} OFF ${mark(off)} (${off.judgedFamilies[0] ?? "-"})  ON ${mark(on)} (${on.judgedFamilies[0] ?? "-"}, ${(on.latencyMs / 1000).toFixed(1)}s)  cum OFF ${offCorrect}/${index + 1} ON ${onCorrect}/${index + 1}`,
    );
    if (off.error) console.log(`   OFF error: ${off.error}`);
    if (on.error) console.log(`   ON error: ${on.error}`);

    // Memory ON learns: retain the resolved incident after scoring it.
    try {
      const ops = await retainItems(
        [
          {
            content: renderIncidentDocument(incident),
            timestamp: incident.startedAt,
            context: `PayNest production incident post-mortem for ${incident.service} (${incident.id})`,
            document_id: incident.id,
            tags: incidentTags(incident, "eval"),
            metadata: { incident_id: incident.id, service: incident.service, family: incident.family, resolved_by: incident.resolvedBy },
          },
        ],
        { bankId: EVAL_BANK, async: true },
      );
      await waitForOperations(ops, { bankId: EVAL_BANK, timeoutMs: 6 * 60_000 });
    } catch (err) {
      console.warn(`   retain of ${incident.id} failed: ${describeError(err)}`);
    }

    // Persist after every incident so a crash still leaves usable results.
    write(rows);
  }
  const results = write(rows);
  console.log(`\nMemory OFF accuracy ${(results.summary.off.accuracy * 100).toFixed(0)}% | Memory ON accuracy ${(results.summary.on.accuracy * 100).toFixed(0)}%`);
  console.log(`First half ON ${(results.summary.firstHalf.on * 100).toFixed(0)}% -> second half ON ${(results.summary.secondHalf.on * 100).toFixed(0)}%`);
}

function write(rows: EvalRow[]): EvalResults {
  const results: EvalResults = {
    generatedAt: new Date().toISOString(),
    bankId: EVAL_BANK,
    judgeModel: PRIMARY_MODEL,
    n: rows.length,
    summary: summarise(rows),
    rows,
  };
  writeFileSync(join(process.cwd(), "data", "eval-results.json"), JSON.stringify(results, null, 2) + "\n");
  return results;
}

main().catch((err) => {
  console.error(`Eval failed: ${describeError(err)}`);
  process.exit(1);
});
