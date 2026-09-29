"use client";

import { useEffect, useState } from "react";
import type { ProgressEvent, ProgressStep } from "@/lib/types";

export type StepState = { status: "pending" | "start" | "done" | "error"; detail?: string };
export type ProgressState = Record<ProgressStep, StepState>;

export const INITIAL_PROGRESS: ProgressState = {
  recall: { status: "pending" },
  feedback: { status: "pending" },
  reflect: { status: "pending" },
};

export function applyProgress(state: ProgressState, e: ProgressEvent): ProgressState {
  return { ...state, [e.step]: { status: e.status, detail: e.detail } };
}

const STEPS: { step: ProgressStep; label: string; done: string }[] = [
  { step: "recall", label: "Recalling similar incidents…", done: "Recalled similar incidents" },
  { step: "feedback", label: "Checking fixes that failed before…", done: "Checked fixes that failed before" },
  { step: "reflect", label: "Reasoning over evidence…", done: "Reasoned over evidence" },
];

/** Live, server-driven progress for the memory-ON pipeline (each step ticks off as Hindsight answers). */
export function MemoryProgress({ progress }: { progress: ProgressState }) {
  const [started] = useState(() => Date.now());
  const [now, setNow] = useState(started);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, []);
  const elapsed = (now - started) / 1000;

  return (
    <div className="rounded-lg border border-accent/30 bg-ink-850 p-4" aria-live="polite">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-accent">Searching PayNest&apos;s incident memory</span>
        <span className="font-mono text-xs tabular-nums text-ink-400">{elapsed.toFixed(1)}s · usually 10–15s</span>
      </div>
      <ol className="space-y-2.5">
        {STEPS.map(({ step, label, done }) => {
          const s = progress[step];
          return (
            <li key={step} className="flex items-start gap-3 text-sm">
              <StepIcon status={s.status} />
              <div className="min-w-0">
                <div className={s.status === "pending" ? "text-ink-400" : s.status === "error" ? "text-red-300" : "text-ink-100"}>
                  {s.status === "done" ? done : label}
                </div>
                {s.detail && <div className="truncate font-mono text-[11px] text-ink-400">{s.detail}</div>}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function StepIcon({ status }: { status: StepState["status"] }) {
  if (status === "done") return <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-emerald-500/20 text-xs text-emerald-300">✓</span>;
  if (status === "error") return <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-red-500/20 text-xs text-red-300">!</span>;
  if (status === "start")
    return <span className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-accent/30 border-t-accent" aria-label="in progress" />;
  return <span className="h-5 w-5 shrink-0 rounded-full border-2 border-ink-700" aria-label="waiting" />;
}
