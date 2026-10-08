import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "../lib/db";

/**
 * No product API can fail a cache insert after a particular pending commit.
 * This real database fault affects only the test's exact cache key and org.
 * A premature write succeeds, so the route test can detect that ordering bug.
 */
export async function rejectPresignedCacheWriteAfterPendingFixture(
  cacheKey: string,
  signal: AbortSignal,
): Promise<() => Promise<void>> {
  if (!/^[a-f0-9]{64}$/.test(cacheKey)) {
    throw new Error("Expected an exact SHA-256 cache key");
  }
  // A SHA-256 hex key exceeds PostgreSQL's identifier limit by one byte.
  // Base64 preserves the full key in TG_NAME without SQL literal interpolation.
  const triggerName = Buffer.from(cacheKey, "hex").toString("base64");
  const name = `test_cache_failure_${randomUUID().replaceAll("-", "")}`;
  await db().transaction(async (tx) => {
    await tx.execute(sql`
      CREATE FUNCTION ${sql.identifier(name)}() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.cache_key = encode(decode(TG_NAME, 'base64'), 'hex') AND EXISTS (
          SELECT 1 FROM agent_runs AS run
          INNER JOIN runner_job_queue AS job ON job.run_id = run.id
          WHERE run.org_id = NEW.resolved_org_id AND run.status = 'pending'
        ) THEN
          RAISE EXCEPTION 'Test post-commit cache write failed'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    signal.throwIfAborted();
    await tx.execute(sql`
      CREATE TRIGGER ${sql.identifier(triggerName)}
      BEFORE INSERT ON system_storage_presigned_url_cache
      FOR EACH ROW EXECUTE FUNCTION ${sql.identifier(name)}()
    `);
    signal.throwIfAborted();
  });
  return async () => {
    await db().transaction(async (tx) => {
      await tx.execute(sql`
        DROP TRIGGER ${sql.identifier(triggerName)}
        ON system_storage_presigned_url_cache
      `);
      await tx.execute(sql`DROP FUNCTION ${sql.identifier(name)}()`);
    });
  };
}
