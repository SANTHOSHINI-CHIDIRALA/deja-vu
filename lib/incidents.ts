/** Loading incident data and rendering it for memory documents and prompts. */
import historyJson from "../data/history.json";
import evalJson from "../data/eval.json";
import type { Incident, IncidentInput } from "./types";

export const HISTORY = historyJson as unknown as Incident[];
export const EVAL = evalJson as unknown as Incident[];

const BY_ID = new Map<string, Incident>([...HISTORY, ...EVAL].map((i) => [i.id, i]));

export function getIncident(id: string): Incident | undefined {
  return BY_ID.get(id);
}

export function formatIst(iso: string): string {
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

/** Strip resolution fields: this is everything on-call sees when the alert fires. */
export function toInput(i: Incident): IncidentInput {
  return {
    id: i.id,
    title: i.title,
    startedAt: i.startedAt,
    service: i.service,
    severity: i.severity,
    alert: i.alert,
    logs: i.logs,
    precedingChange: i.precedingChange,
  };
}

/** The live alert as text, used for both the memory-OFF prompt and the memory-ON recall/reflect query. */
export function renderAlert(input: IncidentInput): string {
  if (input.raw) return input.raw.trim();
  const lines: string[] = [];
  lines.push(`NEW ALERT${input.id ? ` ${input.id}` : ""} — ${input.severity ?? "SEV?"} on ${input.service ?? "unknown service"}${input.startedAt ? ` at ${formatIst(input.startedAt)} IST` : ""}`);
  if (input.alert) {
    lines.push(`Alert: ${input.alert.alertname} — ${input.alert.annotations.summary}`);
    lines.push(`Description: ${input.alert.annotations.description}`);
    lines.push(`Expr: ${input.alert.expr} (value ${input.alert.value})`);
  }
  const c = input.precedingChange;
  if (c) {
    lines.push(
      c.kind === "none"
        ? `Recent changes: ${c.description}`
        : `Recent change: [${c.kind}] ${c.description} — commit ${c.sha} by ${c.author}${c.at ? ` at ${formatIst(c.at)} IST` : ""}`,
    );
  }
  if (input.logs?.length) {
    lines.push("Logs:");
    for (const l of input.logs) lines.push(`  ${l}`);
  }
  return lines.join("\n");
}

/** Full post-incident write-up retained into Hindsight as one document per incident. */
export function renderIncidentDocument(i: Incident): string {
  const c = i.precedingChange;
  return [
    `Incident ${i.id}: ${i.title}`,
    `Date: ${formatIst(i.startedAt)} IST. Service: ${i.service}. Severity: ${i.severity}.`,
    `Alert: ${i.alert.alertname} — ${i.alert.annotations.summary}. ${i.alert.annotations.description}`,
    c.kind === "none"
      ? `Preceding change: none (${c.description}).`
      : `Preceding change: [${c.kind}] ${c.description} — commit ${c.sha} by ${c.author}.`,
    `Key log lines:\n${i.logs.slice(0, 5).map((l) => `  ${l}`).join("\n")}`,
    `Root cause (${i.family}): ${i.rootCause}`,
    `Fix that worked: ${i.fixThatWorked}.`,
    i.fixesThatFailed.length
      ? `Fixes that were tried and FAILED in ${i.id}: ${i.fixesThatFailed.join("; ")}.`
      : `No failed fix attempts in ${i.id}.`,
    `Resolved by ${i.resolvedBy} in ${i.ttrMinutes} minutes.`,
    `On-call chat:\n${i.timeline.map((t) => `  [${t.at}] ${t.who}: ${t.msg}`).join("\n")}`,
    `Post-mortem: ${i.postMortem}`,
  ].join("\n");
}

export function incidentTags(i: Pick<Incident, "id" | "service" | "family">, source: "history" | "eval"): string[] {
  return [`service:${i.service}`, `family:${i.family}`, `incident:${i.id}`, `source:${source}`];
}

export function extractIncidentIds(text: string): string[] {
  return [...new Set(text.match(/INC-\d{4}/g) ?? [])];
}
