/**
 * Cold-start learning curve. Starts from an EMPTY bank (`<bank>-cold`, configured
 * exactly like the main bank) and replays incidents chronologically — the 40
 * history incidents (Mar–Sep) then the 20 eval incidents (Oct). For each one:
 *   1. diagnose with memory OFF (plain Groq) and memory ON (Hindsight),
 *   2. LLM-judge both on failure-family match,
 *   3. THEN retain the incident + its resolution, as if the team just resolved it.
 * So memory ON only ever knows about incidents that happened before the current one.
 * Writes data/eval-cold-results.json for the headline chart on /learning.
 *
 * Usage: npm run eval:cold
 *        npm run eval:cold -- --history-stride 2   # subsample history (every 2nd) for a faster run
 *        npm run eval:cold -- --limit 10           # quick smoke run
 */
import "./env";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { diagnoseWithMemory, diagnoseWithoutMemory } from "../lib/agent";
import {
  FAMILY_JUDGE_MODELS,
  FIX_JUDGE_MODELS,
  countMemories,
  earlierFailedFixes,
  retainResolution,
  rollingAccuracy,
  scoreSide,
  summariseCold,
  type ColdResults,
  type ColdRow,
  type SideResult,
} from "../lib/eval";
import { BANK_ID, configureBank, deleteBankIfExists, describeError } from "../lib/hindsight";
import { EVAL, HISTORY, toInput } from "../lib/incidents";

const COLD_BANK = `${BANK_ID}-cold`;
const ALL_INCIDENTS = [...HISTORY, ...EVAL];
const WINDOW = 10;

function argNumber(name: string, fallback: number): number {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  const v = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const stride = argNumber("--history-stride", 1);
  const history = HISTORY.filter((_, i) => i % stride === 0).map((i) => ({ incident: i, phase: "history" as const }));
  const evalSet = EVAL.map((i) => ({ incident: i, phase: "eval" as const }));
  const timeline = [...history, ...evalSet]
    .sort((a, b) => a.incident.startedAt.localeCompare(b.incident.startedAt))
    .slice(0, argNumber("--limit", Infinity));

  console.log(`Recreating empty bank ${COLD_BANK}...`);
  await deleteBankIfExists(COLD_BANK);
  await configureBank(COLD_BANK);
  console.log(`Replaying ${timeline.length} incidents (${history.length} history + ${evalSet.length} eval) chronologically.`);

  const rows: ColdRow[] = [];
  let offCorrect = 0;
  let onCorrect = 0;

  for (const [index, { incident, phase }] of timeline.entries()) {
    const memoriesBefore = index === 0 ? 0 : await countMemories(COLD_BANK).catch(() => rows.at(-1)?.memoriesBefore ?? 0);
    const input = toInput(incident);
    const fixContext = { earlierFailed: earlierFailedFixes(incident, ALL_INCIDENTS) };
    const [off, on] = await Promise.all([
      scoreSide(incident, () => diagnoseWithoutMemory(input), fixContext),
      scoreSide(incident, () => diagnoseWithMemory(input, { bankId: COLD_BANK }), fixContext),
    ]);
    offCorrect += off.correct ? 1 : 0;
    onCorrect += on.correct ? 1 : 0;
    const row: ColdRow = {
      index: index + 1,
      id: incident.id,
      title: incident.title,
      service: incident.service,
      startedAt: incident.startedAt,
      family: incident.family,
      phase,
      memoriesBefore,
      off,
      on,
      cumulative: { off: offCorrect, on: onCorrect, offAccuracy: offCorrect / (index + 1), onAccuracy: onCorrect / (index + 1) },
      rolling: { off: 0, on: 0 },
    };
    rows.push(row);
    row.rolling = { off: rollingAccuracy(rows, WINDOW, "off"), on: rollingAccuracy(rows, WINDOW, "on") };
    const prev = rows.at(-2)?.fixCumulative ?? { rightFixOff: 0, rightFixOn: 0, repeatedOff: 0, repeatedOn: 0 };
    row.fixCumulative = {
      rightFixOff: prev.rightFixOff + (off.rightFix ? 1 : 0),
      rightFixOn: prev.rightFixOn + (on.rightFix ? 1 : 0),
      repeatedOff: prev.repeatedOff + (off.repeatedFailedFix ? 1 : 0),
      repeatedOn: prev.repeatedOn + (on.repeatedFailedFix ? 1 : 0),
    };

    const mark = (s: SideResult) =>
      (s.error ? "ERR" : s.correct ? "✓" : "✗") + (s.rightFix ? " fix✓" : " fix✗") + (s.repeatedFailedFix ? " REPEAT" : "");
    const elapsed = (Date.now() - t0) / 60_000;
    const eta = (elapsed / (index + 1)) * (timeline.length - index - 1);
    console.log(
      `[${index + 1}/${timeline.length}] ${incident.id} ${phase.padEnd(7)} ${incident.family.padEnd(22)} mem=${String(memoriesBefore).padStart(4)}  OFF ${mark(off)}  ON ${mark(on)} (${(on.latencyMs / 1000).toFixed(1)}s)  rolling${WINDOW} OFF ${Math.round(row.rolling.off * 100)}% ON ${Math.round(row.rolling.on * 100)}%  [${elapsed.toFixed(1)}m, eta ${eta.toFixed(0)}m]`,
    );
    if (off.error) console.log(`   OFF error: ${off.error}`);
    if (on.error) console.log(`   ON error: ${on.error}`);

    // The team resolves the incident: retain its post-mortem synchronously so the
    // next incident can recall it. (Observation consolidation continues in the background.)
    try {
      await retainResolution(incident, COLD_BANK, phase, { async: false });
    } catch (err) {
      console.warn(`   retain of ${incident.id} failed: ${describeError(err)}`);
    }
    write(rows, t0);
  }

  const results = write(rows, t0);
  const sm = results.summary;
  console.log(`\nRoot-cause accuracy: OFF ${Math.round(sm.off.accuracy * 100)}% | ON ${Math.round(sm.on.accuracy * 100)}%`);
  console.log(`Right fix first try: OFF ${Math.round(sm.off.rightFix * 100)}% | ON ${Math.round(sm.on.rightFix * 100)}%`);
  console.log(`Known-failed fixes repeated: OFF ${sm.off.repeatedFailed} | ON ${sm.on.repeatedFailed}`);
  for (const b of results.summary.blocks) {
    console.log(`  incidents ${b.from}-${b.to} (memories at start ${b.memoriesAtStart}): OFF ${Math.round(b.off * 100)}%  ON ${Math.round(b.on * 100)}%`);
  }
  console.log(`Runtime ${results.runtimeMinutes.toFixed(1)} min`);
}

function write(rows: ColdRow[], t0: number): ColdResults {
  const results: ColdResults = {
    generatedAt: new Date().toISOString(),
    bankId: COLD_BANK,
    judgeModel: `family: ${FAMILY_JUDGE_MODELS[0]} · fix: ${FIX_JUDGE_MODELS[0]}`,
    n: rows.length,
    window: WINDOW,
    runtimeMinutes: (Date.now() - t0) / 60_000,
    summary: summariseCold(rows, WINDOW),
    rows,
  };
  writeFileSync(join(process.cwd(), "data", "eval-cold-results.json"), JSON.stringify(results, null, 2) + "\n");
  return results;
}

main().catch((err) => {
  console.error(`Cold eval failed: ${describeError(err)}`);
  process.exit(1);
});

