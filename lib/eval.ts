/** Evaluation: LLM-judge scoring and the eval-results.json shape consumed by /learning. */
import { z } from "zod";
import { chatJson } from "./llm";
import { FAMILIES, FAMILY_LABELS, type Diagnosis, type Family, type Incident } from "./types";

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
