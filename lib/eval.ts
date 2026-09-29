/** Evaluation: LLM-judge scoring and the eval-results.json shape consumed by /learning. */
import { z } from "zod";
import { describeError, hindsight, retainItems } from "./hindsight";
import { incidentTags, renderIncidentDocument } from "./incidents";
import { chatJson } from "./llm";
import { FAMILIES, FAMILY_LABELS, type DiagnoseResult, type Diagnosis, type Family, type Incident } from "./types";

export interface SideResult {
  topTitle: string;
  topRootCause: string;
  judgedFamilies: string[];
  correct: boolean;
  top3Correct: boolean;
  confidence: number;
  latencyMs: number;
  citedIncidents: string[];
  fixesToAvoid: number;
  model: string;
  judgeReason: string;
  error?: string;
  /** The agent's top recommended action (top hypothesis recommendedFix) and next checks, stored for rescoring. */
  recommendedFix?: string;
  nextChecks?: string[];
  /** Fix-level metrics (cold-start eval): judged against the incident's fixThatWorked and earlier failed fixes. */
  rightFix?: boolean;
  repeatedFailedFix?: boolean;
  repeatedWhich?: string | null;
  fixJudgeReason?: string;
  /** Full structured diagnosis, stored so metrics can be rescored later without re-running. */
  diagnosis?: Diagnosis;
}

export interface EvalRow {
  index: number;
  id: string;
  title: string;
  service: string;
  startedAt: string;
  family: Family;
  off: SideResult;
  on: SideResult;
  cumulative: { off: number; on: number; offAccuracy: number; onAccuracy: number };
}

export interface EvalResults {
  generatedAt: string;
  bankId: string;
  judgeModel: string;
  n: number;
  summary: {
    off: { accuracy: number; top3: number; avgLatencyMs: number; avgCitations: number };
    on: { accuracy: number; top3: number; avgLatencyMs: number; avgCitations: number };
    firstHalf: { off: number; on: number };
    secondHalf: { off: number; on: number };
  };
  rows: EvalRow[];
}

/**
 * Judges run on different Groq models than the memory-OFF diagnosis (gpt-oss-120b): the free
 * tier caps tokens per minute *per model*, so spreading the calls keeps the eval fast. Both
 * sides of every incident are scored by the same judge.
 */
export const FAMILY_JUDGE_MODELS = ["openai/gpt-oss-20b", "qwen/qwen3.8-27b"];
export const FIX_JUDGE_MODELS = ["openai/gpt-oss-20b", "qwen/qwen3.8-27b"];

const JudgeSchema = z.object({
  families: z.array(z.string()).default([]),
  reason: z.string().default(""),
});

/**
 * Ask an LLM judge which failure family each ranked hypothesis describes, then
 * compare with ground truth. The judge sees the hypotheses' text, not their
 * self-reported family label, so neither side can game the score by labelling.
 */
export async function judge(incident: Incident, diagnosis: Diagnosis): Promise<{ families: Family[] | string[]; reason: string; model: string }> {
  const hyps = diagnosis.hypotheses.map((h, i) => `#${i + 1} ${h.title}: ${h.rootCause}`).join("\n");
  const { data, model } = await chatJson(
    JudgeSchema,
    [
      {
        role: "system",
        content: `You are a strict incident-review judge. For each ranked root-cause hypothesis, decide which failure family it describes. Families:\n${FAMILIES.map((f) => `- ${f}: ${FAMILY_LABELS[f]}`).join("\n")}\n- unknown: none of the above / too vague\nClassify by the actual mechanism described, not by keywords. Return JSON {"families": [family per hypothesis in order], "reason": one sentence comparing hypothesis #1 to the ground truth}.`,
      },
      {
        role: "user",
        content: `Ground truth root cause (family ${incident.family}): ${incident.rootCause}\n\nHypotheses:\n${hyps}`,
      },
    ],
    { temperature: 0, maxTokens: 800, models: FAMILY_JUDGE_MODELS },
  );
  const families = data.families.map((f) => (FAMILIES as readonly string[]).includes(f) ? f : "unknown");
  return { families, reason: data.reason, model };
}

export function summarise(rows: EvalRow[]): EvalResults["summary"] {
  const side = (k: "off" | "on") => {
    const n = rows.length || 1;
    return {
      accuracy: rows.filter((r) => r[k].correct).length / n,
      top3: rows.filter((r) => r[k].top3Correct).length / n,
      avgLatencyMs: Math.round(rows.reduce((s, r) => s + r[k].latencyMs, 0) / n),
      avgCitations: rows.reduce((s, r) => s + r[k].citedIncidents.length, 0) / n,
    };
  };
  const half = Math.floor(rows.length / 2);
  const acc = (rs: EvalRow[], k: "off" | "on") => (rs.length ? rs.filter((r) => r[k].correct).length / rs.length : 0);
  return {
    off: side("off"),
    on: side("on"),
    firstHalf: { off: acc(rows.slice(0, half), "off"), on: acc(rows.slice(0, half), "on") },
    secondHalf: { off: acc(rows.slice(half), "off"), on: acc(rows.slice(half), "on") },
  };
}

/** Run one agent on an incident and score its answer with the judge. Never throws. */
export async function scoreSide(
  incident: Incident,
  run: () => Promise<DiagnoseResult>,
  fixContext?: { earlierFailed: { id: string; fix: string }[] },
): Promise<SideResult> {
  try {
    const r = await run();
    const top = r.diagnosis.hypotheses[0]!;
    const nextChecks = r.diagnosis.nextChecks.map((c) => (c.command ? `${c.description}: ${c.command}` : c.description));
    const [j, fx] = await Promise.all([
      judge(incident, r.diagnosis),
      fixContext ? judgeFix(incident, top.recommendedFix, nextChecks, fixContext.earlierFailed) : Promise.resolve(null),
    ]);
    return {
      diagnosis: r.diagnosis,
      recommendedFix: top.recommendedFix,
      nextChecks,
      ...(fx
        ? { rightFix: fx.rightFix, repeatedFailedFix: fx.repeatedFailedFix, repeatedWhich: fx.repeatedWhich, fixJudgeReason: fx.reason }
        : {}),
      topTitle: top.title,
      topRootCause: top.rootCause,
      judgedFamilies: j.families,
      correct: j.families[0] === incident.family,
      top3Correct: j.families.slice(0, 3).includes(incident.family),
      confidence: top.confidence,
      latencyMs: r.latencyMs,
      citedIncidents: r.citedIncidents,
      fixesToAvoid: r.diagnosis.fixesToAvoid.length,
      model: r.model,
      judgeReason: j.reason,
    };
  } catch (err) {
    return {
      topTitle: "(error)",
      topRootCause: "",
      judgedFamilies: [],
      correct: false,
      top3Correct: false,
      confidence: 0,
      latencyMs: 0,
      citedIncidents: [],
      fixesToAvoid: 0,
      model: "",
      judgeReason: "",
      error: describeError(err),
    };
  }
}

/** Retain a resolved incident (the team's post-mortem) into a bank. Returns async operation ids, if any. */
export async function retainResolution(
  incident: Incident,
  bankId: string,
  source: "history" | "eval",
  opts: { async?: boolean } = {},
): Promise<string[]> {
  return retainItems(
    [
      {
        content: renderIncidentDocument(incident),
        timestamp: incident.startedAt,
        context: `PayNest production incident post-mortem for ${incident.service} (${incident.id})`,
        document_id: incident.id,
        tags: incidentTags(incident, source),
        metadata: { incident_id: incident.id, service: incident.service, family: incident.family, resolved_by: incident.resolvedBy },
      },
    ],
    { bankId, async: opts.async ?? true },
  );
}

/** Total memories (world + experience + observation) currently in a bank. */
export async function countMemories(bankId: string): Promise<number> {
  let total = 0;
  for (const type of ["world", "experience", "observation"]) {
    total += (await hindsight().listMemories(bankId, { type, limit: 1 })).total;
  }
  return total;
}

// ------------------------------------------------------------------ cold start

export interface ColdRow extends EvalRow {
  phase: "history" | "eval";
  /** Memories in the bank when this incident was diagnosed (before its own resolution was retained). */
  memoriesBefore: number;
  /** Rolling accuracy over the last `window` incidents, including this one. */
  rolling: { off: number; on: number };
  /** Running totals of the fix-level metrics up to and including this incident. */
  fixCumulative?: { rightFixOff: number; rightFixOn: number; repeatedOff: number; repeatedOn: number };
}

export interface ColdResults {
  generatedAt: string;
  bankId: string;
  judgeModel: string;
  n: number;
  window: number;
  runtimeMinutes: number;
  summary: {
    off: { accuracy: number; rightFix: number; repeatedFailed: number };
    on: { accuracy: number; rightFix: number; repeatedFailed: number };
    /** Accuracy per consecutive block of `window` incidents. */
    blocks: {
      from: number;
      to: number;
      off: number;
      on: number;
      memoriesAtStart: number;
      rightFix?: { off: number; on: number };
      repeatedFailed?: { off: number; on: number };
    }[];
  };
  rows: ColdRow[];
}

export function rollingAccuracy(rows: EvalRow[], window: number, k: "off" | "on"): number {
  const slice = rows.slice(-window);
  return slice.length ? slice.filter((r) => r[k].correct).length / slice.length : 0;
}

export function summariseCold(rows: ColdRow[], window: number): ColdResults["summary"] {
  const acc = (rs: ColdRow[], k: "off" | "on") => (rs.length ? rs.filter((r) => r[k].correct).length / rs.length : 0);
  const rate = (rs: ColdRow[], k: "off" | "on") => (rs.length ? rs.filter((r) => r[k].rightFix).length / rs.length : 0);
  const repeats = (rs: ColdRow[], k: "off" | "on") => rs.filter((r) => r[k].repeatedFailedFix).length;
  const blocks: ColdResults["summary"]["blocks"] = [];
  for (let i = 0; i < rows.length; i += window) {
    const b = rows.slice(i, i + window);
    blocks.push({
      from: i + 1,
      to: i + b.length,
      off: acc(b, "off"),
      on: acc(b, "on"),
      memoriesAtStart: b[0]!.memoriesBefore,
      rightFix: { off: rate(b, "off"), on: rate(b, "on") },
      repeatedFailed: { off: repeats(b, "off"), on: repeats(b, "on") },
    });
  }
  const side = (k: "off" | "on") => ({ accuracy: acc(rows, k), rightFix: rate(rows, k), repeatedFailed: repeats(rows, k) });
  return { off: side("off"), on: side("on"), blocks };
}

// ------------------------------------------------------------------ fix-level judge

const FixJudgeSchema = z.object({
  rightFix: z.boolean(),
  repeatedFailedFix: z.boolean(),
  repeatedWhich: z.string().nullish().transform((v) => (v && v.trim() ? v : null)),
  reason: z.string().default(""),
});

/**
 * Judge an agent's recommended action on PayNest-specific terms:
 *  - rightFix: the TOP recommended action is specifically the fix that worked for
 *    this incident (same concrete action/tool/runbook/route), not a generic equivalent;
 *  - repeatedFailedFix: the recommendation (top fix + next checks, excluding anything
 *    it explicitly warns against) includes a fix that already FAILED in an earlier
 *    incident of the same family.
 */
export async function judgeFix(
  incident: Incident,
  recommendedFix: string,
  nextChecks: string[],
  earlierFailedFixes: { id: string; fix: string }[],
): Promise<{ rightFix: boolean; repeatedFailedFix: boolean; repeatedWhich: string | null; reason: string }> {
  const failed = earlierFailedFixes.length
    ? earlierFailedFixes.map((f) => `- ${f.fix} (failed in ${f.id})`).join("\n")
    : "(none — no earlier incident of this family had a failed fix)";
  const { data } = await chatJson(
    FixJudgeSchema,
    [
      {
        role: "system",
        content: `You are a strict incident-review judge at PayNest. Answer two questions about an on-call agent's recommendation and return JSON {"rightFix": boolean, "repeatedFailedFix": boolean, "repeatedWhich": string|null, "reason": string}.
rightFix = true ONLY if the agent's TOP recommended fix is specifically the ground-truth fix: the same concrete action — same internal tool/command or runbook, or the same specific config change and values, or the same named failover route. A generic equivalent ("reduce pool size", "fail over to a backup", "add a circuit breaker", "revert the config") is NOT enough unless it names the same specific mechanism. Rolling back a deploy is not the same as the ground-truth fix unless the ground truth is a rollback.
repeatedFailedFix = true if the recommendation (top fix or next checks) tells the engineer to DO one of the listed previously-failed fixes (e.g. restart pods, scale up, FLUSHALL, raise a timeout). Mentions that explicitly warn AGAINST a fix do not count. Read-only diagnostic checks do not count. repeatedWhich = the failed fix it repeats, else null.`,
      },
      {
        role: "user",
        content: `Ground-truth fix that worked for ${incident.id}: ${incident.fixThatWorked}

Fixes that FAILED in earlier ${incident.family} incidents:
${failed}

Agent's top recommended fix: ${recommendedFix || "(none given)"}
Agent's next checks / commands:
${nextChecks.length ? nextChecks.map((c) => `- ${c}`).join("\n") : "(none)"}`,
      },
    ],
    { temperature: 0, maxTokens: 700, models: FIX_JUDGE_MODELS },
  );
  return { rightFix: data.rightFix, repeatedFailedFix: data.repeatedFailedFix, repeatedWhich: data.repeatedWhich, reason: data.reason };
}

/** Fixes that failed in incidents of the same family that happened before `incident`. */
export function earlierFailedFixes(incident: Incident, all: Incident[]): { id: string; fix: string }[] {
  return all
    .filter((i) => i.family === incident.family && i.startedAt < incident.startedAt)
    .flatMap((i) => i.fixesThatFailed.map((fix) => ({ id: i.id, fix })));
}
