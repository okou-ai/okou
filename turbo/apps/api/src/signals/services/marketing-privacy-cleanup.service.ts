import { privacyChoices } from "@okouai/db/schema/privacy-choice";
import { eq, or, sql } from "drizzle-orm";

import { pgBooleanDecoder } from "../../lib/db-structured-result";
import type { ApiDb } from "../../lib/db-types";

// DB/API rollout boundary for #33747: keep deleting retained personal and linked
// browser evidence until contraction. The drop migration takes this same lock
// exclusively, so its commit cannot race the presence check and DELETE. Remove
// this helper with the tables after this API is serving and the rollback floor
// excludes the unconditional cleanup writer.
export async function cleanupRetainedMarketingPrivacy(
  db: ApiDb,
  userId: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock_shared(hashtext('marketing_privacy_storage_retirement'))`,
    );
    signal.throwIfAborted();
    const [state] = await tx
      .select({
        choices: sql`to_regclass('privacy_choices') IS NOT NULL`.mapWith(
          pgBooleanDecoder,
        ),
        revisions:
          sql`to_regclass('privacy_choice_revisions') IS NOT NULL`.mapWith(
            pgBooleanDecoder,
          ),
        receipts:
          sql`to_regclass('marketing_privacy_receipts') IS NOT NULL`.mapWith(
            pgBooleanDecoder,
          ),
      })
      .from(sql`(SELECT 1) AS schema_probe`);
    if (!state) {
      throw new Error("Marketing privacy schema probe returned no row");
    }
    if (state.choices !== state.revisions || state.choices !== state.receipts) {
      throw new Error("Marketing privacy storage is only partially retired");
    }
    if (state.choices) {
      await tx
        .delete(privacyChoices)
        .where(
          or(
            eq(privacyChoices.userId, userId),
            eq(privacyChoices.linkedUserId, userId),
          ),
        );
    }
    signal.throwIfAborted();
  });
}
