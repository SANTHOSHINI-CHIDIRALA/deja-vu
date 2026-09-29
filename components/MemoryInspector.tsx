"use client";

import { useMemo, useState } from "react";
import type { DiagnoseResult, MemoryItem } from "@/lib/types";
import { IncidentLink, Linkified, MemoryTypeBadge, formatIst } from "./ui";

type Tab = "recalled" | "used" | "observations" | "cited";

export function MemoryInspector({ result, onOpenIncident }: { result: DiagnoseResult; onOpenIncident: (id: string) => void }) {
  const [tab, setTab] = useState<Tab>("recalled");
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const m of result.memories) c[m.type] = (c[m.type] ?? 0) + 1;
    return c;
  }, [result.memories]);

  const tabs: { id: Tab; label: string; n: number }[] = [
    { id: "recalled", label: "Recalled", n: result.memories.length },
    { id: "used", label: "Used by reflect", n: result.basedOn.length },
    { id: "observations", label: "Observations", n: result.observations.length },
    { id: "cited", label: "Cited incidents", n: result.citedIncidents.length },
  ];

  return (
    <section className="panel overflow-hidden" aria-label="Memory inspector">
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-700 bg-ink-850 px-4 py-2.5">
        <span className="text-sm font-semibold">Memory Inspector</span>
        <span className="flex gap-1.5 text-[11px] text-ink-400">
          {Object.entries(counts).map(([t, n]) => (
            <span key={t} className="flex items-center gap-1">
              <MemoryTypeBadge type={t} /> {n}
            </span>
          ))}
        </span>
      </div>
      <div className="flex gap-1 overflow-x-auto border-b border-ink-700 px-2" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`whitespace-nowrap border-b-2 px-3 py-2 text-xs ${tab === t.id ? "border-mem text-ink-100" : "border-transparent text-ink-400 hover:text-ink-100"}`}
          >
            {t.label} <span className="font-mono text-ink-400">{t.n}</span>
          </button>
        ))}
      </div>
      <div className="max-h-[520px] overflow-y-auto p-3">
        {tab === "recalled" && <MemoryList items={result.memories} onOpenIncident={onOpenIncident} showScore empty="Recall returned no memories." />}
        {tab === "used" && <MemoryList items={result.basedOn} onOpenIncident={onOpenIncident} empty="Reflect did not report its source facts." />}
        {tab === "observations" && (
          <MemoryList items={result.observations} onOpenIncident={onOpenIncident} showScore empty="No consolidated observations yet for this service." />
        )}
        {tab === "cited" &&
          (result.citedIncidents.length ? (
            <div className="flex flex-wrap gap-2">
              {result.citedIncidents.map((id) => (
                <IncidentLink key={id} id={id} onOpen={onOpenIncident} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-ink-400">No incidents cited.</p>
          ))}
      </div>
    </section>
  );
}

function MemoryList({ items, onOpenIncident, showScore, empty }: { items: MemoryItem[]; onOpenIncident: (id: string) => void; showScore?: boolean; empty: string }) {
  if (!items.length) return <p className="text-sm text-ink-400">{empty}</p>;
  return (
    <ul className="space-y-2">
      {items.map((m) => (
        <MemoryRow key={m.id} m={m} onOpenIncident={onOpenIncident} showScore={showScore} />
      ))}
    </ul>
  );
}

function MemoryRow({ m, onOpenIncident, showScore }: { m: MemoryItem; onOpenIncident: (id: string) => void; showScore?: boolean }) {
  const [open, setOpen] = useState(false);
  const source = m.documentId && /^INC-\d{4}$/.test(m.documentId) ? m.documentId : null;
  const feedback = m.documentId?.startsWith("feedback-") || m.tags.includes("source:feedback");
  return (
    <li className={`rounded-md border p-2.5 ${feedback ? "border-fuchsia-500/40 bg-fuchsia-500/5" : "border-ink-700 bg-ink-850"}`}>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-400">
        <MemoryTypeBadge type={m.type} />
        {feedback && <span className="font-semibold text-fuchsia-300">on-call feedback</span>}
        <span>{m.date ? formatIst(m.date).split(",")[0] : "undated"}</span>
        {source && <IncidentLink id={source} onOpen={onOpenIncident} />}
        {showScore && m.score !== null && (
          <span className="ml-auto flex items-center gap-1.5" title="Hindsight final recall score">
            <span className="h-1 w-12 overflow-hidden rounded-full bg-ink-700">
              <span className="block h-full bg-mem" style={{ width: `${Math.round(Math.min(1, m.score) * 100)}%` }} />
            </span>
            <span className="font-mono tabular-nums">{m.score.toFixed(2)}</span>
          </span>
        )}
      </div>
      <button type="button" onClick={() => setOpen((o) => !o)} className="mt-1 block w-full text-left">
        <p className={`text-sm text-ink-100 ${open ? "" : "line-clamp-3"}`}>
          <Linkified text={m.text} />
        </p>
      </button>
    </li>
  );
}
