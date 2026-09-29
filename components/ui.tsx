import type { ReactNode } from "react";
import { FAMILY_LABELS, type Family } from "@/lib/types";

export function SeverityBadge({ severity }: { severity?: string }) {
  const cls =
    severity === "SEV1"
      ? "bg-red-500/15 text-red-300 ring-red-500/40"
      : severity === "SEV2"
        ? "bg-orange-500/15 text-orange-300 ring-orange-500/40"
        : "bg-yellow-500/15 text-yellow-200 ring-yellow-500/40";
  return <span className={`rounded px-1.5 py-0.5 font-mono text-[11px] font-bold ring-1 ${cls}`}>{severity ?? "SEV?"}</span>;
}

const TYPE_STYLES: Record<string, string> = {
  world: "bg-sky-500/15 text-sky-300 ring-sky-500/40",
  experience: "bg-fuchsia-500/15 text-fuchsia-300 ring-fuchsia-500/40",
  observation: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/40",
};

export function MemoryTypeBadge({ type }: { type: string }) {
  return (
    <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide ring-1 ${TYPE_STYLES[type] ?? "bg-ink-700 text-ink-300 ring-ink-600"}`}>
      {type}
    </span>
  );
}

export function FamilyChip({ family }: { family: string }) {
  const label = family in FAMILY_LABELS ? FAMILY_LABELS[family as Family] : "Unclassified";
  return <span className="rounded-full bg-ink-800 px-2 py-0.5 text-[11px] text-ink-300 ring-1 ring-ink-700">{label}</span>;
}

export function ConfidenceBar({ value, tone = "accent" }: { value: number; tone?: "accent" | "muted" }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className="flex items-center gap-2" aria-label={`confidence ${pct}%`}>
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-ink-700">
        <div className={`h-full rounded-full ${tone === "accent" ? "bg-accent" : "bg-ink-400"}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="font-mono text-xs tabular-nums text-ink-300">{pct}%</span>
    </div>
  );
}

export function IncidentLink({ id, onOpen }: { id: string; onOpen?: (id: string) => void }) {
  if (!onOpen) return <span className="font-mono text-mem">{id}</span>;
  return (
    <button
      type="button"
      onClick={() => onOpen(id)}
      className="rounded bg-sky-500/10 px-1.5 py-0.5 font-mono text-xs text-mem ring-1 ring-sky-500/30 hover:bg-sky-500/20"
    >
      {id}
    </button>
  );
}

/** Renders text with every INC-#### turned into a clickable incident link. */
export function Linkified({ text, onOpen }: { text: string; onOpen?: (id: string) => void }) {
  const parts = text.split(/(INC-\d{4})/g);
  return (
    <>
      {parts.map((p, i) => (/^INC-\d{4}$/.test(p) ? <IncidentLink key={i} id={p} onOpen={onOpen} /> : <span key={i}>{p}</span>))}
    </>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400">{children}</h3>
      {right}
    </div>
  );
}

export function formatIst(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
