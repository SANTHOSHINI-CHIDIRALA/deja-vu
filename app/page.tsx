import { Console } from "@/components/Console";
import { EVAL, HISTORY, toInput } from "@/lib/incidents";

export default function Home() {
  const incidents = EVAL.map(toInput);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Incident Console</h1>
          <p className="text-sm text-ink-400">
            PayNest · UPI payments · ~2M txns/day. Same alert, two agents: one forgets, one remembers {HISTORY.length} past outages.
          </p>
        </div>
      </div>
      <Console incidents={incidents} />
    </div>
  );
}
