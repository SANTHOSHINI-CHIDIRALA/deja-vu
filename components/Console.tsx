"use client";

import { useState } from "react";
import type { DiagnoseResult, FeedbackOutcome, Hypothesis, IncidentInput } from "@/lib/types";
import { DiagnosisSkeleton, DiagnosisView, type FeedbackStatus } from "./DiagnosisView";
import { IncidentDrawer } from "./IncidentDrawer";
import { MemoryInspector } from "./MemoryInspector";
import { SeverityBadge, formatIst } from "./ui";

type Run = { status: "idle" } | { status: "loading" } | { status: "error"; message: string } | { status: "done"; result: DiagnoseResult };

const PASTE_EXAMPLE = `[FIRING] PaymentsAPIHigh5xxRate severity=critical service=payments-api
summary: payments-api 5xx ratio 18% on POST /v1/payments/collect
Recent change: deploy 9f3c2ab "bump gunicorn WORKERS 8 -> 16" by Rohan Gupta, 25 min ago
logs:
ERROR payments-api sqlalchemy.exc.TimeoutError: QueuePool limit of size 20 overflow 10 reached
FATAL postgres-primary: remaining connection slots are reserved for non-replication superuser connections`;

async function diagnose(mode: "off" | "on", body: { incidentId?: string; raw?: string }): Promise<DiagnoseResult> {
  const res = await fetch("/api/diagnose", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, ...body }),
  });
  const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as DiagnoseResult;
}

export function Console({ incidents }: { incidents: IncidentInput[] }) {
  const [source, setSource] = useState<"pick" | "paste">("pick");
  const [selectedId, setSelectedId] = useState(incidents[1]?.id ?? incidents[0]?.id ?? "");
  const [raw, setRaw] = useState(PASTE_EXAMPLE);
  const [off, setOff] = useState<Run>({ status: "idle" });
  const [on, setOn] = useState<Run>({ status: "idle" });
  const [previousOn, setPreviousOn] = useState<DiagnoseResult | null>(null);
  const [feedback, setFeedback] = useState<Record<number, FeedbackStatus>>({});
  const [feedbackGiven, setFeedbackGiven] = useState<{ outcome: FeedbackOutcome; title: string } | null>(null);
  const [mobileTab, setMobileTab] = useState<"off" | "on">("on");
  const [drawerId, setDrawerId] = useState<string | null>(null);

  const selected = incidents.find((i) => i.id === selectedId);
  const request = source === "pick" ? { incidentId: selectedId } : { raw };
  const incidentKey = source === "pick" ? selectedId : "PASTED-ALERT";

  const runOn = async (keepPrevious: boolean) => {
    setPreviousOn(keepPrevious && on.status === "done" ? on.result : null);
    setOn({ status: "loading" });
    setFeedback({});
    try {
      setOn({ status: "done", result: await diagnose("on", request) });
    } catch (e) {
      setOn({ status: "error", message: (e as Error).message });
    }
  };

  const runBoth = async () => {
    setFeedbackGiven(null);
    setOff({ status: "loading" });
    const offP = diagnose("off", request)
      .then((result) => setOff({ status: "done", result }))
      .catch((e: Error) => setOff({ status: "error", message: e.message }));
    await Promise.all([offP, runOn(false)]);
  };

  const sendFeedback = async (h: Hypothesis, index: number, outcome: FeedbackOutcome, note: string) => {
    setFeedback((f) => ({ ...f, [index]: { state: "sending", outcome } }));
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          incidentId: incidentKey,
          service: selected?.service ?? "unknown",
          alertname: selected?.alert?.alertname ?? "pasted alert",
          hypothesisTitle: h.title,
          fix: h.recommendedFix || h.rootCause,
          outcome,
          note: note || undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setFeedback((f) => ({ ...f, [index]: { state: "sent", outcome } }));
      setFeedbackGiven({ outcome, title: h.title });
    } catch (e) {
      setFeedback((f) => ({ ...f, [index]: { state: "error", message: (e as Error).message } }));
    }
  };

  const busy = off.status === "loading" || on.status === "loading";

  return (
    <div className="space-y-5">
      {/* Alert picker */}
      <section className="panel p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex rounded-md bg-ink-800 p-0.5 text-sm" role="tablist" aria-label="Alert source">
            {(["pick", "paste"] as const).map((s) => (
              <button
                key={s}
                role="tab"
                aria-selected={source === s}
                onClick={() => setSource(s)}
                className={`rounded px-3 py-1 ${source === s ? "bg-ink-700 text-ink-100" : "text-ink-400"}`}
              >
                {s === "pick" ? "Incoming alert" : "Paste alert"}
              </button>
            ))}
          </div>
          {source === "pick" && (
            <select
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              className="min-w-0 flex-1 rounded-md border border-ink-700 bg-ink-950 px-3 py-2 text-sm outline-none focus:border-accent"
              aria-label="Choose an incident"
            >
              {incidents.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.id} · {i.severity} · {i.service} — {i.title}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={runBoth}
            disabled={busy || (source === "paste" && !raw.trim())}
            className="w-full rounded-md bg-accent px-5 py-2 font-semibold text-ink-950 hover:brightness-110 disabled:opacity-50 sm:w-auto"
          >
            {busy ? "Diagnosing…" : "Diagnose ▶"}
          </button>
        </div>

        {source === "pick" && selected ? (
          <AlertCard input={selected} />
        ) : (
          <textarea
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            rows={7}
            className="mt-3 w-full rounded-md border border-ink-700 bg-ink-950 p-3 font-mono text-xs text-ink-100 outline-none focus:border-accent"
            aria-label="Paste alert text"
          />
        )}
      </section>

      {/* Mobile tab switcher */}
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-ink-800 p-1 lg:hidden" role="tablist">
        <button role="tab" aria-selected={mobileTab === "off"} onClick={() => setMobileTab("off")} className={`rounded-md py-2 text-sm font-medium ${mobileTab === "off" ? "bg-ink-600 text-ink-100" : "text-ink-400"}`}>
          Without memory
        </button>
        <button role="tab" aria-selected={mobileTab === "on"} onClick={() => setMobileTab("on")} className={`rounded-md py-2 text-sm font-medium ${mobileTab === "on" ? "bg-accent text-ink-950" : "text-ink-400"}`}>
          With Déjà Vu memory
        </button>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* LEFT: no memory */}
        <section className={`panel flex flex-col ${mobileTab === "off" ? "" : "hidden lg:flex"}`}>
          <ColumnHeader title="Without memory" subtitle="Plain LLM call · no incident history" run={off} tone="muted" />
          <div className="p-4">
            <ColumnBody run={off} memory={false} />
          </div>
        </section>

        {/* RIGHT: with memory */}
        <section className={`flex flex-col gap-5 ${mobileTab === "on" ? "" : "hidden lg:flex"}`}>
          <div className="panel flex flex-col ring-1 ring-accent/30">
            <ColumnHeader title="With Déjà Vu memory" subtitle="Hindsight recall + reflect over paynest-sre" run={on} tone="accent" />
            <div className="space-y-4 p-4">
              {feedbackGiven && on.status === "done" && !previousOn && (
                <div className="flex flex-wrap items-center gap-3 rounded-lg border border-fuchsia-500/40 bg-fuchsia-500/10 p-3 text-sm">
                  <span>
                    Feedback on <b>{feedbackGiven.title}</b> retained as an <span className="text-fuchsia-300">experience</span> memory.
                  </span>
                  <button type="button" onClick={() => runOn(true)} className="rounded-md bg-fuchsia-500/80 px-3 py-1.5 font-semibold text-white hover:bg-fuchsia-500">
                    Re-run with updated memory ↻
                  </button>
                </div>
              )}
              {previousOn && on.status === "done" && <WhatChanged before={previousOn} after={on.result} />}
              <ColumnBody run={on} memory onOpenIncident={setDrawerId} onFeedback={sendFeedback} feedback={feedback} />
            </div>
          </div>
          {on.status === "done" && <MemoryInspector result={on.result} onOpenIncident={setDrawerId} />}
        </section>
      </div>

      <IncidentDrawer id={drawerId} onClose={() => setDrawerId(null)} />
    </div>
  );
}

function AlertCard({ input }: { input: IncidentInput }) {
  const c = input.precedingChange;
  return (
    <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_1.3fr]">
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-60" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
          </span>
          <SeverityBadge severity={input.severity} />
          <span className="font-mono text-sm font-semibold">{input.alert?.alertname}</span>
          <span className="font-mono text-xs text-ink-400">{input.service}</span>
        </div>
        <p className="mt-2 text-sm">{input.alert?.annotations.summary}</p>
        <p className="mt-1 text-xs text-ink-400">{input.alert?.annotations.description}</p>
        <p className="mt-2 font-mono text-[11px] text-ink-400">fired {formatIst(input.startedAt)} IST</p>
        {c && (
          <p className="mt-2 text-xs">
            <span className="text-ink-400">Recent change: </span>
            {c.kind === "none" ? (
              <span className="text-ink-300">{c.description}</span>
            ) : (
              <>
                <span className="rounded bg-ink-800 px-1 font-mono">{c.kind}</span> {c.description} · <span className="font-mono text-accent">{c.sha}</span> by {c.author}
              </>
            )}
          </p>
        )}
      </div>
      <pre className="max-h-56 overflow-auto rounded-lg bg-ink-950 p-3 font-mono text-[11px] leading-5 text-ink-300 ring-1 ring-ink-700">
        {(input.logs ?? []).map((l) => colorLog(l)).map((l, i) => (
          <div key={i} className={l.cls}>
            {l.text}
          </div>
        ))}
      </pre>
    </div>
  );
}

function colorLog(text: string): { text: string; cls: string } {
  if (/\b(FATAL|CRITICAL)\b/.test(text)) return { text, cls: "text-red-300" };
  if (/\bERROR\b/.test(text)) return { text, cls: "text-orange-300" };
  if (/\bWARN\b/.test(text)) return { text, cls: "text-yellow-200" };
  return { text, cls: "" };
}

function ColumnHeader({ title, subtitle, run, tone }: { title: string; subtitle: string; run: Run; tone: "muted" | "accent" }) {
  return (
    <div className={`flex items-center gap-3 border-b px-4 py-3 ${tone === "accent" ? "border-accent/30 bg-accent/5" : "border-ink-700 bg-ink-850"}`}>
      <div>
        <h2 className={`font-semibold ${tone === "accent" ? "text-accent" : "text-ink-100"}`}>{title}</h2>
        <p className="text-xs text-ink-400">{subtitle}</p>
      </div>
      {run.status === "done" && (
        <div className="ml-auto text-right font-mono text-[11px] text-ink-400">
          <div>{(run.result.latencyMs / 1000).toFixed(1)}s</div>
          <div className="max-w-40 truncate" title={run.result.model}>
            {run.result.model}
          </div>
        </div>
      )}
    </div>
  );
}

function ColumnBody({
  run,
  memory,
  onOpenIncident,
  onFeedback,
  feedback,
}: {
  run: Run;
  memory: boolean;
  onOpenIncident?: (id: string) => void;
  onFeedback?: (h: Hypothesis, index: number, outcome: FeedbackOutcome, note: string) => void;
  feedback?: Record<number, FeedbackStatus>;
}) {
  if (run.status === "idle")
    return (
      <p className="py-10 text-center text-sm text-ink-400">
        Pick an alert and hit <b className="text-ink-100">Diagnose</b>.
        {memory && <span className="block">Déjà Vu will recall every similar outage PayNest has had.</span>}
      </p>
    );
  if (run.status === "loading") return <DiagnosisSkeleton memory={memory} />;
  if (run.status === "error")
    return (
      <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
        <p className="font-semibold">Diagnosis failed</p>
        <p className="mt-1 break-words font-mono text-xs">{run.message}</p>
        <p className="mt-2 text-ink-300">The LLM or memory service may be rate-limited. Try again in a few seconds.</p>
      </div>
    );
  return (
    <>
      {run.result.warnings.length > 0 && (
        <p className="mb-3 rounded-md bg-yellow-500/10 px-3 py-2 text-xs text-yellow-200 ring-1 ring-yellow-500/30">⚠ {run.result.warnings.join(" ")}</p>
      )}
      <DiagnosisView result={run.result} onOpenIncident={onOpenIncident} onFeedback={onFeedback} feedback={feedback} />
    </>
  );
}

function WhatChanged({ before, after }: { before: DiagnoseResult; after: DiagnoseResult }) {
  const b = before.diagnosis.hypotheses[0];
  const a = after.diagnosis.hypotheses[0];
  const newAvoid = after.diagnosis.fixesToAvoid.filter((f) => !before.diagnosis.fixesToAvoid.some((x) => x.fix === f.fix));
  const changedTop = b && a && b.title !== a.title;
  return (
    <div className="rounded-lg border border-fuchsia-500/40 bg-fuchsia-500/10 p-3 text-sm">
      <p className="font-semibold text-fuchsia-200">What changed after your feedback</p>
      <ul className="mt-1 space-y-1 text-ink-100">
        <li>
          Top hypothesis: <s className="text-ink-400">{b?.title}</s> ({Math.round((b?.confidence ?? 0) * 100)}%) →{" "}
          <b>{a?.title}</b> ({Math.round((a?.confidence ?? 0) * 100)}%){!changedTop && " (unchanged)"}
        </li>
        {b?.recommendedFix !== a?.recommendedFix && (
          <li>
            Recommended fix: <s className="text-ink-400">{b?.recommendedFix}</s> → <b>{a?.recommendedFix}</b>
          </li>
        )}
        {newAvoid.length > 0 && <li>New fixes to avoid: {newAvoid.map((f) => f.fix).join("; ")}</li>}
      </ul>
    </div>
  );
}
