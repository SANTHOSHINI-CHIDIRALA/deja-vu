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
    { temperature: 0, maxTokens: 800 },
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
export async function scoreSide(incident: Incident, run: () => Promise<DiagnoseResult>): Promise<SideResult> {
  try {
    const r = await run();
    const top = r.diagnosis.hypotheses[0]!;
    const j = await judge(incident, r.diagnosis);
    return {
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
}

export interface ColdResults {
  generatedAt: string;
  bankId: string;
  judgeModel: string;
  n: number;
  window: number;
  runtimeMinutes: number;
  summary: {
    off: { accuracy: number };
    on: { accuracy: number };
    /** Accuracy per consecutive block of `window` incidents. */
    blocks: { from: number; to: number; off: number; on: number; memoriesAtStart: number }[];
  };
  rows: ColdRow[];
}

export function rollingAccuracy(rows: EvalRow[], window: number, k: "off" | "on"): number {
  const slice = rows.slice(-window);
  return slice.length ? slice.filter((r) => r[k].correct).length / slice.length : 0;
}

export function summariseCold(rows: ColdRow[], window: number): ColdResults["summary"] {
  const acc = (rs: ColdRow[], k: "off" | "on") => (rs.length ? rs.filter((r) => r[k].correct).length / rs.length : 0);
  const blocks: ColdResults["summary"]["blocks"] = [];
  for (let i = 0; i < rows.length; i += window) {
    const b = rows.slice(i, i + window);
    blocks.push({ from: i + 1, to: i + b.length, off: acc(b, "off"), on: acc(b, "on"), memoriesAtStart: b[0]!.memoriesBefore });
  }
  return { off: { accuracy: acc(rows, "off") }, on: { accuracy: acc(rows, "on") }, blocks };
}
