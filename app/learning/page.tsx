import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LearningChart, SERIES } from "@/components/LearningChart";
import { FamilyChip } from "@/components/ui";
import type { EvalResults } from "@/lib/eval";
import { HISTORY } from "@/lib/incidents";

export const metadata = { title: "Learning curve — Déjà Vu" };

function loadResults(): EvalResults | null {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), "data", "eval-results.json"), "utf8")) as EvalResults;
  } catch {
    return null;
  }
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export default function LearningPage() {
  const results = loadResults();
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Learning curve</h1>
        <p className="max-w-3xl text-sm text-ink-400">
          20 held-out incidents from October 2026, replayed in order. Both agents see only the alert, logs and recent change. Memory ON starts
          from PayNest&apos;s 40 past incidents and retains each resolution after it is scored. An LLM judge checks whether the top hypothesis
          names the right failure family.
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
    </div>
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
