import { morningBriefGenerations } from "@okouai/db/schema/morning-brief-generation";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { executeRawRows } from "../../lib/db-raw-rows";
import { timestampWithoutTimeZone } from "../../lib/time";
import type { Db } from "../external/db";
import type { MorningBriefCollectionOwner } from "./morning-brief-collection-occurrence.service";

const purgedRowSchema = z.object({ purged: z.int().nonnegative() });

/**
 * Purge expired historical source content even when the owner never returns.
 *
 * The Native execution entrypoints are gone, but their accepted body bytes and
 * retained source proof still require bounded cleanup. The content-free row
 * survives the original seven-day replay window, including for an unknown
 * provider outcome; this pass never retries a generation or sends a result.
 *
 * The ordered, limited selection uses `SKIP LOCKED`, so it never queues behind
 * an attempt mid-write and never takes a table-wide lock. Production passes no
 * owner filter; tests may scope the same statement to their own fixtures.
 */
export async function purgeExpiredMorningBriefGenerations(
  db: Pick<Db, "execute">,
  at: Date,
  limit: number,
  owners?: readonly MorningBriefCollectionOwner[],
): Promise<number> {
  if (owners?.length === 0) {
    return 0;
  }
  const cutoff = timestampWithoutTimeZone(at);
  const replayCutoff = timestampWithoutTimeZone(
    new Date(at.getTime() - 7 * 24 * 60 * 60 * 1000),
  );
  const ownerScope =
    owners === undefined
      ? sql.empty()
      : sql` AND (generation.org_id, generation.user_id) IN (${sql.join(
          owners.map((owner) => {
            return sql`(${owner.orgId}, ${owner.userId})`;
          }),
          sql`, `,
        )})`;
  const rows = await executeRawRows(
    db,
    sql`
      WITH candidates AS (
        SELECT
          generation.org_id,
          generation.user_id,
          generation.scheduled_for,
          generation.collection_kind,
          generation.collection_version
        FROM ${morningBriefGenerations} generation
        WHERE generation.expires_at <= ${cutoff}::timestamp${ownerScope}
          AND (
            generation.scheduled_for < ${replayCutoff}::timestamp
            OR (generation.decision = 'deliver'
              AND generation.content_purged_at IS NULL)
            OR (generation.retained_until <= ${cutoff}::timestamp
              AND generation.retained_sources IS NOT NULL)
          )
        ORDER BY generation.expires_at ASC
        LIMIT ${limit}
        FOR UPDATE OF generation SKIP LOCKED
      ),
      sanitized AS (
        UPDATE ${morningBriefGenerations} generation
        SET result_title = NULL,
            result_markdown = NULL,
            result_bytes = NULL,
            content_purged_at = CASE
              WHEN generation.decision = 'deliver'
                THEN COALESCE(generation.content_purged_at, ${cutoff}::timestamp)
              ELSE generation.content_purged_at
            END,
            retained_sources = CASE
              WHEN generation.retained_until <= ${cutoff}::timestamp THEN NULL
              ELSE generation.retained_sources
            END,
            retained_until = CASE
              WHEN generation.retained_until <= ${cutoff}::timestamp THEN NULL
              ELSE generation.retained_until
            END
        FROM candidates
        WHERE generation.org_id = candidates.org_id
          AND generation.user_id = candidates.user_id
          AND generation.scheduled_for = candidates.scheduled_for
          AND generation.collection_kind = candidates.collection_kind
          AND generation.collection_version = candidates.collection_version
          AND generation.scheduled_for >= ${replayCutoff}::timestamp
        RETURNING generation.attempt_id
      ),
      purged AS (
        DELETE FROM ${morningBriefGenerations} generation
        USING candidates
        WHERE generation.org_id = candidates.org_id
          AND generation.user_id = candidates.user_id
          AND generation.scheduled_for = candidates.scheduled_for
          AND generation.collection_kind = candidates.collection_kind
          AND generation.collection_version = candidates.collection_version
          AND generation.scheduled_for < ${replayCutoff}::timestamp
        RETURNING generation.attempt_id
      ),
      affected AS (
        SELECT attempt_id FROM sanitized
        UNION ALL
        SELECT attempt_id FROM purged
      )
      SELECT count(*)::int AS purged FROM affected
    `,
    purgedRowSchema,
  );
  const purged = rows[0]?.purged;
  if (purged === undefined) {
    throw new Error("Morning Brief generation purge returned no summary row");
  }
  return purged;
}
