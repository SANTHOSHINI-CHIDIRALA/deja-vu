/**
 * Creates and configures the Hindsight bank, retains every history incident,
 * and waits (via the Operations API) until processing and consolidation finish.
 *
 * Usage: npm run seed            # idempotent: skips incidents already retained
 *        npm run seed -- --reset # delete and recreate the bank first
 */
import "./env";
import { HISTORY, incidentTags, renderIncidentDocument } from "../lib/incidents";
import {
  BANK_ID,
  configureBank,
  deleteBankIfExists,
  describeError,
  getStats,
  hindsight,
  retainItems,
  waitForOperations,
} from "../lib/hindsight";

const BATCH = 8;

async function existingDocumentIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let offset = 0; ; offset += 100) {
    const page = await hindsight().listDocuments(BANK_ID, { limit: 100, offset });
    for (const d of page.items) ids.add(String((d as { id: string }).id));
    if (page.items.length < 100) break;
  }
  return ids;
}

async function main(): Promise<void> {
  const reset = process.argv.includes("--reset");
  if (reset) {
    console.log(`Deleting bank ${BANK_ID}...`);
    await deleteBankIfExists(BANK_ID);
  }
  console.log(`Configuring bank ${BANK_ID} (mission, disposition, directives)...`);
  await configureBank(BANK_ID);

  const existing = await existingDocumentIds();
  const todo = HISTORY.filter((i) => !existing.has(i.id));
  console.log(`${HISTORY.length - todo.length} incidents already retained, ${todo.length} to go.`);

  const opIds: string[] = [];
  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH);
    const ids = await retainItems(
      chunk.map((inc) => ({
        content: renderIncidentDocument(inc),
        timestamp: inc.startedAt,
        context: `PayNest production incident post-mortem for ${inc.service} (${inc.id})`,
        document_id: inc.id,
        tags: incidentTags(inc, "history"),
        metadata: { incident_id: inc.id, service: inc.service, family: inc.family, resolved_by: inc.resolvedBy },
      })),
      { async: true },
    );
    opIds.push(...ids);
    console.log(`  queued ${chunk.map((c) => c.id).join(", ")} -> ops ${ids.join(", ") || "(sync)"}`);
  }

  console.log("Waiting for Hindsight to finish retain + consolidation...");
  const { failed } = await waitForOperations(opIds, { onProgress: (m) => console.log(`  ${m}`) });
  if (failed.length) console.warn(`Some operations failed:\n  ${failed.join("\n  ")}`);

  const stats = await getStats();
  console.log(
    `Done. documents=${stats.total_documents} memories=${stats.total_nodes} by type=${JSON.stringify(stats.nodes_by_fact_type)} observations=${stats.total_observations ?? "?"}`,
  );
}

main().catch((err) => {
  console.error(`Seed failed: ${describeError(err)}`);
  process.exit(1);
});
