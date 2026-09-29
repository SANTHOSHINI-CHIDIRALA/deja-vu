import { NextResponse } from "next/server";
import { z } from "zod";
import { recordFeedback } from "@/lib/agent";
import { describeError } from "@/lib/hindsight";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({
  incidentId: z.string().min(1).max(64),
  service: z.string().min(1).max(64),
  alertname: z.string().min(1).max(128),
  hypothesisTitle: z.string().min(1).max(300),
  fix: z.string().max(600).default(""),
  outcome: z.enum(["worked", "failed"]),
  note: z.string().max(600).optional(),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid feedback payload" }, { status: 400 });
  try {
    const res = await recordFeedback(parsed.data);
    return NextResponse.json({ ok: true, ...res });
  } catch (err) {
    console.error("[feedback]", err);
    return NextResponse.json({ error: describeError(err) }, { status: 502 });
  }
}
