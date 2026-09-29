import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ColdStartCharts, FixCharts } from "@/components/ColdStartCharts";
import { LearningChart } from "@/components/LearningChart";
import { SERIES } from "@/lib/chart-colors";
import { FamilyChip } from "@/components/ui";
import type { ColdResults, EvalResults } from "@/lib/eval";
import { HISTORY } from "@/lib/incidents";

export const metadata = { title: "Learning curve — Déjà Vu" };

function load<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), "data", file), "utf8")) as T;
  } catch {
    return null;
  }
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export default function LearningPage() {
  const results = load<EvalResults>("eval-results.json");
  const cold = load<ColdResults>("eval-cold-results.json");
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Learning curve</h1>
        <p className="max-w-3xl text-sm text-ink-400">
          Both agents see only the alert, logs and recent change; an LLM judge checks whether the top hypothesis names the right failure family.
          The memory-OFF agent is a plain Groq LLM call with no history (the serving model is recorded with each result).
        </p>
      </div>

      <ColdStartSection cold={cold} />

      <section className="space-y-5">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Warm start: 20 held-out incidents with 40 past incidents in memory</h2>
          <p className="max-w-3xl text-sm text-ink-400">
            October 2026 incidents replayed in order. Memory ON starts from PayNest&apos;s 40 past incidents and retains each resolution after it
            is scored. Several of these incidents carry red herrings.
          </p>
        </div>
      {!results || !results.rows.length ? (
        <div className="panel p-8 text-center text-sm text-ink-400">
          No evaluation results yet. Run <code className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-ink-100">npm run eval</code> to
          generate <code className="font-mono">data/eval-results.json</code>.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Root-cause accuracy" on={pct(results.summary.on.accuracy)} off={pct(results.summary.off.accuracy)} />
            <Stat label="Right family in top 3" on={pct(results.summary.on.top3)} off={pct(results.summary.off.top3)} />
            <Stat
              label="Accuracy, 2nd half"
              on={pct(results.summary.secondHalf.on)}
              off={pct(results.summary.secondHalf.off)}
              hint={`1st half: ON ${pct(results.summary.firstHalf.on)} · OFF ${pct(results.summary.firstHalf.off)}`}
            />
            <Stat
              label="Time to hypothesis"
              on={`${(results.summary.on.avgLatencyMs / 1000).toFixed(1)}s`}
              off={`${(results.summary.off.avgLatencyMs / 1000).toFixed(1)}s`}
              hint={`Human mean time-to-resolve in history: ${Math.round(HISTORY.reduce((s, i) => s + i.ttrMinutes, 0) / HISTORY.length)} min`}
            />
          </div>

          <section className="panel p-4">
            <h2 className="mb-1 font-semibold">Cumulative root-cause accuracy</h2>
            <LearningChart rows={results.rows} />
          </section>

          <section className="panel overflow-hidden">
            <h2 className="border-b border-ink-700 px-4 py-3 font-semibold">Per-incident results</h2>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="text-[11px] uppercase tracking-wider text-ink-400">
                  <tr className="border-b border-ink-700">
                    <th className="px-4 py-2">#</th>
                    <th className="px-2 py-2">Incident</th>
                    <th className="px-2 py-2">Ground truth</th>
                    <th className="px-2 py-2">Memory OFF top hypothesis</th>
                    <th className="px-2 py-2">Memory ON top hypothesis</th>
                    <th className="px-2 py-2">Cited</th>
                  </tr>
                </thead>
                <tbody>
                  {results.rows.map((r) => (
                    <tr key={r.id} className="border-b border-ink-800 align-top">
                      <td className="px-4 py-2 font-mono text-ink-400">{r.index}</td>
                      <td className="px-2 py-2">
                        <div className="font-mono text-xs text-mem">{r.id}</div>
                        <div className="text-ink-100">{r.title}</div>
                      </td>
                      <td className="px-2 py-2">
                        <FamilyChip family={r.family} />
                      </td>
                      <td className="px-2 py-2">
                        <Verdict ok={r.off.correct} text={r.off.error ? `error: ${r.off.error}` : r.off.topTitle} />
                      </td>
                      <td className="px-2 py-2">
                        <Verdict ok={r.on.correct} text={r.on.error ? `error: ${r.on.error}` : r.on.topTitle} />
                      </td>
                      <td className="px-2 py-2 font-mono text-xs text-ink-300">{r.on.citedIncidents.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="px-4 py-3 text-xs text-ink-400">
              Generated {new Date(results.generatedAt).toUTCString()} · eval bank <span className="font-mono">{results.bankId}</span> · judge{" "}
              <span className="font-mono">{results.judgeModel}</span>
            </p>
          </section>
        </>
      )}
      </section>
    </div>
  );
}

function ColdStartSection({ cold }: { cold: ColdResults | null }) {
  if (!cold || !cold.rows.length)
    return (
      <section className="panel p-8 text-center text-sm text-ink-400">
        No cold-start results yet. Run <code className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-ink-100">npm run eval:cold</code> to
        generate <code className="font-mono">data/eval-cold-results.json</code>.
      </section>
    );
  const first = cold.summary.blocks[0]!;
  const last = cold.summary.blocks.at(-1)!;
  const lastRow = cold.rows.at(-1)!;
  const evalRows = cold.rows.filter((r) => r.phase === "eval");
  const evalAcc = (k: "on" | "off") => (evalRows.length ? evalRows.filter((r) => r[k].correct).length / evalRows.length : 0);
  const hasFix = cold.rows.some((r) => r.fixCumulative);
  const s = cold.summary;
  const evalRate = (k: "on" | "off") => (evalRows.length ? evalRows.filter((r) => r[k].rightFix).length / evalRows.length : 0);
  return (
    <section className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Cold start: learning from an empty memory</h2>
        <p className="max-w-3xl text-sm text-ink-400">
          {cold.n} incidents (Mar → Oct 2026) replayed in order against a bank that starts <b className="text-ink-100">empty</b>. Each alert is
          diagnosed with memory OFF and ON and scored, <i>then</i> its resolution is retained — as if the team just resolved it. Memory ON only
          ever knows about incidents that happened before.
          {hasFix && (
            <>
              {" "}
              The headline metric is PayNest-specific: did the <b className="text-ink-100">top recommended fix</b> match the fix that actually
              worked (the team&apos;s runbook action, not a generic equivalent), and did the agent tell you to repeat a fix that{" "}
              <b className="text-ink-100">already failed</b> in an earlier incident of the same kind?
            </>
          )}
        </p>
      </div>
      {hasFix ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Right fix first try" on={pct(s.on.rightFix)} off={pct(s.off.rightFix)} hint={`all ${cold.n} incidents`} />
            <Stat label="Right fix, held-out Oct" on={pct(evalRate("on"))} off={pct(evalRate("off"))} hint={`${evalRows.length} incidents`} />
            <Stat label="Known-failed fixes repeated" on={String(s.on.repeatedFailed)} off={String(s.off.repeatedFailed)} hint="lower is better" />
            <Stat label="Root-cause family accuracy" on={pct(s.on.accuracy)} off={pct(s.off.accuracy)} hint="coarse — guessable from symptoms" />
          </div>
          <div className="panel p-4">
            <h3 className="mb-1 font-semibold">Right fix first try, and known-failed fixes repeated</h3>
            <FixCharts rows={cold.rows} />
          </div>
          <h3 className="pt-2 font-semibold">Secondary: root-cause family accuracy</h3>
        </>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Overall accuracy" on={pct(cold.summary.on.accuracy)} off={pct(cold.summary.off.accuracy)} />
          <Stat label={`First ${first.to} incidents`} on={pct(first.on)} off={pct(first.off)} hint="memory starts empty" />
          <Stat label={`Last ${last.to - last.from + 1} incidents`} on={pct(last.on)} off={pct(last.off)} hint={`${last.memoriesAtStart} memories at start`} />
          <Stat
            label="Held-out Oct incidents"
            on={pct(evalAcc("on"))}
            off={pct(evalAcc("off"))}
            hint={`${evalRows.length} incidents · ${lastRow.memoriesBefore} memories by the end`}
          />
        </div>
      )}
      <div className="panel p-4">
        <ColdStartCharts rows={cold.rows} window={cold.window} />
      </div>
      <div className="panel overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="text-[11px] uppercase tracking-wider text-ink-400">
            <tr className="border-b border-ink-700">
              <th className="px-4 py-2">Incidents</th>
              <th className="px-2 py-2">Memories at start</th>
              <th className="px-2 py-2">Family acc. OFF</th>
              <th className="px-2 py-2">Family acc. ON</th>
              <th className="px-2 py-2">Δ</th>
              {hasFix && (
                <>
                  <th className="px-2 py-2">Right fix OFF</th>
                  <th className="px-2 py-2">Right fix ON</th>
                  <th className="px-2 py-2">Repeats OFF / ON</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {cold.summary.blocks.map((b) => (
              <tr key={b.from} className="border-b border-ink-800 tabular-nums">
                <td className="px-4 py-2 font-mono text-ink-300">
                  {b.from}–{b.to}
                </td>
                <td className="px-2 py-2">{b.memoriesAtStart}</td>
                <td className="px-2 py-2">{pct(b.off)}</td>
                <td className="px-2 py-2 font-semibold">{pct(b.on)}</td>
                <td className={`px-2 py-2 ${b.on > b.off ? "text-emerald-300" : b.on < b.off ? "text-red-300" : "text-ink-400"}`}>
                  {b.on === b.off ? "±0" : `${b.on > b.off ? "+" : ""}${Math.round((b.on - b.off) * 100)} pts`}
                </td>
                {hasFix && (
                  <>
                    <td className="px-2 py-2">{pct(b.rightFix?.off ?? 0)}</td>
                    <td className="px-2 py-2 font-semibold">{pct(b.rightFix?.on ?? 0)}</td>
                    <td className="px-2 py-2">
                      {b.repeatedFailed?.off ?? 0} / {b.repeatedFailed?.on ?? 0}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="px-4 py-3 text-xs text-ink-400">
          Generated {new Date(cold.generatedAt).toUTCString()} · bank <span className="font-mono">{cold.bankId}</span> · judge{" "}
          <span className="font-mono">{cold.judgeModel}</span> · runtime {cold.runtimeMinutes.toFixed(0)} min
        </p>
      </div>
    </section>
  );
}

function Stat({ label, on, off, hint }: { label: string; on: string; off: string; hint?: string }) {
  return (
    <div className="panel p-4">
      <div className="text-[11px] uppercase tracking-wider text-ink-400">{label}</div>
      <div className="mt-2 flex items-baseline gap-3">
        <span className="text-3xl font-semibold tabular-nums text-ink-100">{on}</span>
        <span className="flex items-center gap-1 text-xs text-ink-400">
          <span className="inline-block h-0.5 w-3 rounded" style={{ background: SERIES.on.color }} /> ON
        </span>
      </div>
      <div className="mt-1 flex items-center gap-1 text-sm text-ink-300">
        <span className="inline-block h-0.5 w-3 rounded" style={{ background: SERIES.off.color }} />
        OFF <span className="tabular-nums">{off}</span>
      </div>
      {hint && <div className="mt-1 text-[11px] text-ink-400">{hint}</div>}
    </div>
  );
}

function Verdict({ ok, text }: { ok: boolean; text: string }) {
  return (
    <span className="flex gap-1.5">
      <span className={ok ? "text-emerald-400" : "text-red-400"} aria-label={ok ? "correct" : "wrong"}>
        {ok ? "✓" : "✕"}
      </span>
      <span className={ok ? "text-ink-100" : "text-ink-400"}>{text}</span>
    </span>
  );
}
