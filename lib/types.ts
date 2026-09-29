import { z } from "zod";

export const FAMILIES = [
  "db-pool-exhaustion",
  "redis-eviction-storm",
  "npci-bank-timeout",
  "kafka-consumer-lag",
  "tls-secret-expiry",
  "bad-config-push",
] as const;
export type Family = (typeof FAMILIES)[number];

export const FAMILY_LABELS: Record<Family, string> = {
  "db-pool-exhaustion": "DB connection pool exhaustion",
  "redis-eviction-storm": "Redis eviction storm / cache stampede",
  "npci-bank-timeout": "NPCI / bank partner timeout",
  "kafka-consumer-lag": "Kafka consumer lag after rebalance",
  "tls-secret-expiry": "Expired TLS cert / rotated secret",
  "bad-config-push": "Bad feature flag / config push",
};

export const SERVICES = [
  "payments-api",
  "upi-gateway",
  "ledger-svc",
  "auth-svc",
  "notif-worker",
  "postgres-primary",
  "redis-cache",
  "kafka",
] as const;
export type Service = (typeof SERVICES)[number];

export type Severity = "SEV1" | "SEV2" | "SEV3";

export interface Alert {
  alertname: string;
  status: "firing";
  labels: Record<string, string>;
  annotations: { summary: string; description: string; runbook_url?: string };
  expr: string;
  value: string;
  startsAt: string;
  generatorURL: string;
}

export interface Change {
  kind: "deploy" | "config" | "feature-flag" | "infra" | "secret-rotation" | "none";
  service: string;
  description: string;
  sha: string | null;
  author: string | null;
  at: string | null;
}

export interface ChatLine {
  at: string;
  who: string;
  msg: string;
}

export interface Incident {
  id: string;
  title: string;
  startedAt: string;
  service: Service;
  severity: Severity;
  alert: Alert;
  logs: string[];
  precedingChange: Change;
  timeline: ChatLine[];
  rootCause: string;
  family: Family;
  fixThatWorked: string;
  fixesThatFailed: string[];
  resolvedBy: string;
  ttrMinutes: number;
  postMortem: string;
}

/** What the agent is allowed to see when a new alert fires (no resolution fields). */
export interface IncidentInput {
  id?: string;
  title?: string;
  startedAt?: string;
  service?: string;
  severity?: string;
  alert?: Alert;
  logs?: string[];
  precedingChange?: Change;
  /** Free-form pasted alert text (used instead of structured fields). */
  raw?: string;
}

// ---------- Diagnosis (shared by memory OFF and memory ON) ----------

const familyOrUnknown = z.union([z.enum(FAMILIES), z.literal("unknown")]);

export const HypothesisSchema = z.object({
  title: z.string().min(1),
  family: familyOrUnknown.catch("unknown"),
  rootCause: z.string().min(1),
  confidence: z.coerce.number().min(0).max(1).catch(0.5),
  citedIncidents: z.array(z.string()).default([]),
  evidence: z.string().default(""),
  recommendedFix: z.string().default(""),
});

export const NextCheckSchema = z.object({
  description: z.string().min(1),
  command: z
    .string()
    .nullish()
    .transform((v) => (v && v.trim() ? v : null)),
  requiresApproval: z.boolean().default(false),
});

export const DiagnosisSchema = z.object({
  summary: z.string().min(1),
  hypotheses: z.array(HypothesisSchema).min(1).transform((h) => h.slice(0, 3)),
  nextChecks: z.array(NextCheckSchema).default([]),
  fixesToAvoid: z
    .array(
      z.object({
        fix: z.string(),
        reason: z.string().default(""),
        citedIncidents: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  suggestedExpert: z
    .object({ name: z.string().default(""), reason: z.string().default("") })
    .nullish()
    .transform((v) => (v && v.name.trim() ? v : null)),
});

export type Hypothesis = z.infer<typeof HypothesisSchema>;
export type Diagnosis = z.infer<typeof DiagnosisSchema>;

/**
 * JSON Schema twin of DiagnosisSchema, handed to Hindsight reflect's structured output.
 * Note: reflect rejects union types such as ["string", "null"], so "none" is an empty string.
 */
export const DIAGNOSIS_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["summary", "hypotheses", "nextChecks", "fixesToAvoid", "suggestedExpert"],
  properties: {
    summary: { type: "string", description: "2-3 sentence diagnosis citing past incident IDs." },
    hypotheses: {
      type: "array",
      maxItems: 3,
      description: "Ranked root-cause hypotheses, most likely first.",
      items: {
        type: "object",
        required: ["title", "family", "rootCause", "confidence", "citedIncidents", "evidence", "recommendedFix"],
        properties: {
          title: { type: "string" },
          family: { type: "string", enum: [...FAMILIES, "unknown"] },
          rootCause: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          citedIncidents: { type: "array", items: { type: "string", pattern: "^INC-\\d{4}$" } },
          evidence: { type: "string", description: "Which alert/log/change details match the cited incidents." },
          recommendedFix: { type: "string", description: "The fix that worked for the cited incidents, adapted to this alert." },
        },
      },
    },
    nextChecks: {
      type: "array",
      items: {
        type: "object",
        required: ["description", "command", "requiresApproval"],
        properties: {
          description: { type: "string" },
          command: { type: "string", description: "Exact command/query to run, or empty string." },
          requiresApproval: { type: "boolean" },
        },
      },
    },
    fixesToAvoid: {
      type: "array",
      items: {
        type: "object",
        required: ["fix", "reason", "citedIncidents"],
        properties: {
          fix: { type: "string" },
          reason: { type: "string" },
          citedIncidents: { type: "array", items: { type: "string" } },
        },
      },
    },
    suggestedExpert: {
      type: "object",
      description: "Engineer who resolved the most similar past incidents (name empty if unknown).",
      required: ["name", "reason"],
      properties: { name: { type: "string" }, reason: { type: "string" } },
    },
  },
};

export interface MemoryItem {
  id: string;
  type: "world" | "experience" | "observation" | string;
  text: string;
  date: string | null;
  score: number | null;
  documentId: string | null;
  tags: string[];
}

export interface DiagnoseResult {
  mode: "off" | "on";
  diagnosis: Diagnosis;
  /** Memories surfaced by recall (ON only). */
  memories: MemoryItem[];
  /** Memories reflect reported it actually based the answer on (ON only). */
  basedOn: MemoryItem[];
  observations: MemoryItem[];
  citedIncidents: string[];
  latencyMs: number;
  model: string;
  /** Non-fatal problems (e.g. reflect failed → fell back to recall + Groq). */
  warnings: string[];
}

export type FeedbackOutcome = "worked" | "failed";
