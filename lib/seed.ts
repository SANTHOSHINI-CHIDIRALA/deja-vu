/** Seeding a bank with PayNest incident history (shared by `npm run seed` and `npm run eval`). */
import { HISTORY, incidentTags, renderIncidentDocument } from "./incidents";
import {
  configureBank,
  deleteBankIfExists,
  deleteFeedbackDocuments,
  hindsight,
  listDocumentIds,
  retainItems,
  waitForOperations,
} from "./hindsight";

const BATCH = 8;

export async function seedBank(
  bankId: string,
  opts: { reset?: boolean; clearFeedback?: boolean; log?: (msg: string) => void } = {},
): Promise<void> {
  const log = opts.log ?? console.log;
  if (opts.reset) {
    log(`Deleting bank ${bankId}...`);
    await deleteBankIfExists(bankId);
  }
  log(`Configuring bank ${bankId} (mission, disposition, directives)...`);
  await configureBank(bankId);

  if (opts.clearFeedback) log(`Removed ${await deleteFeedbackDocuments(bankId)} feedback documents.`);

  const existing = new Set(await listDocumentIds(bankId));
  const todo = HISTORY.filter((i) => !existing.has(i.id));
  log(`${HISTORY.length - todo.length} incidents already retained, ${todo.length} to go.`);

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
      { async: true, bankId },
    );
    opIds.push(...ids);
    log(`  queued ${chunk.map((c) => c.id).join(", ")}`);
  }

  log("Waiting for Hindsight to finish retain + consolidation...");
  const { failed } = await waitForOperations(opIds, { bankId, onProgress: (m) => log(`  ${m}`) });
  if (failed.length) log(`Some operations failed:\n  ${failed.join("\n  ")}`);

  const docs = await listDocumentIds(bankId);
  const byType: Record<string, number> = {};
  for (const type of ["world", "experience", "observation"]) {
    byType[type] = (await hindsight().listMemories(bankId, { type, limit: 1 })).total;
  }
  log(`Done. documents=${docs.length} memories by type=${JSON.stringify(byType)}`);
}
