/**
 * Groq (OpenAI-compatible) client with timeouts, retries, model fallback,
 * a global spacing gate for free-tier rate limits, and zod-validated JSON output.
 */
import type { z } from "zod";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
export const PRIMARY_MODEL = "openai/gpt-oss-120b";
// The spec'd fallback `qwen/qwen3-32b` is no longer served on Groq (404 model_not_found),
// so we fall back to its successor, then to the small gpt-oss.
export const FALLBACK_MODELS = ["qwen/qwen3.8-27b", "openai/gpt-oss-20b"];

const MIN_GAP_MS = 400; // spacing between calls to stay under free-tier RPM
const MAX_RETRIES = 3; // per-minute limits (TPM/OTPM) clear within ~20s

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  json?: boolean;
  models?: string[];
}

export interface ChatResult {
  content: string;
  model: string;
}

export class LlmError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Serialises call start times so bursts (e.g. eval, parallel UI columns) are spaced out.
let nextSlot = 0;
async function rateGate(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_GAP_MS;
  if (wait > 0) await sleep(wait);
}

function retryDelayMs(res: Response | null, attempt: number): number {
  const header = res?.headers.get("retry-after");
  const secs = header ? Number(header) : NaN;
  if (Number.isFinite(secs)) return Math.min(secs * 1000 + 250, 30_000);
  return 1000 * 2 ** attempt + Math.floor(Math.random() * 400);
}

async function callOnce(model: string, messages: ChatMessage[], opts: ChatOptions): Promise<string> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new LlmError("GROQ_API_KEY is not set");
  await rateGate();
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 2048,
  };
  if (opts.json) body.response_format = { type: "json_object" };
  if (model.startsWith("qwen/")) body.reasoning_effort = "none";
  if (model.startsWith("openai/gpt-oss")) body.reasoning_effort = "low";

  let res: Response | null = null;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      res = await fetch(GROQ_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 45_000),
      });
      if (res.ok) {
        const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        const content = json.choices?.[0]?.message?.content ?? "";
        if (!content.trim()) throw new LlmError(`${model} returned an empty completion`);
        return content;
      }
      const text = await res.text();
      lastErr = new LlmError(`${model} HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
      // JSON mode rejected ("json_validate_failed") — drop it and let zod handle parsing.
      if (res.status === 400 && opts.json && /json/i.test(text)) {
        delete body.response_format;
        continue;
      }
      // A retry-after over a minute (e.g. the daily token quota) won't clear within our retries:
      // give up on this model now so chat() falls back to the next one without waiting.
      const retryAfter = Number(res.headers.get("retry-after"));
      if (res.status === 429 && Number.isFinite(retryAfter) && retryAfter > 60) throw lastErr;
      if (res.status !== 429 && res.status < 500) throw lastErr;
    } catch (err) {
      lastErr = err;
      if (err instanceof LlmError && err.status && err.status !== 429 && err.status < 500) throw err;
      if (err instanceof LlmError && err.status === 429 && Number(res?.headers.get("retry-after")) > 60) throw err;
    }
    if (attempt < MAX_RETRIES) await sleep(retryDelayMs(res, attempt));
  }
  throw lastErr instanceof Error ? lastErr : new LlmError(String(lastErr));
}

/** Chat completion with retries on the primary model, then the fallback model. */
export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
  const models = opts.models ?? [PRIMARY_MODEL, ...FALLBACK_MODELS];
  const errors: string[] = [];
  for (const model of models) {
    try {
      return { content: await callOnce(model, messages, opts), model };
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  throw new LlmError(`All models failed: ${errors.join(" | ")}`);
}

/** Pulls the first JSON object out of a completion (strips <think> blocks and code fences). */
export function extractJson(text: string): unknown {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/```(?:json)?/g, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("No JSON object found in model output");
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

/**
 * Chat that must return JSON matching `schema`. On a parse/validation failure we
 * send one "repair" turn with the error, then give up with an LlmError.
 */
export async function chatJson<T>(
  schema: z.ZodType<T>,
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<{ data: T; model: string }> {
  const first = await chat(messages, { ...opts, json: true });
  const attempt = (raw: string): { ok: true; data: T } | { ok: false; error: string } => {
    try {
      const parsed = schema.safeParse(extractJson(raw));
      if (parsed.success) return { ok: true, data: parsed.data };
      return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
  const r1 = attempt(first.content);
  if (r1.ok) return { data: r1.data, model: first.model };

  const repair = await chat(
    [
      ...messages,
      { role: "assistant", content: first.content.slice(0, 6000) },
      {
        role: "user",
        content: `Your previous reply was not valid JSON for the required schema. Error: ${r1.error}. Reply again with ONLY the corrected JSON object.`,
      },
    ],
    { ...opts, json: true },
  );
  const r2 = attempt(repair.content);
  if (r2.ok) return { data: r2.data, model: repair.model };
  throw new LlmError(`Model output failed validation after repair: ${r2.error}`);
}
