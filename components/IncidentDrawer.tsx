"use client";

import { useEffect, useState } from "react";
import type { Incident } from "@/lib/types";
import { FamilyChip, SectionTitle, SeverityBadge, formatIst } from "./ui";

type State = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; incident: Incident };

export function IncidentDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setState({ status: "loading" });
    fetch(`/api/incidents/${encodeURIComponent(id)}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
        if (!cancelled) setState({ status: "ready", incident: body as Incident });
      })
      .catch((e: Error) => !cancelled && setState({ status: "error", message: e.message }));
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!id) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`Incident ${id}`}>
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/60" />
      <div className="relative h-full w-full max-w-2xl overflow-y-auto border-l border-ink-700 bg-ink-900 shadow-2xl">
        <div className="sticky top-0 flex items-center gap-2 border-b border-ink-700 bg-ink-900/95 px-5 py-3 backdrop-blur">
          <span className="font-mono text-mem">{id}</span>
          <span className="text-xs text-ink-400">past incident from memory</span>
          <button type="button" onClick={onClose} className="ml-auto rounded px-2 py-1 text-ink-300 hover:bg-ink-800">
            ✕
          </button>
        </div>
        <div className="space-y-5 p-5">
          {state.status === "loading" && (
            <div className="space-y-3">
              <div className="skeleton h-6 w-2/3" />
              <div className="skeleton h-4 w-full" />
              <div className="skeleton h-24 w-full" />
            </div>
          )}
          {state.status === "error" && <p className="text-sm text-red-300">Couldn&apos;t load {id}: {state.message}</p>}
          {state.status === "ready" && <IncidentDetail inc={state.incident} />}
        </div>
      </div>
    </div>
  );
}

function IncidentDetail({ inc }: { inc: Incident }) {
  const c = inc.precedingChange;
  return (
    <>
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={inc.severity} />
          <span className="font-mono text-xs text-ink-300">{inc.service}</span>
          <FamilyChip family={inc.family} />
        </div>
        <h2 className="mt-2 text-xl font-semibold">{inc.title}</h2>
        <p className="text-sm text-ink-400">
          {formatIst(inc.startedAt)} IST · resolved by <span className="text-ink-100">{inc.resolvedBy}</span> in {inc.ttrMinutes} min
        </p>
      </div>
      <div>
        <SectionTitle>Root cause</SectionTitle>
        <p className="text-sm">{inc.rootCause}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
          <SectionTitle>Fix that worked</SectionTitle>
          <p className="text-sm text-emerald-100">{inc.fixThatWorked}</p>
        </div>
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3">
          <SectionTitle>Fixes that failed</SectionTitle>
          {inc.fixesThatFailed.length ? (
            <ul className="list-inside list-disc text-sm text-red-100">
              {inc.fixesThatFailed.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-400">None recorded.</p>
          )}
        </div>
      </div>
      <div>
        <SectionTitle>Preceding change</SectionTitle>
        <p className="text-sm">
          {c.kind === "none" ? (
            c.description
          ) : (
            <>
              <span className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-xs">{c.kind}</span> {c.description} —{" "}
              <span className="font-mono text-accent">{c.sha}</span> by {c.author}
            </>
          )}
        </p>
      </div>
      <div>
        <SectionTitle>Alert</SectionTitle>
        <pre className="overflow-x-auto rounded-md bg-ink-950 p-3 font-mono text-xs text-ink-300 ring-1 ring-ink-700">
          {`${inc.alert.alertname}: ${inc.alert.annotations.summary}\n${inc.alert.expr}`}
        </pre>
      </div>
      <div>
        <SectionTitle>Logs</SectionTitle>
        <pre className="overflow-x-auto rounded-md bg-ink-950 p-3 font-mono text-[11px] leading-5 text-ink-300 ring-1 ring-ink-700">{inc.logs.join("\n")}</pre>
      </div>
      <div>
        <SectionTitle>On-call timeline</SectionTitle>
        <ul className="space-y-1 font-mono text-xs">
          {inc.timeline.map((t, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-ink-400">{t.at}</span>
              <span className={t.who === "PagerDuty" ? "text-red-300" : "text-accent"}>{t.who}</span>
              <span className="text-ink-100">{t.msg}</span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <SectionTitle>Post-mortem</SectionTitle>
        <p className="text-sm text-ink-300">{inc.postMortem}</p>
      </div>
    </>
  );
}
