import {
  memberMemories,
  memoryVersions,
  memoryVersionLineage,
} from "@okouai/db/schema/member-memory";
import type { FileEntryWithHash } from "@okouai/api-contracts/contracts/storage-content-hash";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { and, eq, getTableColumns, is, SQL, sql } from "drizzle-orm";
import {
  PgDialect,
  QueryBuilder,
  type AnyPgColumn,
  type PgTable,
} from "drizzle-orm/pg-core";
import {
  array,
  boolean,
  date,
  int,
  object,
  string,
  union,
  type output,
} from "zod";

import {
  pgInt8ToSafeIntegerSchema,
  pgTimestampWithoutTimezoneToDateSchema,
} from "../../lib/db-raw-rows";
import { nullableDriverValueDecoder } from "../../lib/db-structured-result";
import { conflict, notFound } from "../../lib/error";
import { MEMORY_ARTIFACT_NAME } from "@okouai/core/storage-names";
import type {
  CommitStorageForStorageInput,
  CommitStorageResponse,
  StorageRow,
  StorageVersionRow,
  VerifiedStorageCommit,
} from "./storage-write-protocol";

const ACTIVE_SANDBOX_STORAGE_RUN_STATUSES = ["pending", "running"] as const;
const integerRow = union([int(), pgInt8ToSafeIntegerSchema]);
const dateRow = union([date(), pgTimestampWithoutTimezoneToDateSchema]);
const mountRow = object({
  storageId: string(),
  orgId: string(),
  userId: string(),
  name: string(),
  writeback: boolean().optional(),
});
const runRow = object({
  status: string(),
  storageMounts: array(mountRow).nullable(),
});
const storageRow = object({
  id: string(),
  userId: string(),
  name: string(),
  orgId: string(),
  s3Prefix: string(),
  size: integerRow,
  fileCount: int(),
  headVersionId: string().nullable(),
  createdAt: dateRow,
  updatedAt: dateRow,
});
const versionRow = object({
  id: string(),
  storageId: string(),
  s3Key: string(),
  size: integerRow,
  archiveSize: integerRow,
  fileCount: int(),
  message: string().nullable(),
  createdBy: string(),
  createdAt: dateRow,
});
export const storageCommitPublicationRow = object({
  run: runRow.nullable(),
  storage: storageRow.nullable(),
  version: versionRow.nullable(),
  admitted: boolean(),
  inserted: boolean(),
  memoryConflict: boolean(),
});

function memoryParentVersion(input: CommitStorageForStorageInput) {
  return input.parentVersionId === undefined
    ? sql`(SELECT value->>'version' FROM commit_mount)`
    : sql`${input.parentVersionId}`;
}

function memoryPublicationAllowed(input: CommitStorageForStorageInput) {
  const parent = memoryParentVersion(input);
  return sql`(s."headVersionId" IS NOT DISTINCT FROM ${parent}
    OR s."headVersionId" = ${input.versionId}
    OR ${input.versionId} IS NOT DISTINCT FROM ${parent}
    OR EXISTS (SELECT 1 FROM terminal_lineage))`;
}

function memoryStorageSelection() {
  return {
    id: memberMemories.id,
    userId: sql`${memberMemories.userId}`
      .mapWith(memberMemories.userId)
      .as("userId"),
    name: sql`${MEMORY_ARTIFACT_NAME}`
      .mapWith(memberMemories.userId)
      .as("name"),
    orgId: sql`${memberMemories.orgId}`
      .mapWith(memberMemories.orgId)
      .as("orgId"),
    s3Prefix: sql`${memberMemories.objectPrefix}`
      .mapWith(memberMemories.objectPrefix)
      .as("s3Prefix"),
    size: sql`${memberMemories.contentSize}`
      .mapWith(memberMemories.contentSize)
      .as("size"),
    fileCount: sql`${memberMemories.fileCount}`
      .mapWith(memberMemories.fileCount)
      .as("fileCount"),
    headVersionId: sql`${memberMemories.headVersionId}`
      .mapWith(nullableDriverValueDecoder(memberMemories.headVersionId))
      .as("headVersionId"),
    createdAt: sql`${memberMemories.createdAt}`
      .mapWith(memberMemories.createdAt)
      .as("createdAt"),
    updatedAt: sql`${memberMemories.updatedAt}`
      .mapWith(memberMemories.updatedAt)
      .as("updatedAt"),
  };
}
function memoryVersionSelection() {
  return {
    id: memoryVersions.id,
    storageId: sql`${memoryVersions.memoryId}`
      .mapWith(memoryVersions.memoryId)
      .as("storageId"),
    s3Key: sql`${memoryVersions.objectPrefix}`
      .mapWith(memoryVersions.objectPrefix)
      .as("s3Key"),
    size: sql`${memoryVersions.contentSize}`
      .mapWith(memoryVersions.contentSize)
      .as("size"),
    archiveSize: sql`${memoryVersions.archiveSize}`
      .mapWith(memoryVersions.archiveSize)
      .as("archiveSize"),
    fileCount: sql`${memoryVersions.fileCount}`
      .mapWith(memoryVersions.fileCount)
      .as("fileCount"),
    message: memoryVersions.message,
    createdBy: sql`${memoryVersions.createdBy}`
      .mapWith(memoryVersions.createdBy)
      .as("createdBy"),
    createdAt: sql`${memoryVersions.createdAt}`
      .mapWith(memoryVersions.createdAt)
      .as("createdAt"),
  };
}
// The installed dialect owns complete INSERT syntax and every value retains its
// schema encoder. SELECT supplies all insertable columns in schema order.
function insertSelectedStorageSql<T extends PgTable>(
  table: T,
  values: {
    readonly [K in keyof T["$inferInsert"]]: T["$inferInsert"][K] | SQL;
  },
  source: SQL,
  returning: Readonly<Record<string, AnyPgColumn | SQL>>,
  conflict?: SQL,
) {
  const columns: Readonly<Record<string, AnyPgColumn>> = getTableColumns(table);
  const supplied: Readonly<Record<string, unknown>> = values;
  const fields = Object.entries(columns).map(([name, column]) => {
    const value = supplied[name];
    if (value !== undefined) {
      return is(value, SQL) ? value : sql.param(value, column);
    }
    const fallback = column.default;
    if (is(fallback, SQL)) {
      return fallback;
    }
    return sql.param(fallback ?? null, column);
  });
  return new PgDialect().buildInsertQuery({
    table,
    select: true,
    values: sql`SELECT ${sql.join(fields, sql`, `)} FROM ${source}`,
    onConflict: conflict,
    returning: Object.entries(returning).map(([name, column]) => {
      return {
        path: [name],
        field: sql`${column}`.as(name),
      };
    }),
  });
}

function memoryStorageAdmission(input: CommitStorageForStorageInput) {
  return new QueryBuilder()
    .select(memoryStorageSelection())
    .from(memberMemories)
    .where(
      and(
        eq(memberMemories.id, input.storageId),
        sql`EXISTS (SELECT 1 FROM commit_mount AS m WHERE m.value->>'orgId'=${memberMemories.orgId}
        AND m.value->>'userId'=${memberMemories.userId} AND m.value->>'name'=${MEMORY_ARTIFACT_NAME})`,
      ),
    )
    .limit(1)
    .getSQL();
}

function storageCommitAdmission(
  input: CommitStorageForStorageInput,
  verification: VerifiedStorageCommit,
) {
  const auth = input.sandboxAuth;
  const run = new QueryBuilder()
    .select({
      status: agentRuns.status,
      storageMounts: sql`${agentRuns.storageMounts}`
        .mapWith(nullableDriverValueDecoder(agentRuns.storageMounts))
        .as("storageMounts"),
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, auth.runId),
        eq(agentRuns.orgId, auth.orgId),
        eq(agentRuns.userId, auth.userId),
      ),
    )
    .limit(1)
    .for("update")
    .getSQL();
  // Validate the same complete mount array as the previous Zod boundary before
  // any write. The first matching writeback mount retains Array.find semantics.
  const valid = sql`
    NOT EXISTS (SELECT 1
      FROM jsonb_array_elements(r."storageMounts") AS m(value)
      WHERE jsonb_typeof(m.value) IS DISTINCT FROM 'object'
      OR jsonb_typeof(m.value->'storageId') IS DISTINCT FROM 'string'
      OR jsonb_typeof(m.value->'orgId') IS DISTINCT FROM 'string'
      OR jsonb_typeof(m.value->'userId') IS DISTINCT FROM 'string'
      OR jsonb_typeof(m.value->'name') IS DISTINCT FROM 'string'
      OR (m.value ? 'writeback'
      AND jsonb_typeof(m.value->'writeback') IS DISTINCT FROM 'boolean'))
  `;
  const mount = sql`SELECT m.value FROM commit_run AS r CROSS JOIN LATERAL jsonb_array_elements(r."storageMounts") WITH ORDINALITY AS m(value,position) WHERE m.value->>'storageId'=${input.storageId} AND m.value->'writeback'='true'::jsonb ORDER BY m.position LIMIT 1`;
  const storage = memoryStorageAdmission(input);
  const version = new QueryBuilder()
    .select(memoryVersionSelection())
    .from(memoryVersions)
    .where(
      and(
        eq(memoryVersions.memoryId, input.storageId),
        eq(memoryVersions.id, input.versionId),
      ),
    )
    .limit(1)
    .getSQL();
  const parent = input.parentVersionId;
  const lineage = parent
    ? new QueryBuilder()
        .select({ id: memoryVersionLineage.id })
        .from(memoryVersionLineage)
        .where(
          and(
            eq(memoryVersionLineage.memoryId, input.storageId),
            eq(memoryVersionLineage.versionId, input.versionId),
            eq(memoryVersionLineage.parentVersionId, parent),
            eq(memoryVersionLineage.runId, auth.runId),
          ),
        )
        .limit(1)
        .getSQL()
    : sql`SELECT NULL::uuid AS id WHERE false`;
  const terminal = sql`r.status NOT IN ('pending','running')`;
  const exact = sql`
    v."s3Key"=${verification.s3Key}
      AND v."s3Key"=s."s3Prefix" || '/' || ${input.versionId}
      AND v.size=${totalSize(input.files)}
      AND v."archiveSize"=${verification.archiveSize}
      AND v."fileCount"=${input.files.length}
      AND v.message IS NOT DISTINCT FROM ${input.message ?? null}
      AND v."createdBy"='agent'
  `;
  return sql`
    commit_run AS MATERIALIZED (${run}), commit_mount AS MATERIALIZED (${mount}), initial_storage AS MATERIALIZED (${storage}), existing_version AS MATERIALIZED (${version}), terminal_lineage AS (${lineage}), admitted_storage AS MATERIALIZED (SELECT s.*, ${terminal} AS terminal
      FROM initial_storage AS s
      CROSS JOIN commit_run AS r
      LEFT JOIN existing_version AS v ON true
      WHERE ${valid}
      AND (NOT (${terminal})
      OR (${parent !== undefined}
      AND ${exact}
      AND EXISTS(SELECT 1
      FROM terminal_lineage))))
  `;
}
function headTransition(input: CommitStorageForStorageInput) {
  return sql`s."headVersionId" IS DISTINCT FROM v.id AND ${memoryPublicationAllowed(input)}
    AND NOT EXISTS (SELECT 1 FROM terminal_lineage)
    AND v.id IS DISTINCT FROM ${memoryParentVersion(input)}`;
}

export function storageCommitPublicationResult(
  row: output<typeof storageCommitPublicationRow> | undefined,
  input: CommitStorageForStorageInput,
): CommitStorageResponse {
  if (!row) {
    throw new Error("Missing Storage publication result");
  }
  if (!row.run) {
    return notFound("Agent run not found");
  }
  if (!row.storage) {
    return notFound("Writeback storage not found");
  }
  if (!sandboxStorageRunIsActive(row.run.status) && !row.admitted) {
    return notFound("Active agent run not found");
  }
  if (!row.admitted) {
    throw new Error("Storage disappeared before HEAD publication");
  }
  if (row.memoryConflict) {
    return conflict(
      `Memory changed during this Run. Candidate version ${input.versionId} was retained; review the latest memory before publishing again.`,
    );
  }
  if (!row.version) {
    throw new Error(
      `Storage version ${input.versionId} conflicts with committed metadata`,
    );
  }
  return storageCommitSuccess({
    storage: row.storage,
    versionId: input.versionId,
    size: row.version.size,
    fileCount: row.version.fileCount,
    deduplicated: !row.inserted,
  });
}
export function sandboxStorageRunIsActive(
  status: typeof agentRuns.$inferSelect.status,
): boolean {
  return ACTIVE_SANDBOX_STORAGE_RUN_STATUSES.some((activeStatus) => {
    return status === activeStatus;
  });
}

export function totalSize(files: readonly FileEntryWithHash[]): number {
  return files.reduce((sum, file) => {
    return sum + file.size;
  }, 0);
}

export function terminalStorageCommitPersistedStateMatches(args: {
  readonly storage: StorageRow;
  readonly version: StorageVersionRow | undefined;
  readonly input: CommitStorageForStorageInput;
}): boolean {
  const version = args.version;
  const parentVersionId = args.input.parentVersionId;
  const size = totalSize(args.input.files);
  const fileCount = args.input.files.length;
  return (
    version !== undefined &&
    parentVersionId !== undefined &&
    version.s3Key === `${args.storage.s3Prefix}/${args.input.versionId}` &&
    Number(version.size) === size &&
    version.fileCount === fileCount &&
    version.message === (args.input.message ?? null) &&
    version.createdBy === "agent"
  );
}

export function storageCommitSuccess(args: {
  readonly storage: StorageRow;
  readonly versionId: string;
  readonly size: number;
  readonly fileCount: number;
  readonly deduplicated: boolean;
}): CommitStorageResponse {
  return {
    status: 200,
    body: {
      success: true,
      versionId: args.versionId,
      storageName: args.storage.name,
      size: args.size,
      fileCount: args.fileCount,
      ...(args.deduplicated ? { deduplicated: true } : {}),
    },
  };
}

function memoryVersionReturning() {
  return {
    id: memoryVersions.id,
    storageId: memoryVersions.memoryId,
    s3Key: memoryVersions.objectPrefix,
    size: memoryVersions.contentSize,
    archiveSize: memoryVersions.archiveSize,
    fileCount: memoryVersions.fileCount,
    message: memoryVersions.message,
    createdBy: memoryVersions.createdBy,
    createdAt: memoryVersions.createdAt,
  };
}
function memoryCandidateStatement(
  input: CommitStorageForStorageInput,
  verification: VerifiedStorageCommit,
) {
  return insertSelectedStorageSql(
    memoryVersions,
    {
      id: input.versionId,
      memoryId: input.storageId,
      objectPrefix: verification.s3Key,
      contentSize: totalSize(input.files),
      archiveSize: verification.archiveSize,
      fileCount: input.files.length,
      message: input.message ?? null,
      createdBy: input.runId ? "agent" : "user",
    },
    sql`locked_storage WHERE NOT EXISTS (SELECT 1 FROM existing_version)`,
    { ...memoryVersionReturning(), newlyInserted: sql`xmax=0` },
    sql`(id) DO UPDATE SET id=excluded.id WHERE ${memoryVersions.memoryId}=excluded.memory_id AND ${memoryVersions.objectPrefix}=excluded.object_prefix`,
  );
}
function memoryLineageStatement(input: CommitStorageForStorageInput) {
  const auth = input.sandboxAuth,
    parent = input.parentVersionId;
  if (!parent) {
    return sql`SELECT NULL::uuid AS id,NULL::uuid AS "storageId",NULL::text AS "versionId",
    NULL::text AS "parentVersionId",NULL::uuid AS "runId",NULL::timestamp AS "createdAt" WHERE false`;
  }
  return insertSelectedStorageSql(
    memoryVersionLineage,
    {
      memoryId: input.storageId,
      versionId: input.versionId,
      parentVersionId: parent,
      runId: auth.runId,
    },
    sql`locked_storage AS s CROSS JOIN published_version CROSS JOIN (SELECT count(*) FROM published_head) AS completed_head WHERE ${memoryPublicationAllowed(input)}`,
    {
      id: memoryVersionLineage.id,
      storageId: memoryVersionLineage.memoryId,
      versionId: memoryVersionLineage.versionId,
      parentVersionId: memoryVersionLineage.parentVersionId,
      runId: memoryVersionLineage.runId,
      createdAt: memoryVersionLineage.createdAt,
    },
  );
}

/** Protocol D publishes only Memory-owned state under the Run/root boundary. */
export function storageCommitPublicationStatement(
  input: CommitStorageForStorageInput,
  verification: VerifiedStorageCommit,
  changedAt: Date,
) {
  const locked = new QueryBuilder()
    .select(memoryStorageSelection())
    .from(memberMemories)
    .where(
      and(
        eq(memberMemories.id, input.storageId),
        sql`EXISTS (SELECT 1 FROM admitted_storage AS s WHERE NOT s.terminal AND s.id=${memberMemories.id}
        AND s."orgId"=${memberMemories.orgId} AND s."userId"=${memberMemories.userId})`,
      ),
    )
    .limit(1)
    .for("update", { of: memberMemories })
    .getSQL();
  const consistent = sql`v."storageId"=s.id AND v."s3Key"=s."s3Prefix" || '/' || v.id`;
  const advance = headTransition(input);
  // An invalid candidate locator must fail the complete statement, including
  // registration and lineage, even when the candidate cannot advance HEAD.
  const head = new PgDialect().buildUpdateQuery({
    table: memberMemories,
    set: {
      objectPrefix: sql`CASE WHEN ${consistent} THEN s."s3Prefix" ELSE NULL END`,
      headVersionId: sql`CASE WHEN ${advance} THEN v.id ELSE s."headVersionId" END`,
      contentSize: sql`CASE WHEN ${advance} THEN v.size ELSE s.size END`,
      fileCount: sql`CASE WHEN ${advance} THEN v."fileCount" ELSE s."fileCount" END`,
      updatedAt: sql`CASE WHEN ${advance} THEN ${sql.param(changedAt, memberMemories.updatedAt)} ELSE s."updatedAt" END`,
    },
    from: sql`locked_storage AS s CROSS JOIN published_version AS v`,
    where: sql`${memberMemories.id}=s.id AND (${advance} OR NOT (${consistent}))`,
    joins: [],
    returning: [{ path: ["id"], field: memberMemories.id }],
  });
  return sql`WITH ${storageCommitAdmission(input, verification)},
    locked_storage AS MATERIALIZED (${locked}),
    inserted_version AS (${memoryCandidateStatement(input, verification)}),
    published_version AS MATERIALIZED (
      SELECT v.*,false AS "newlyInserted" FROM existing_version AS v
      WHERE EXISTS (SELECT 1 FROM admitted_storage WHERE terminal) OR EXISTS (SELECT 1 FROM locked_storage)
      UNION ALL SELECT * FROM inserted_version
    ), published_head AS (${head}),
    recorded_lineage AS (${memoryLineageStatement(input)})
    SELECT (SELECT row_to_json(r) FROM commit_run AS r) AS run,
      (SELECT row_to_json(s) FROM initial_storage AS s) AS storage,
      (SELECT row_to_json(v) FROM published_version AS v) AS version,
      EXISTS (SELECT 1 FROM locked_storage) OR EXISTS (SELECT 1 FROM admitted_storage WHERE terminal) AS admitted,
      EXISTS (SELECT 1 FROM inserted_version WHERE "newlyInserted") AS inserted,
      EXISTS (SELECT 1 FROM locked_storage AS s WHERE NOT ${memoryPublicationAllowed(input)}) AS "memoryConflict"
  `;
}
