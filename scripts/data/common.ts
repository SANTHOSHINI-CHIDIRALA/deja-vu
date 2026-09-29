/** Shared helpers for deterministic incident generation. */
import type { Alert, Change, ChatLine, Family, Incident, Service, Severity } from "../../lib/types";

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  hex(n: number): string {
    let s = "";
    for (let i = 0; i < n; i++) s += "0123456789abcdef"[Math.floor(this.next() * 16)];
    return s;
  }
  shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  }
}

export const ONCALL = ["Priya Raman", "Arjun Mehta", "Sneha Kulkarni", "Rahul Verma", "Fatima Sheikh", "Karthik Iyer"] as const;
export const DEVS = [...ONCALL, "Vikram Nair", "Ananya Das", "Rohan Gupta", "Meera Pillai", "Aditya Joshi"] as const;

/** Who tends to resolve which family — drives "Priya fixed 3 of these" expertise. */
export const EXPERTS: Record<Family, [string, string]> = {
  "db-pool-exhaustion": ["Priya Raman", "Karthik Iyer"],
  "redis-eviction-storm": ["Arjun Mehta", "Sneha Kulkarni"],
  "npci-bank-timeout": ["Rahul Verma", "Fatima Sheikh"],
  "kafka-consumer-lag": ["Sneha Kulkarni", "Karthik Iyer"],
  "tls-secret-expiry": ["Fatima Sheikh", "Arjun Mehta"],
  "bad-config-push": ["Karthik Iyer", "Rahul Verma"],
};

export function first(name: string): string {
  return name.split(" ")[0]!;
}

export function addMin(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

/** hh:mm IST for chat timestamps. */
export function istClock(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 330 * 60_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export function logTs(iso: string, offsetSec: number, rng: Rng): string {
  return new Date(new Date(iso).getTime() + offsetSec * 1000 + rng.int(0, 999)).toISOString();
}

export function podName(service: string, rng: Rng): string {
  return `${service}-${rng.hex(9)}-${rng.hex(5).replace(/[0-9]/g, (c) => "bcdfghjklm"[Number(c)]!)}`;
}

export function reqId(rng: Rng): string {
  return rng.hex(12);
}

export function alertOf(params: {
  alertname: string;
  service: string;
  severity: Severity;
  summary: string;
  description: string;
  expr: string;
  value: string;
  startsAt: string;
  extraLabels?: Record<string, string>;
}): Alert {
  const sevLabel = params.severity === "SEV1" ? "critical" : params.severity === "SEV2" ? "high" : "warning";
  return {
    alertname: params.alertname,
    status: "firing",
    labels: {
      alertname: params.alertname,
      service: params.service,
      severity: sevLabel,
      cluster: "prod-ap-south-1",
      namespace: "payments",
      team: "sre",
      ...params.extraLabels,
    },
    annotations: {
      summary: params.summary,
      description: params.description,
      runbook_url: `https://runbooks.paynest.internal/${params.service}/${params.alertname}`,
    },
    expr: params.expr,
    value: params.value,
    startsAt: params.startsAt,
    generatorURL: `https://grafana.paynest.internal/alerting/grafana/${params.alertname.toLowerCase()}/view`,
  };
}

export interface Scenario {
  title: string;
  service: Service;
  severity: Severity;
  alert: Alert;
  logs: string[];
  change: Change;
  rootCause: string;
  fixThatWorked: string;
  fixesThatFailed: { fix: string; why: string }[];
  /** Short line the resolver says when they find the cause. */
  eureka: string;
  impact: string;
  actionItems: string[];
}

export function buildTimeline(params: {
  startedAt: string;
  severity: Severity;
  alert: Alert;
  oncall: string;
  resolver: string;
  scenario: Scenario;
  ttrMinutes: number;
  rng: Rng;
}): ChatLine[] {
  const { startedAt, oncall, resolver, scenario, ttrMinutes, rng } = params;
  const lines: ChatLine[] = [];
  const at = (m: number) => istClock(addMin(startedAt, m));
  lines.push({ at: at(0), who: "PagerDuty", msg: `🚨 [${params.severity}] ${params.alert.alertname} — ${params.alert.annotations.summary}` });
  lines.push({ at: at(rng.int(1, 3)), who: oncall, msg: rng.pick(["ack, looking", "ack. on it", "acked, opening grafana", "on it — war room in #inc-bridge"]) });
  lines.push({ at: at(rng.int(4, 7)), who: oncall, msg: `seeing ${scenario.logs[rng.int(0, Math.min(2, scenario.logs.length - 1))]!.replace(/^\S+\s+/, "").slice(0, 110)}` });
  let t = 8;
  for (const f of scenario.fixesThatFailed) {
    lines.push({ at: at(t), who: oncall, msg: `trying: ${f.fix}` });
    t += rng.int(4, 9);
    lines.push({ at: at(t), who: oncall, msg: `no luck — ${f.why}` });
    t += rng.int(2, 4);
  }
  if (resolver !== oncall) {
    lines.push({ at: at(t), who: oncall, msg: `paging @${first(resolver)}, they've handled this before` });
    t += rng.int(3, 6);
    lines.push({ at: at(t), who: resolver, msg: "joining. checking the last change that went out" });
    t += rng.int(2, 5);
  }
  const fixAt = Math.max(t + 2, ttrMinutes - rng.int(4, 9));
  lines.push({ at: at(Math.min(fixAt - 1, t + 3)), who: resolver, msg: scenario.eureka });
  lines.push({ at: at(fixAt), who: resolver, msg: `applying: ${scenario.fixThatWorked}` });
  lines.push({ at: at(ttrMinutes), who: resolver, msg: "metrics back to baseline, resolving. will write up the PM" });
  return lines;
}

export function buildIncident(params: {
  id: string;
  startedAt: string;
  family: Family;
  scenario: Scenario;
  oncall: string;
  resolver: string;
  ttrMinutes: number;
  rng: Rng;
}): Incident {
  const { scenario: s } = params;
  const failedText = s.fixesThatFailed.length
    ? ` What did NOT work: ${s.fixesThatFailed.map((f) => `${f.fix} (${f.why})`).join("; ")}.`
    : "";
  const changeText =
    s.change.kind === "none"
      ? "No internal change preceded it."
      : `Trigger: ${s.change.description}${s.change.sha ? ` (commit ${s.change.sha} by ${s.change.author})` : ""}.`;
  return {
    id: params.id,
    title: s.title,
    startedAt: params.startedAt,
    service: s.service,
    severity: s.severity,
    alert: s.alert,
    logs: s.logs,
    precedingChange: s.change,
    timeline: buildTimeline({ ...params, severity: s.severity, alert: s.alert }),
    rootCause: s.rootCause,
    family: params.family,
    fixThatWorked: s.fixThatWorked,
    fixesThatFailed: s.fixesThatFailed.map((f) => f.fix),
    resolvedBy: params.resolver,
    ttrMinutes: params.ttrMinutes,
    postMortem: `Impact: ${s.impact} ${changeText} Root cause: ${s.rootCause} Resolution: ${s.fixThatWorked} (by ${params.resolver}, TTR ${params.ttrMinutes} min).${failedText} Action items: ${s.actionItems.join("; ")}.`,
  };
}
