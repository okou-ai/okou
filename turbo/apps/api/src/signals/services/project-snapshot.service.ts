import { command, computed } from "ccstate";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { sql } from "drizzle-orm";
import { object, number, string } from "zod";
import { projectSnapshotArchiveSchema } from "@okouai/api-contracts/contracts/projects";
import { projectSnapshots } from "@okouai/db/schema/project-snapshot";
import { rawSqlReadDb$, writeDb$ } from "../external/db";
import { generatePresignedGetUrl, putImmutableS3Object } from "../external/s3";
import { env } from "../../lib/env";
import { parseRawRows } from "../../lib/db-raw-rows";
import type { ProjectOwner } from "./project.service";

/** One statement captures metadata and its sequence fence from one MVCC snapshot. */
export const publishProjectSnapshot$ = command(
  async ({ get, set }, owner: ProjectOwner, signal: AbortSignal) => {
    const [snapshot] = parseRawRows(
      projectSnapshotArchiveSchema,
      await get(rawSqlReadDb$).execute(sql`
    SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'createdAt',to_char(p.created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'updatedAt',to_char(p.updated_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY p.created_at,p.id) FROM projects p WHERE p.user_id=${owner.userId} AND p.org_id=${owner.orgId}),'[]'::jsonb) AS projects,
    COALESCE((SELECT id FROM project_events WHERE user_id=${owner.userId} AND org_id=${owner.orgId} ORDER BY seq_id DESC LIMIT 1),(SELECT latest_event_id FROM project_snapshots WHERE user_id=${owner.userId} AND org_id=${owner.orgId})) AS "latestEventId",
    COALESCE((SELECT last_seq_id::float8 FROM project_event_sequences WHERE user_id=${owner.userId} AND org_id=${owner.orgId}),0) AS "latestSeqId"`),
    );
    if (!snapshot) {
      throw new Error("Project snapshot capture is missing");
    }
    const bytes = Buffer.from(JSON.stringify(snapshot));
    const digest = createHash("sha256").update(bytes).digest("hex");
    const scope = createHash("sha256")
      .update(`${owner.userId}\0${owner.orgId}`)
      .digest("hex");
    const key = `project-snapshots/v1/${scope}/${snapshot.latestSeqId}-${digest}-${randomUUID()}.json.gz`;
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    await get(
      putImmutableS3Object(bucket, key, gzipSync(bytes), "application/json", {
        contentEncoding: "gzip",
        signal,
      }),
    );
    signal.throwIfAborted();
    await set(writeDb$)
      .insert(projectSnapshots)
      .values({
        userId: owner.userId,
        orgId: owner.orgId,
        latestEventId: snapshot.latestEventId,
        latestEventSeqId: snapshot.latestSeqId,
        objectKey: key,
        contentDigest: digest,
      })
      .onConflictDoUpdate({
        target: [projectSnapshots.userId, projectSnapshots.orgId],
        set: {
          latestEventId: snapshot.latestEventId,
          latestEventSeqId: snapshot.latestSeqId,
          objectKey: key,
          contentDigest: digest,
          updatedAt: sql`timezone('UTC',now())`,
        },
        setWhere: sql`${projectSnapshots.latestEventSeqId} IS NULL OR ${projectSnapshots.latestEventSeqId} <= ${snapshot.latestSeqId}`,
      });
    signal.throwIfAborted();
    const url = await get(generatePresignedGetUrl(bucket, key));
    signal.throwIfAborted();
    return {
      url,
      latestEventId: snapshot.latestEventId,
      latestSeqId: snapshot.latestSeqId,
    };
  },
);

export function projectCursorExpired(owner: ProjectOwner, since: number) {
  return computed(async (get) => {
    const [row] = parseRawRows(
      object({ oldest: number().nullable(), head: number().nullable() }),
      await get(rawSqlReadDb$).execute(
        sql`SELECT (SELECT min(seq_id)::float8 FROM project_events WHERE user_id=${owner.userId} AND org_id=${owner.orgId}) AS oldest,(SELECT latest_event_seq_id::float8 FROM project_snapshots WHERE user_id=${owner.userId} AND org_id=${owner.orgId}) AS head`,
      ),
    );
    return (
      row !== undefined &&
      row.head !== null &&
      since < row.head &&
      (row.oldest === null || since < row.oldest - 1)
    );
  });
}

/** Reuses the Thread compaction schedule; only covered seven-day-old events expire. */
export const compactProjectSnapshots$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const scopes = parseRawRows(
      object({ userId: string(), orgId: string() }),
      await get(rawSqlReadDb$).execute(
        sql`SELECT s.user_id AS "userId",s.org_id AS "orgId" FROM project_event_sequences s LEFT JOIN project_snapshots p USING(user_id,org_id) WHERE p.latest_event_seq_id IS NULL OR p.latest_event_seq_id<s.last_seq_id ORDER BY s.user_id,s.org_id LIMIT 100`,
      ),
    );
    for (const scope of scopes) {
      await set(publishProjectSnapshot$, scope, signal);
    }
    await set(writeDb$).execute(
      sql`DELETE FROM project_events e USING project_snapshots p WHERE e.user_id=p.user_id AND e.org_id=p.org_id AND e.seq_id<=p.latest_event_seq_id AND e.created_at<timezone('UTC',now())-interval '7 days'`,
    );
  },
);
