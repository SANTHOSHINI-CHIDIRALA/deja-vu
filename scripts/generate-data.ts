/**
 * Deterministically generates data/history.json (40 past incidents, Mar–Sep 2026)
 * and data/eval.json (20 held-out incidents, Oct 2026).
 * Usage: npm run gen-data
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { FAMILIES, type Family, type Incident } from "../lib/types";
import { alertOf, buildIncident, EXPERTS, ONCALL, podName, Rng, type Scenario } from "./data/common";
import { FAMILY_GENERATORS } from "./data/families";
import { EVAL_SPECS } from "./data/eval-specs";

const rng = new Rng(20260929);
const OUT = join(process.cwd(), "data");

/** Business events that drive traffic peaks (IST dates). */
const OCCASIONS: { date: string; name: string }[] = [
  { date: "2026-03-01", name: "salary day" },
  { date: "2026-03-04", name: "Holi sale" },
  { date: "2026-04-01", name: "salary day + financial-year rollover" },
  { date: "2026-05-01", name: "salary day" },
  { date: "2026-05-31", name: "IPL final" },
  { date: "2026-06-01", name: "salary day" },
  { date: "2026-07-01", name: "salary day" },
  { date: "2026-08-01", name: "salary day" },
  { date: "2026-08-15", name: "Independence Day sale" },
  { date: "2026-08-26", name: "Onam sale" },
  { date: "2026-09-01", name: "salary day" },
  { date: "2026-09-14", name: "Ganesh Chaturthi sale" },
];

// Family mix for 40 history incidents.
const MIX: Family[] = [
  ...Array<Family>(8).fill("db-pool-exhaustion"),
  ...Array<Family>(7).fill("redis-eviction-storm"),
  ...Array<Family>(7).fill("npci-bank-timeout"),
  ...Array<Family>(6).fill("kafka-consumer-lag"),
  ...Array<Family>(6).fill("tls-secret-expiry"),
  ...Array<Family>(6).fill("bad-config-push"),
];

function istToIso(ist: string): string {
  return new Date(`${ist.replace(" ", "T")}:00+05:30`).toISOString();
}

function randomHistoryTime(family: Family, redisOccasions: string[]): { iso: string; occasion: string | null } {
  if (family === "redis-eviction-storm" && redisOccasions.length) {
    const date = redisOccasions.shift();
    const occ = OCCASIONS.find((o) => o.date === date)!;
    const hh = rng.pick([0, 10, 12, 19, 20, 21]);
    return { iso: istToIso(`${occ.date} ${String(hh).padStart(2, "0")}:${String(rng.int(0, 59)).padStart(2, "0")}`), occasion: occ.name };
  }
  const start = new Date("2026-03-02T00:00:00+05:30").getTime();
  const end = new Date("2026-09-26T00:00:00+05:30").getTime();
  const d = new Date(start + rng.float() * (end - start));
  // Bias to realistic on-call hours: nights and business peaks.
  const hh = rng.pick([1, 2, 2, 3, 4, 10, 11, 13, 17, 19, 21, 22, 23]);
  const day = new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  return { iso: istToIso(`${day} ${String(hh).padStart(2, "0")}:${String(rng.int(0, 59)).padStart(2, "0")}`), occasion: null };
}

function pickResolver(family: Family): string {
  const [a, b] = EXPERTS[family];
  const r = rng.float();
  return r < 0.62 ? a : r < 0.87 ? b : rng.pick(ONCALL);
}

function generateHistory(): Incident[] {
  const redisOccasions = rng.shuffle(OCCASIONS.map((o) => o.date)).slice(0, 7);
  const drafts = rng.shuffle(MIX).map((family) => ({ family, ...randomHistoryTime(family, redisOccasions) }));
  drafts.sort((a, b) => a.iso.localeCompare(b.iso));
  let id = 2201;
  return drafts.map((d) => {
    id += rng.int(2, 6);
    const scenario = FAMILY_GENERATORS[d.family]({ rng, startedAt: d.iso, occasion: d.occasion });
    const resolver = pickResolver(d.family);
    const oncall = rng.chance(0.55) ? resolver : rng.pick(ONCALL);
    const ttr = rng.int(18, 95) + scenario.fixesThatFailed.length * rng.int(8, 20);
    return buildIncident({ id: `INC-${id}`, startedAt: d.iso, family: d.family, scenario, oncall, resolver, ttrMinutes: ttr, rng });
  });
}

function generateEval(lastHistoryId: number): Incident[] {
  let id = lastHistoryId;
  return EVAL_SPECS.map((spec) => {
    id += rng.int(2, 5);
    const startedAt = istToIso(spec.ist);
    const pod = podName(spec.service, rng);
    const logs = spec.logs.map((l, i) => {
      const ts = new Date(new Date(startedAt).getTime() + (i - spec.logs.length) * rng.int(6, 14) * 1000 + rng.int(0, 999)).toISOString();
      return `${ts} ${l.replaceAll("{pod}", pod)}`;
    });
    const scenario: Scenario = {
      title: spec.title,
      service: spec.service,
      severity: spec.severity,
      alert: alertOf({
        alertname: spec.alert.name,
        service: spec.service,
        severity: spec.severity,
        summary: spec.alert.summary,
        description: spec.alert.description,
        expr: spec.alert.expr,
        value: spec.alert.value,
        startsAt: startedAt,
        extraLabels: spec.alert.labels,
      }),
      logs,
      change: {
        kind: spec.change.kind,
        service: spec.change.service,
        description: spec.change.kind === "none" ? "No deploy, config or infra change in the preceding 24h" : spec.change.description,
        sha: spec.change.kind === "none" ? null : rng.hex(7),
        author: spec.change.kind === "none" ? null : (spec.change.author ?? "vault-operator"),
        at: spec.change.kind === "none" ? null : new Date(new Date(startedAt).getTime() - spec.change.minutesBefore * 60_000).toISOString(),
      },
      rootCause: spec.rootCause,
      fixThatWorked: spec.fixThatWorked,
      fixesThatFailed: spec.fixesThatFailed,
      eureka: spec.eureka,
      impact: spec.impact,
      actionItems: ["Link this incident to its family runbook", "Add a regression alert"],
    };
    return buildIncident({ id: `INC-${id}`, startedAt, family: spec.family, scenario, oncall: spec.oncall, resolver: spec.resolver, ttrMinutes: spec.ttr, rng });
  });
}

const history = generateHistory();
const evalSet = generateEval(Number(history.at(-1)!.id.slice(4)));
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "history.json"), JSON.stringify(history, null, 2) + "\n");
writeFileSync(join(OUT, "eval.json"), JSON.stringify(evalSet, null, 2) + "\n");

const count = (xs: Incident[]) => Object.fromEntries(FAMILIES.map((f) => [f, xs.filter((x) => x.family === f).length]));
console.log(`history.json: ${history.length} incidents ${history[0]!.id}..${history.at(-1)!.id}`, count(history));
console.log(`eval.json: ${evalSet.length} incidents ${evalSet[0]!.id}..${evalSet.at(-1)!.id}`, count(evalSet));
const byResolver: Record<string, number> = {};
for (const i of history) byResolver[`${i.resolvedBy} / ${i.family}`] = (byResolver[`${i.resolvedBy} / ${i.family}`] ?? 0) + 1;
console.log(byResolver);
