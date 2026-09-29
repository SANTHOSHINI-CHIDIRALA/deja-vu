/**
 * The Déjà Vu agent: diagnose an alert without memory (plain Groq) or with
 * Hindsight memory (recall + reflect), and record on-call feedback as experience.
 */
import { chatJson, type ChatMessage } from "./llm";
import {
  BANK_ID,
  describeError,
  recallMemories,
  reflect,
  retainItems,
} from "./hindsight";
import { extractIncidentIds, renderAlert } from "./incidents";
import {
  DIAGNOSIS_JSON_SCHEMA,
  DiagnosisSchema,
  FAMILIES,
  FAMILY_LABELS,
  type DiagnoseResult,
  type Diagnosis,
  type FeedbackOutcome,
  type IncidentInput,
  type MemoryItem,
  type ProgressEvent,
} from "./types";

const TAXONOMY = FAMILIES.map((f) => `- ${f}: ${FAMILY_LABELS[f]}`).join("\n");

const OUTPUT_CONTRACT = `Return ONLY a JSON object with this shape:
{
  "summary": string (2-3 sentences),
  "hypotheses": [ up to 3, most likely first: {
      "title": string (short human-readable headline), "family": one of the category ids below or "unknown",
      "rootCause": string, "confidence": number 0..1,
      "citedIncidents": string[] (past incident IDs like "INC-1234"; [] if none),
      "evidence": string, "recommendedFix": string } ],
  "nextChecks": [ { "description": string, "command": string ("" if none), "requiresApproval": boolean } ],
  "fixesToAvoid": [ { "fix": string, "reason": string, "citedIncidents": string[] } ],
  "suggestedExpert": { "name": string ("" if unknown), "reason": string }
}
Failure categories:
${TAXONOMY}
Mark any destructive action (DROP, rm -rf, FLUSHALL, offset reset, force failover of primary) with requiresApproval=true.`;

// ------------------------------------------------------------------ memory OFF

export async function diagnoseWithoutMemory(input: IncidentInput): Promise<DiagnoseResult> {
  const t0 = Date.now();
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `You are an experienced on-call SRE for a UPI payments company. You have NO access to past incident history; reason only from the alert in front of you.\n${OUTPUT_CONTRACT}`,
    },
    { role: "user", content: `Diagnose this production alert.\n\n${renderAlert(input)}` },
  ];
  const { data, model } = await chatJson(DiagnosisSchema, messages, { temperature: 0.2, maxTokens: 2500 });
  // Without memory there is nothing real to cite; drop anything hallucinated.
  const diagnosis: Diagnosis = {
    ...data,
    hypotheses: data.hypotheses.map((h) => ({ ...h, citedIncidents: [] })),
    fixesToAvoid: data.fixesToAvoid.map((f) => ({ ...f, citedIncidents: [] })),
  };
  return {
    mode: "off",
    diagnosis,
    memories: [],
    basedOn: [],
    observations: [],
    citedIncidents: [],
    latencyMs: Date.now() - t0,
    model,
    warnings: [],
  };
}

// ------------------------------------------------------------------ memory ON

const isFeedback = (m: MemoryItem) => m.tags.includes("source:feedback") || !!m.documentId?.startsWith("feedback-");

function feedbackSection(feedback: MemoryItem[]): string {
  if (!feedback.length) return "";
  return `

ON-CALL FEEDBACK MEMORIES (authoritative verdicts from engineers on my earlier suggestions for similar alerts):
${feedback.map((f) => `- ${f.text}`).join("\n")}
Apply them: a fix reported as FAILED must appear in fixesToAvoid (cite the alert ID it failed for) and must NOT be recommended again; lower the confidence of the hypothesis it came from, or keep the hypothesis only if the evidence still supports it and recommend a DIFFERENT fix that worked in past incidents. A fix reported as WORKED should be ranked first.`;
}

function reflectQuery(input: IncidentInput, feedback: MemoryItem[] = []): string {
  return `A new production alert just fired at PayNest. Diagnose it using our incident memory.
1. Find the most similar past incidents (same service, same kind of preceding change, same log signatures) and cite their IDs.
2. Rank up to 3 root-cause hypotheses with confidence, most likely first. Give each a short human-readable title (not just the family id). Only use these family ids for "family": ${FAMILIES.join(", ")} (or "unknown").
   Be skeptical of a recent change that merely coincides in time: prefer the hypothesis whose past incidents match this alert's LOG SIGNATURES (error messages, which bank/key prefix/consumer group is affected).
3. For each hypothesis give the fix that worked before, adapted to this alert.
4. List fixes that previously FAILED for similar incidents (including any feedback about suggestions for this same alert) under fixesToAvoid, and do not recommend them.
5. Recommend concrete next checks/commands; flag destructive ones as requiring human approval.
6. Suggest the engineer who resolved the most similar incidents, with a count (e.g. "fixed 3 of these").

${renderAlert(input)}${feedbackSection(feedback)}`;
}

function collectCitations(diagnosis: Diagnosis, text: string): string[] {
  const ids = new Set<string>(extractIncidentIds(text));
  for (const h of diagnosis.hypotheses) h.citedIncidents.forEach((id) => ids.add(id));
  for (const f of diagnosis.fixesToAvoid) f.citedIncidents.forEach((id) => ids.add(id));
  return [...ids].filter((id) => /^INC-\d{4}$/.test(id)).sort();
}

/** Turn reflect's markdown into the Diagnosis shape via Groq (used when structured output is missing). */
async function structureWithGroq(text: string, input: IncidentInput): Promise<{ diagnosis: Diagnosis; model: string }> {
  const { data, model } = await chatJson(DiagnosisSchema, [
    {
      role: "system",
      content: `Convert the SRE memory agent's diagnosis into JSON. Preserve every incident ID, fix, failed fix and expert it mentions; do not invent new facts.\n${OUTPUT_CONTRACT}`,
    },
    { role: "user", content: `Alert:\n${renderAlert(input)}\n\nMemory agent diagnosis:\n${text}` },
  ]);
  return { diagnosis: data, model };
}

/** Last-resort path when reflect is down: Groq reasons over the recalled memories directly. */
async function diagnoseFromRecall(input: IncidentInput, memories: MemoryItem[]): Promise<{ diagnosis: Diagnosis; model: string }> {
  const context = memories
    .slice(0, 40)
    .map((m) => `[${m.type}${m.date ? ` ${m.date.slice(0, 10)}` : ""}${m.documentId ? ` ${m.documentId}` : ""}] ${m.text}`)
    .join("\n");
  const { data, model } = await chatJson(DiagnosisSchema, [
    {
      role: "system",
      content: `You are PayNest's on-call SRE memory. Always cite past incident IDs for any claim. If a fix previously failed for a similar incident, say so explicitly. Never recommend destructive commands without flagging them as requiring human approval.\n${OUTPUT_CONTRACT}`,
    },
    { role: "user", content: `Relevant memories:\n${context}\n\n${reflectQuery(input, memories.filter(isFeedback))}` },
  ]);
  return { diagnosis: data, model };
}

export async function diagnoseWithMemory(
  input: IncidentInput,
  opts: { bankId?: string; onProgress?: (e: ProgressEvent) => void } = {},
): Promise<DiagnoseResult> {
  const bankId = opts.bankId ?? BANK_ID;
  const progress = opts.onProgress ?? (() => {});
  const t0 = Date.now();
  const warnings: string[] = [];
  const alertText = renderAlert(input);
  const service = input.service ?? "";

  // 1. Similar-incident recall (+ service observations) starts immediately; it feeds the inspector.
  progress({ step: "recall", status: "start" });
  const recallP = recallMemories(alertText, { bankId, maxTokens: 3000, budget: "mid" }).then(
    (items) => {
      const incidents = new Set(items.map((m) => m.documentId).filter((d) => d && /^INC-\d{4}$/.test(d)));
      progress({ step: "recall", status: "done", detail: `${items.length} memories from ${incidents.size} past incidents` });
      return items;
    },
    (err) => {
      progress({ step: "recall", status: "error", detail: describeError(err) });
      throw err;
    },
  );
  const obsP = recallMemories(`Recurring failure patterns, fixes that worked, fixes that failed and experts for ${service || "this service"}`, {
    bankId,
    types: ["observation"],
    maxTokens: 1200,
    budget: "low",
  });

  // Mark as handled now; results/errors are collected by allSettled below.
  recallP.catch(() => {});
  obsP.catch(() => {});

  // 2. On-call feedback verdicts (tag-scoped) are fetched first so reflect is told about them explicitly.
  progress({ step: "feedback", status: "start" });
  const feedback = await recallMemories(alertText, {
    bankId,
    types: ["experience"],
    tags: ["source:feedback"],
    tagsMatch: "any_strict",
    maxTokens: 800,
    budget: "low",
  })
    .then((items) => items.filter((m) => !service || m.tags.includes(`service:${service}`) || m.tags.includes(`incident:${input.id}`)).slice(0, 6))
    .catch((err) => {
      warnings.push(`Feedback recall failed: ${describeError(err)}`);
      return [] as MemoryItem[];
    });
  const failedVerdicts = feedback.filter((f) => f.tags.includes("outcome:failed")).length;
  progress({
    step: "feedback",
    status: "done",
    detail: feedback.length
      ? `${feedback.length} on-call verdict${feedback.length === 1 ? "" : "s"} (${failedVerdicts} failed fix${failedVerdicts === 1 ? "" : "es"})`
      : "no on-call verdicts yet",
  });

  // 3. Reflect reasons over the bank with mission, directives and disposition.
  progress({ step: "reflect", status: "start" });
  const reflectP = reflect(reflectQuery(input, feedback), { bankId, budget: "mid", responseSchema: DIAGNOSIS_JSON_SCHEMA }).then(
    (r) => {
      progress({ step: "reflect", status: "done", detail: `used ${r.basedOn.length} facts` });
      return r;
    },
    (err) => {
      progress({ step: "reflect", status: "error", detail: describeError(err) });
      throw err;
    },
  );

  const [recallRes, obsRes, reflectRes] = await Promise.allSettled([recallP, obsP, reflectP]);

  const recalled = recallRes.status === "fulfilled" ? recallRes.value : [];
  const memories = [...feedback, ...recalled.filter((m) => !feedback.some((f) => f.id === m.id))];
  if (recallRes.status === "rejected") warnings.push(`Recall failed: ${describeError(recallRes.reason)}`);
  const observations = obsRes.status === "fulfilled" ? obsRes.value.slice(0, 8) : [];

  let diagnosis: Diagnosis | null = null;
  let model = "hindsight-reflect";
  let reflectText = "";
  let basedOn: MemoryItem[] = [];

  if (reflectRes.status === "fulfilled") {
    reflectText = reflectRes.value.response.text;
    basedOn = reflectRes.value.basedOn;
    const parsed = DiagnosisSchema.safeParse(reflectRes.value.response.structured_output);
    if (parsed.success) diagnosis = parsed.data;
    else {
      warnings.push("Reflect structured output missing/invalid; structured reflect's answer with Groq.");
      try {
        const s = await structureWithGroq(reflectText, input);
        diagnosis = s.diagnosis;
        model = `hindsight-reflect + ${s.model}`;
      } catch (err) {
        warnings.push(`Structuring failed: ${describeError(err)}`);
      }
    }
  } else {
    warnings.push(`Reflect failed (${describeError(reflectRes.reason)}); fell back to recall + Groq.`);
  }

  if (!diagnosis) {
    if (!memories.length) throw new Error(`Memory diagnosis unavailable: ${warnings.join(" ")}`);
    const r = await diagnoseFromRecall(input, memories);
    diagnosis = r.diagnosis;
    model = `hindsight-recall + ${r.model}`;
  }

  return {
    mode: "on",
    diagnosis,
    memories,
    basedOn,
    observations,
    citedIncidents: collectCitations(diagnosis, reflectText),
    latencyMs: Date.now() - t0,
    model,
    warnings,
  };
}

// ------------------------------------------------------------------ feedback

export interface FeedbackInput {
  incidentId: string;
  service: string;
  alertname: string;
  hypothesisTitle: string;
  fix: string;
  outcome: FeedbackOutcome;
  note?: string;
}

/** Retain on-call feedback as a first-person agent experience, synchronously so a re-run sees it. */
export async function recordFeedback(fb: FeedbackInput, opts: { bankId?: string } = {}): Promise<{ documentId: string; text: string }> {
  const now = new Date().toISOString();
  const note = fb.note?.trim() ? ` Engineer's note: "${fb.note.trim()}".` : "";
  const text =
    fb.outcome === "failed"
      ? `Feedback on my suggestion for alert ${fb.incidentId} (${fb.alertname} on ${fb.service}): I suggested "${fb.hypothesisTitle}" with the fix "${fb.fix}". The on-call engineer tried it and reported that this suggestion FAILED — it did not resolve ${fb.incidentId}.${note} For similar ${fb.service} alerts I must not recommend "${fb.fix}" again without saying it failed in ${fb.incidentId}, and I should rank "${fb.hypothesisTitle}" lower.`
      : `Feedback on my suggestion for alert ${fb.incidentId} (${fb.alertname} on ${fb.service}): I suggested "${fb.hypothesisTitle}" with the fix "${fb.fix}". The on-call engineer confirmed this fix WORKED and resolved ${fb.incidentId}.${note} For similar ${fb.service} alerts, "${fb.hypothesisTitle}" is a confirmed root cause and "${fb.fix}" is a proven fix.`;
  const documentId = `feedback-${fb.incidentId}-${Date.now()}`;
  await retainItems(
    [
      {
        content: text,
        timestamp: now,
        context: "Déjà Vu agent's own diagnosis suggestion and the on-call engineer's verdict on it (agent experience)",
        document_id: documentId,
        tags: [`service:${fb.service}`, `incident:${fb.incidentId}`, "source:feedback", `outcome:${fb.outcome}`],
        metadata: { incident_id: fb.incidentId, outcome: fb.outcome },
      },
    ],
    { async: false, bankId: opts.bankId },
  );
  return { documentId, text };
}
