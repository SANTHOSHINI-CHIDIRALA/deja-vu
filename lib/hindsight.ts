/**
 * Thin, typed wrapper around the official Hindsight TypeScript SDK
 * (@vectorize-io/hindsight-client). All bank setup, retain, recall, reflect and
 * operation-polling for Déjà Vu goes through here.
 */
import {
  HindsightClient,
  HindsightError,
  createClient,
  createConfig,
  sdk,
  type RecallResult,
  type ReflectResponse,
  type MemoryItemInput,
} from "@vectorize-io/hindsight-client";
import type { MemoryItem } from "./types";

export const BANK_ID = process.env.HINDSIGHT_BANK_ID || "paynest-sre";

export const MISSION =
  "I am the on-call SRE memory for PayNest's payments platform. I prioritise past incidents, root causes, what fixed them, what did not, and who fixed them.";

export const DIRECTIVES: { name: string; content: string }[] = [
  { name: "cite-incidents", content: "Always cite past incident IDs for any claim." },
  {
    name: "no-destructive-without-approval",
    content:
      "Never recommend destructive commands (DROP, rm -rf, force failover of primary) without flagging them as requiring human approval.",
  },
  {
    name: "surface-failed-fixes",
    content: "If a fix previously failed for a similar incident, say so explicitly.",
  },
];

export const DISPOSITION = { skepticism: 5, literalism: 5, empathy: 3 } as const;

const RETAIN_MISSION =
  "Extract incident facts: incident ID, date, affected service, symptoms, alert names, the preceding deploy/config change (commit sha and author), the root cause, the fix that worked, every fix that was tried and FAILED, who resolved it, and time to resolve. Keep incident IDs verbatim. For on-call feedback on the agent's own suggestions, always keep the verdict (WORKED or FAILED), the exact fix and the incident ID in the same fact.";

const OBSERVATIONS_MISSION =
  "Consolidate recurring failure patterns per service: which changes tend to trigger which failures, which fixes reliably work, which fixes repeatedly fail, and which engineers resolve which kinds of incidents. Always keep the incident IDs that support each pattern.";

function config(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.HINDSIGHT_API_URL;
  const apiKey = process.env.HINDSIGHT_API_KEY;
  if (!baseUrl || !apiKey) throw new Error("HINDSIGHT_API_URL and HINDSIGHT_API_KEY must be set");
  return { baseUrl, apiKey };
}

let cached: HindsightClient | null = null;
export function hindsight(): HindsightClient {
  if (!cached) cached = new HindsightClient({ ...config(), userAgent: "deja-vu/0.1" });
  return cached;
}

/** Raw generated-SDK client, for endpoints the wrapper class doesn't expose (banks, stats, operations). */
function rawClient() {
  const { baseUrl, apiKey } = config();
  return createClient(createConfig({ baseUrl, headers: { Authorization: `Bearer ${apiKey}` } }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- bank setup

export async function bankExists(bankId = BANK_ID): Promise<boolean> {
  const res = await sdk.listBanks({ client: rawClient() });
  if (res.error) throw new Error(`listBanks failed: ${JSON.stringify(res.error)}`);
  return (res.data?.banks ?? []).some((b) => b.bank_id === bankId);
}

export async function deleteBankIfExists(bankId = BANK_ID): Promise<void> {
  if (await bankExists(bankId)) await hindsight().deleteBank(bankId);
}

/** Create (or update) the bank with mission, disposition and directives. Idempotent. */
export async function configureBank(bankId = BANK_ID): Promise<void> {
  const client = hindsight();
  await client.createBank(bankId, {
    name: "PayNest SRE memory",
    reflectMission: MISSION,
    retainMission: RETAIN_MISSION,
    observationsMission: OBSERVATIONS_MISSION,
    enableObservations: true,
  });
  await client.updateBankConfig(bankId, {
    dispositionSkepticism: DISPOSITION.skepticism,
    dispositionLiteralism: DISPOSITION.literalism,
    dispositionEmpathy: DISPOSITION.empathy,
  });
  const existing = await client.listDirectives(bankId, { limit: 100 });
  const names = new Set(existing.items.map((d) => d.name));
  for (const d of DIRECTIVES) {
    if (!names.has(d.name)) await client.createDirective(bankId, d.name, d.content, { priority: 10 });
  }
}

// ---------------------------------------------------------------- retain

export async function retainItems(
  items: MemoryItemInput[],
  opts: { async?: boolean; bankId?: string } = {},
): Promise<string[]> {
  const res = await hindsight().retainBatch(opts.bankId ?? BANK_ID, items, { async: opts.async ?? false });
  return [res.operation_id, ...(res.operation_ids ?? [])].filter((x): x is string => !!x);
}

// ---------------------------------------------------------------- operations

export async function getStats(bankId = BANK_ID) {
  const res = await sdk.getAgentStats({ client: rawClient(), path: { bank_id: bankId } });
  if (res.error || !res.data) throw new Error(`stats failed: ${JSON.stringify(res.error)}`);
  return res.data;
}

/** Count of pending + processing operations on a bank, from the Operations API. */
async function activeOperations(bankId: string): Promise<number> {
  const client = rawClient();
  let total = 0;
  for (const status of ["pending", "processing"]) {
    const res = await sdk.listOperations({ client, path: { bank_id: bankId }, query: { status, limit: 1 } });
    if (res.error || !res.data) throw new Error(`listOperations failed: ${JSON.stringify(res.error)}`);
    total += res.data.total;
  }
  return total;
}

/**
 * Poll the Operations API until the given operations and every other pending
 * operation on the bank (e.g. consolidation) reach a terminal state.
 * (We don't rely on /stats: it can lag badly after a bank is deleted and recreated.)
 */
export async function waitForOperations(
  operationIds: string[] = [],
  opts: { bankId?: string; timeoutMs?: number; onProgress?: (msg: string) => void } = {},
): Promise<{ failed: string[] }> {
  const bankId = opts.bankId ?? BANK_ID;
  const deadline = Date.now() + (opts.timeoutMs ?? 20 * 60_000);
  const client = rawClient();
  const failed: string[] = [];
  const pending = new Set(operationIds);
  await sleep(1500); // let freshly queued work register
  while (Date.now() < deadline) {
    for (const id of [...pending]) {
      const res = await sdk.getOperationStatus({ client, path: { bank_id: bankId, operation_id: id } });
      const status = res.data?.status;
      if (status === "completed" || status === "not_found") pending.delete(id);
      else if (status === "failed" || status === "cancelled") {
        pending.delete(id);
        failed.push(`${id}: ${res.data?.error_message ?? status}`);
      }
    }
    const active = await activeOperations(bankId);
    opts.onProgress?.(`tracked=${pending.size} active_bank_operations=${active}`);
    if (pending.size === 0 && active === 0) return { failed };
    await sleep(3000);
  }
  throw new Error(`Timed out waiting for Hindsight operations on ${bankId}`);
}

// ---------------------------------------------------------------- recall / reflect

function toMemoryItem(r: RecallResult): MemoryItem {
  return {
    id: r.id,
    type: r.type ?? "world",
    text: r.text,
    date: r.occurred_start ?? r.mentioned_at ?? null,
    score: r.scores?.final ?? null,
    documentId: r.document_id ?? null,
    tags: r.tags ?? [],
  };
}

export async function recallMemories(
  query: string,
  opts: {
    types?: string[];
    maxTokens?: number;
    tags?: string[];
    tagsMatch?: "any" | "all" | "any_strict" | "all_strict";
    bankId?: string;
    budget?: "low" | "mid" | "high";
  } = {},
): Promise<MemoryItem[]> {
  const res = await hindsight().recall(opts.bankId ?? BANK_ID, query, {
    types: opts.types ?? ["world", "experience", "observation"],
    maxTokens: opts.maxTokens ?? 3000,
    budget: opts.budget ?? "mid",
    tags: opts.tags,
    tagsMatch: opts.tags ? (opts.tagsMatch ?? "any") : undefined,
  });
  return res.results.map(toMemoryItem);
}

export async function reflect(
  query: string,
  opts: { context?: string; responseSchema?: Record<string, unknown>; bankId?: string; budget?: "low" | "mid" | "high" } = {},
): Promise<{ response: ReflectResponse; basedOn: MemoryItem[] }> {
  const response = await hindsight().reflect(opts.bankId ?? BANK_ID, query, {
    context: opts.context,
    budget: opts.budget ?? "mid",
    responseSchema: opts.responseSchema,
    includeFacts: true,
  });
  const basedOn: MemoryItem[] = (response.based_on?.memories ?? []).map((m, i) => ({
    id: m.id ?? `fact-${i}`,
    type: m.type ?? "world",
    text: m.text,
    date: m.occurred_start ?? null,
    score: null,
    documentId: null,
    tags: [],
  }));
  return { response, basedOn };
}

export function describeError(err: unknown): string {
  if (err instanceof HindsightError) return `Hindsight ${err.statusCode ?? ""} ${err.message}`.trim();
  return err instanceof Error ? err.message : String(err);
}

export async function listDocumentIds(bankId = BANK_ID): Promise<string[]> {
  const ids: string[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await hindsight().listDocuments(bankId, { limit: 100, offset });
    ids.push(...page.items.map((d) => String((d as { id: string }).id)));
    if (page.items.length < 100) return ids;
  }
}

/** Remove on-call feedback documents (and their memories), e.g. to reset the demo. */
export async function deleteFeedbackDocuments(bankId = BANK_ID): Promise<number> {
  const ids = (await listDocumentIds(bankId)).filter((id) => id.startsWith("feedback-"));
  for (const id of ids) await hindsight().deleteDocument(bankId, id);
  return ids.length;
}
