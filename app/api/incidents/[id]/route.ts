import { NextResponse } from "next/server";
import { getIncident } from "@/lib/incidents";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const inc = getIncident(id);
  if (!inc) return NextResponse.json({ error: `Unknown incident ${id}` }, { status: 404 });
  return NextResponse.json(inc);
}
