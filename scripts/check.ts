/**
 * Connectivity check: verifies Groq and Hindsight Cloud credentials work.
 * Usage: npm run check
 */
import "./env";
import { HindsightClient, createClient, createConfig, sdk } from "@vectorize-io/hindsight-client";

async function checkGroq(): Promise<void> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY is not set");
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      messages: [{ role: "user", content: "Reply with the single word: pong" }],
      max_tokens: 64,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body}`);
  const json = JSON.parse(body) as { choices: { message: { content: string } }[] };
  console.log(`  Groq OK -> "${json.choices[0]?.message.content?.trim()}"`);
}

async function checkHindsight(): Promise<void> {
  const baseUrl = process.env.HINDSIGHT_API_URL;
  const apiKey = process.env.HINDSIGHT_API_KEY;
  if (!baseUrl) throw new Error("HINDSIGHT_API_URL is not set");
  if (!apiKey) throw new Error("HINDSIGHT_API_KEY is not set");
  const client = new HindsightClient({ baseUrl, apiKey });
  const version = await client.getVersion();
  console.log(`  Hindsight OK -> version ${JSON.stringify(version)}`);
  // listBanks is only exposed on the generated sdk, not the wrapper class.
  const raw = createClient(createConfig({ baseUrl, headers: { Authorization: `Bearer ${apiKey}` } }));
  const banks = await sdk.listBanks({ client: raw });
  if (banks.error) throw new Error(`listBanks failed: ${JSON.stringify(banks.error)}`);
  console.log(`  Hindsight banks: ${banks.data?.banks.map((b) => b.bank_id).join(", ") || "(none)"}`);
}

async function main(): Promise<void> {
  let failed = false;
  for (const [name, fn] of [["Groq", checkGroq], ["Hindsight", checkHindsight]] as const) {
    console.log(`Checking ${name}...`);
    try {
      await fn();
    } catch (err) {
      failed = true;
      console.error(`  ${name} FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

void main();
