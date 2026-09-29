/**
 * Creates and configures the Hindsight bank, retains every history incident,
 * and waits (via the Operations API) until processing and consolidation finish.
 *
 * Usage: npm run seed                     # idempotent: skips incidents already retained
 *        npm run seed -- --reset          # delete and recreate the bank first
 *        npm run seed -- --clear-feedback # drop on-call feedback memories (reset the demo)
 */
import "./env";
import { BANK_ID, describeError } from "../lib/hindsight";
import { seedBank } from "../lib/seed";

seedBank(BANK_ID, { reset: process.argv.includes("--reset"), clearFeedback: process.argv.includes("--clear-feedback") }).catch((err) => {
  console.error(`Seed failed: ${describeError(err)}`);
  process.exit(1);
});
