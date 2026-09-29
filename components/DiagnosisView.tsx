"use client";

import { useState } from "react";
import type { DiagnoseResult, FeedbackOutcome, Hypothesis } from "@/lib/types";
import { ConfidenceBar, FamilyChip, IncidentLink, Linkified, SectionTitle } from "./ui";

export type FeedbackStatus = { state: "idle" } | { state: "sending"; outcome: FeedbackOutcome } | { state: "sent"; outcome: FeedbackOutcome } | { state: "error"; message: string };

interface Props {
  result: DiagnoseResult;
  onOpenIncident?: (id: string) => void;
  onFeedback?: (h: Hypothesis, index: number, outcome: FeedbackOutcome, note: string) => void;
  feedback?: Record<number, FeedbackStatus>;
}

export function DiagnosisView({ result, onOpenIncident, onFeedback, feedback = {} }: Props) {
  const d = result.diagnosis;
  const memory = result.mode === "on";
  return (
    <div className="space-y-5">
      <p className="text-[15px] leading-relaxed text-ink-100">
        <Linkified text={d.summary} onOpen={onOpenIncident} />
      </p>

      <div>
        <SectionTitle>Ranked hypotheses</SectionTitle>
        <ol className="space-y-3">
          {d.hypotheses.map((h, i) => (
            <HypothesisCard
              key={`${i}-${h.title}`}
              h={h}
              index={i}
              memory={memory}
              onOpenIncident={onOpenIncident}
              onFeedback={onFeedback}
              status={feedback[i] ?? { state: "idle" }}
            />
          ))}
        </ol>
      </div>

      {d.fixesToAvoid.length > 0 && (
        <div>
          <SectionTitle>{memory ? "Known-failed fixes — avoid" : "Fixes to avoid"}</SectionTitle>
          <ul className="space-y-2">
            {d.fixesToAvoid.map((f, i) => (
              <li key={i} className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span aria-hidden className="text-red-400">✕</span>
                  <span className="font-medium text-red-200">{f.fix}</span>
                  {f.citedIncidents.map((id) => (
                    <IncidentLink key={id} id={id} onOpen={onOpenIncident} />
                  ))}
                </div>
                {f.reason && (
                  <p className="mt-1 text-ink-300">
                    <Linkified text={f.reason} onOpen={onOpenIncident} />
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {d.nextChecks.length > 0 && (
        <div>
          <SectionTitle>Next checks</SectionTitle>
          <ul className="space-y-2">
            {d.nextChecks.map((c, i) => (
              <li key={i} className="text-sm">
                <div className="flex flex-wrap items-center gap-2 text-ink-100">
                  <span>{c.description}</span>
                  {c.requiresApproval && (
                    <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-300 ring-1 ring-red-500/40">
                      needs human approval
                    </span>
                  )}
                </div>
                {c.command && (
                  <pre className="mt-1 overflow-x-auto rounded-md bg-ink-950 px-3 py-2 font-mono text-xs text-emerald-300 ring-1 ring-ink-700">
                    $ {c.command}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {d.suggestedExpert && (
        <div className="flex items-start gap-3 rounded-lg border border-ink-700 bg-ink-850 p-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent/20 font-semibold text-accent">
            {d.suggestedExpert.name
              .split(" ")
              .map((p) => p[0])
              .join("")
              .slice(0, 2)}
          </span>
          <div className="text-sm">
            <div className="font-medium">Page {d.suggestedExpert.name}</div>
            <div className="text-ink-300">
              <Linkified text={d.suggestedExpert.reason} onOpen={onOpenIncident} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function HypothesisCard({
  h,
  index,
  memory,
  onOpenIncident,
  onFeedback,
  status,
}: {
  h: Hypothesis;
  index: number;
  memory: boolean;
  onOpenIncident?: (id: string) => void;
  onFeedback?: Props["onFeedback"];
  status: FeedbackStatus;
}) {
  const [note, setNote] = useState("");
  const [showNote, setShowNote] = useState(false);
  const busy = status.state === "sending";
  return (
    <li className={`rounded-lg border p-3 ${index === 0 ? "border-accent/50 bg-accent/5" : "border-ink-700 bg-ink-850"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-ink-400">#{index + 1}</span>
        <span className="font-semibold">{h.title}</span>
        <FamilyChip family={h.family} />
        <span className="ml-auto">
          <ConfidenceBar value={h.confidence} tone={index === 0 ? "accent" : "muted"} />
        </span>
      </div>
      <p className="mt-2 text-sm text-ink-300">
        <Linkified text={h.rootCause} onOpen={onOpenIncident} />
      </p>
      {h.evidence && (
        <p className="mt-1 text-xs text-ink-400">
          Evidence: <Linkified text={h.evidence} onOpen={onOpenIncident} />
        </p>
      )}
      {h.recommendedFix && (
        <p className="mt-2 text-sm">
          <span className="text-emerald-400">Fix → </span>
          <Linkified text={h.recommendedFix} onOpen={onOpenIncident} />
        </p>
      )}
      {memory && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-ink-400">Cited:</span>
          {h.citedIncidents.length ? (
            h.citedIncidents.map((id) => <IncidentLink key={id} id={id} onOpen={onOpenIncident} />)
          ) : (
            <span className="text-xs text-ink-400">no past incident</span>
          )}
        </div>
      )}
      {memory && onFeedback && (
        <div className="mt-3 border-t border-ink-700 pt-3">
          {status.state === "sent" ? (
            <p className={`text-sm ${status.outcome === "worked" ? "text-emerald-300" : "text-red-300"}`}>
              {status.outcome === "worked" ? "✓ Recorded: this fix worked." : "✕ Recorded: this suggestion failed."} Retained as an experience memory.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onFeedback(h, index, "worked", note)}
                  className="rounded-md bg-emerald-600/20 px-3 py-1.5 text-sm font-medium text-emerald-200 ring-1 ring-emerald-500/40 hover:bg-emerald-600/30 disabled:opacity-50"
                >
                  {busy && status.outcome === "worked" ? "Saving…" : "✓ Resolved — this fix worked"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onFeedback(h, index, "failed", note)}
                  className="rounded-md bg-red-600/15 px-3 py-1.5 text-sm font-medium text-red-200 ring-1 ring-red-500/40 hover:bg-red-600/25 disabled:opacity-50"
                >
                  {busy && status.outcome === "failed" ? "Saving…" : "✕ This suggestion failed"}
                </button>
                <button type="button" onClick={() => setShowNote((s) => !s)} className="px-2 text-xs text-ink-400 underline-offset-2 hover:underline">
                  {showNote ? "hide note" : "+ note"}
                </button>
              </div>
              {showNote && (
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={500}
                  placeholder="Optional: what actually happened?"
                  className="mt-2 w-full rounded-md border border-ink-700 bg-ink-950 px-3 py-1.5 text-sm outline-none focus:border-accent"
                />
              )}
              {status.state === "error" && <p className="mt-2 text-xs text-red-300">Could not save feedback: {status.message}</p>}
            </>
          )}
        </div>
      )}
    </li>
  );
}

export function DiagnosisSkeleton({ memory, compact = false }: { memory: boolean; compact?: boolean }) {
  return (
    <div className="space-y-4" aria-busy="true">
      {!compact && (
        <p className="font-mono text-xs text-ink-400">{memory ? "recall → reflect over paynest-sre memory bank…" : "asking the LLM with no memory…"}</p>
      )}
      <div className="skeleton h-4 w-11/12" />
      <div className="skeleton h-4 w-9/12" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-2 rounded-lg border border-ink-700 p-3">
          <div className="skeleton h-4 w-1/2" />
          <div className="skeleton h-3 w-full" />
          <div className="skeleton h-3 w-10/12" />
        </div>
      ))}
    </div>
  );
}
