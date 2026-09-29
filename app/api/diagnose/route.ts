import { NextResponse } from "next/server";
import { z } from "zod";
import { diagnoseWithMemory, diagnoseWithoutMemory } from "@/lib/agent";
import { describeError } from "@/lib/hindsight";
import { getIncident, toInput } from "@/lib/incidents";
import type { IncidentInput } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({
  mode: z.enum(["off", "on"]),
  incidentId: z.string().optional(),
  raw: z.string().max(20_000).optional(),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  const { mode, incidentId, raw } = parsed.data;

  let input: IncidentInput;
  if (incidentId) {
    const inc = getIncident(incidentId);
    if (!inc) return NextResponse.json({ error: `Unknown incident ${incidentId}` }, { status: 404 });
    input = toInput(inc);
  } else if (raw?.trim()) {
    const service = raw.match(/\b(payments-api|upi-gateway|ledger-svc|auth-svc|notif-worker|postgres-primary|redis-cache|kafka)\b/)?.[1];
    input = { raw, service, id: "PASTED-ALERT" };
  } else {
    return NextResponse.json({ error: "Provide incidentId or raw alert text" }, { status: 400 });
  }

  try {
    const result = mode === "on" ? await diagnoseWithMemory(input) : await diagnoseWithoutMemory(input);
    return NextResponse.json(result);
  } catch (err) {
    console.error(`[diagnose:${mode}]`, err);
    return NextResponse.json({ error: describeError(err) }, { status: 502 });
  }
}
