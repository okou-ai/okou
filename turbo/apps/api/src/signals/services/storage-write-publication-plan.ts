import type { FileEntryWithHash } from "@okouai/api-contracts/contracts/storage-content-hash";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { piResourceVersionIndexes } from "@okouai/db/schema/pi-resource-version-index";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { storageVersionLineage } from "@okouai/db/schema/storage-version-lineage";
import { and, eq, getTableColumns, is, SQL, sql } from "drizzle-orm";
import {
  PgDialect,
  QueryBuilder,
  type AnyPgColumn,
  type PgTable,
} from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  pgInt8ToSafeIntegerSchema,
  pgTimestampWithoutTimezoneToDateSchema,
} from "../../lib/db-raw-rows";
import { nullableDriverValueDecoder } from "../../lib/db-structured-result";
import { conflict, notFound } from "../../lib/error";
import { MEMORY_ARTIFACT_NAME } from "@okouai/core/storage-names";
import { PI_RESOURCE_EXTRACTOR_VERSION } from "../../lib/pi-resource-index";
import {
  sandboxStorageRunCondition,
  storageCommitLineageCondition,
  storageVersionCondition,
} from "./storage-write-conditions";
import type {
  CommitStorageForStorageInput,
  CommitStorageResponse,
  StorageRow,
  StorageVersionRow,
  VerifiedStorageCommit,
} from "./storage-write.service";

const ACTIVE_SANDBOX_STORAGE_RUN_STATUSES = ["pending", "running"] as const;
const integerRow = z.union([z.int(), pgInt8ToSafeIntegerSchema]);
const dateRow = z.union([z.date(), pgTimestampWithoutTimezoneToDateSchema]);
const mountRow = z.object({
  storageId: z.string(),
  orgId: z.string(),
  userId: z.string(),
  name: z.string(),
  writeback: z.boolean().optional(),
});
const runRow = z.object({
  status: z.string(),
  storageMounts: z.array(mountRow).nullable(),
});
const storageRow = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  orgId: z.string(),
  s3Prefix: z.string(),
  size: integerRow,
  fileCount: z.int(),
  headVersionId: z.string().nullable(),
  createdAt: dateRow,
  updatedAt: dateRow,
});
const versionRow = z.object({
  id: z.string(),
  storageId: z.string(),
  s3Key: z.string(),
  size: integerRow,
  archiveSize: integerRow,
  fileCount: z.int(),
  message: z.string().nullable(),
  createdBy: z.string(),
  createdAt: dateRow,
});
export const storageCommitPublicationRow = z.object({
  run: runRow.nullable(),
  storage: storageRow.nullable(),
  version: versionRow.nullable(),
  admitted: z.boolean(),
  inserted: z.boolean(),
  indexed: z.boolean(),
  memoryConflict: z.boolean(),
});

function memoryParentVersion(input: CommitStorageForStorageInput) {
  return input.parentVersionId === undefined
    ? sql`(SELECT value->>'version' FROM commit_mount)`
    : sql`${input.parentVersionId}`;
}

function memoryPublicationAllowed(input: CommitStorageForStorageInput) {
  if (!input.sandboxAuth) {
    return sql`true`;
  }
  const parent = memoryParentVersion(input);
  return sql`(s.name <> ${MEMORY_ARTIFACT_NAME}
    OR s."headVersionId" IS NOT DISTINCT FROM ${parent}
    OR s."headVersionId" = ${input.versionId}
    OR ${input.versionId} IS NOT DISTINCT FROM ${parent}
    OR EXISTS (SELECT 1 FROM terminal_lineage))`;
}

function storageSelection() {
  return {
    id: storages.id,
    userId: sql`${storages.userId}`.mapWith(storages.userId).as("userId"),
    name: storages.name,
    orgId: sql`${storages.orgId}`.mapWith(storages.orgId).as("orgId"),
    s3Prefix: sql`${storages.s3Prefix}`
      .mapWith(storages.s3Prefix)
      .as("s3Prefix"),
    size: storages.size,
    fileCount: sql`${storages.fileCount}`
      .mapWith(storages.fileCount)
      .as("fileCount"),
    headVersionId: sql`${storages.headVersionId}`
      .mapWith(nullableDriverValueDecoder(storages.headVersionId))
      .as("headVersionId"),
    createdAt: sql`${storages.createdAt}`
      .mapWith(storages.createdAt)
      .as("createdAt"),
    updatedAt: sql`${storages.updatedAt}`
      .mapWith(storages.updatedAt)
      .as("updatedAt"),
  };
}
function versionSelection() {
  return {
    id: storageVersions.id,
    storageId: sql`${storageVersions.storageId}`
      .mapWith(storageVersions.storageId)
      .as("storageId"),
    s3Key: sql`${storageVersions.s3Key}`
      .mapWith(storageVersions.s3Key)
      .as("s3Key"),
    size: storageVersions.size,
    archiveSize: sql`${storageVersions.archiveSize}`
      .mapWith(storageVersions.archiveSize)
      .as("archiveSize"),
    fileCount: sql`${storageVersions.fileCount}`
      .mapWith(storageVersions.fileCount)
      .as("fileCount"),
    message: storageVersions.message,
    createdBy: sql`${storageVersions.createdBy}`
      .mapWith(storageVersions.createdBy)
      .as("createdBy"),
    createdAt: sql`${storageVersions.createdAt}`
      .mapWith(storageVersions.createdAt)
      .as("createdAt"),
  };
}
// The installed dialect owns complete INSERT syntax and every value retains its
// schema encoder. SELECT supplies all insertable columns in schema order.
function insertSelectedStorageSql<T extends PgTable>(
  table: T,
  values: T["$inferInsert"],
  source: SQL,
  returning: Readonly<Record<string, AnyPgColumn>>,
  conflict?: SQL,
) {
  const columns: Readonly<Record<string, AnyPgColumn>> = getTableColumns(table);
  const supplied: Readonly<Record<string, unknown>> = values;
  const fields = Object.entries(columns).map(([name, column]) => {
    const value = supplied[name];
    if (value !== undefined) {
      return sql.param(value, column);
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
function storageCommitAdmission(
  input: CommitStorageForStorageInput,
  verification: VerifiedStorageCommit,
) {
  const auth = input.sandboxAuth;
  const run = auth
    ? new QueryBuilder()
        .select({
          status: agentRuns.status,
          storageMounts: sql`${agentRuns.storageMounts}`
            .mapWith(nullableDriverValueDecoder(agentRuns.storageMounts))
            .as("storageMounts"),
        })
        .from(agentRuns)
        .where(sandboxStorageRunCondition(auth))
        .limit(1)
        .for("update")
        .getSQL()
    : sql`SELECT 'pending'::text AS status, NULL::jsonb AS "storageMounts"`;
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
  const authority = auth
    ? sql`EXISTS (SELECT 1 FROM commit_mount AS m WHERE m.value->>'orgId'=${storages.orgId} AND m.value->>'userId'=${storages.userId} AND m.value->>'name'=${storages.name})`
    : sql`EXISTS (SELECT 1 FROM commit_run)`;
  const storage = new QueryBuilder()
    .select(storageSelection())
    .from(storages)
    .where(and(eq(storages.id, input.storageId), authority))
    .limit(1)
    .getSQL();
  const version = new QueryBuilder()
    .select(versionSelection())
    .from(storageVersions)
    .where(storageVersionCondition(input.storageId, input.versionId))
    .limit(1)
    .getSQL();
  const parent = input.parentVersionId;
  const lineage =
    auth && parent
      ? new QueryBuilder()
          .select({ id: storageVersionLineage.id })
          .from(storageVersionLineage)
          .where(
            storageCommitLineageCondition(
              input.storageId,
              input.versionId,
              parent,
              auth.runId,
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
      AND (s.name = ${MEMORY_ARTIFACT_NAME} OR (
        s."headVersionId"=${input.versionId}
        AND s.size=${totalSize(input.files)}
        AND s."fileCount"=${input.files.length}))
  `;
  return sql`
    commit_run AS MATERIALIZED (${run}), commit_mount AS MATERIALIZED (${mount}), initial_storage AS MATERIALIZED (${storage}), existing_version AS MATERIALIZED (${version}), terminal_lineage AS (${lineage}), admitted_storage AS MATERIALIZED (SELECT s.*, ${terminal} AS terminal
      FROM initial_storage AS s
      CROSS JOIN commit_run AS r
      LEFT JOIN existing_version AS v ON true
      WHERE ${valid}
      AND (NOT (${terminal})
      OR (${auth !== undefined && parent !== undefined}
      AND ${exact}
      AND EXISTS(SELECT 1
      FROM terminal_lineage))))
  `;
}
function storageCommitLockedSelection(input: CommitStorageForStorageInput) {
  return new QueryBuilder()
    .select(storageSelection())
    .from(storages)
    .where(
      and(
        eq(storages.id, input.storageId),
        sql`EXISTS (SELECT 1 FROM admitted_storage AS s WHERE NOT s.terminal AND s.id=${storages.id} AND s."orgId"=${storages.orgId} AND s."userId"=${storages.userId} AND s.name=${storages.name})`,
      ),
    )
    .limit(1)
    .for("update", { of: storages })
    .getSQL();
}
function storageCommitVersionInsert(
  input: CommitStorageForStorageInput,
  verification: VerifiedStorageCommit,
) {
  return insertSelectedStorageSql(
    storageVersions,
    {
      id: input.versionId,
      storageId: input.storageId,
      s3Key: verification.s3Key,
      size: totalSize(input.files),
      archiveSize: verification.archiveSize,
      fileCount: input.files.length,
      message: input.message ?? null,
      createdBy: input.runId ? "agent" : "user",
    },
    sql`locked_storage WHERE NOT EXISTS(SELECT 1 FROM existing_version)`,
    getTableColumns(storageVersions),
    sql`do nothing`,
  );
}
function storageCommitLineageInsert(input: CommitStorageForStorageInput) {
  const auth = input.sandboxAuth,
    parent = input.parentVersionId;
  if (!auth || !parent) {
    return sql`SELECT NULL::uuid AS id WHERE false`;
  }
  return insertSelectedStorageSql(
    storageVersionLineage,
    {
      storageId: input.storageId,
      versionId: input.versionId,
      parentVersionId: parent,
      runId: auth.runId,
    },
    sql`locked_storage AS s CROSS JOIN published_version CROSS JOIN (SELECT count(*) FROM published_head) AS completed_head WHERE ${memoryPublicationAllowed(input)}`,
    { id: storageVersionLineage.id },
  );
}
function storageCommitIndexInsert(changedAt: Date) {
  const columns = getTableColumns(piResourceVersionIndexes);
  const fields = Object.entries(columns).map(([name, column]) => {
    if (name === "storageVersionId") {
      return sql`v.id`;
    }
    if (name === "extractorVersion") {
      return sql.param(PI_RESOURCE_EXTRACTOR_VERSION, column);
    }
    if (name === "sourceArchiveSize") {
      return sql`v."archiveSize"`;
    }
    if (is(column.default, SQL)) {
      return column.default;
    }
    return sql.param(column.default ?? null, column);
  });
  return new PgDialect().buildInsertQuery({
    table: piResourceVersionIndexes,
    select: true,
    values: sql`SELECT ${sql.join(fields, sql`, `)} FROM published_version AS v CROSS JOIN (SELECT count(*) FROM published_head) AS completed_head CROSS JOIN (SELECT count(*) FROM recorded_lineage) AS completed_lineage`,
    onConflict: sql`
    (storage_version_id,extractor_version) DO UPDATE
      SET status='pending',projection=NULL,projection_hash=NULL,source_archive_size=excluded.source_archive_size,lease_id=NULL,lease_expires_at=NULL,available_at=${sql.param(changedAt, piResourceVersionIndexes.availableAt)},attempt_count=0,updated_at=${sql.param(changedAt, piResourceVersionIndexes.updatedAt)}
      WHERE ${piResourceVersionIndexes.sourceArchiveSize} IS DISTINCT FROM excluded.source_archive_size
  `,
    returning: [
      {
        path: ["id"],
        field: sql`${piResourceVersionIndexes.storageVersionId}`.as("id"),
      },
    ],
  });
}

/** One statement publishes the version, HEAD, lineage and index work together. */
export function storageCommitPublicationStatement(
  input: CommitStorageForStorageInput,
  verification: VerifiedStorageCommit,
  changedAt: Date,
) {
  const head = new PgDialect().buildUpdateQuery({
    table: storages,
    set: {
      headVersionId: sql`v.id`,
      size: sql`v.size`,
      fileCount: sql`v."fileCount"`,
      updatedAt: sql.param(changedAt, storages.updatedAt),
    },
    from: sql`locked_storage AS s CROSS JOIN published_version AS v`,
    where: sql`${storages.id}=s.id AND ${storages.headVersionId} IS DISTINCT FROM v.id
      AND ${memoryPublicationAllowed(input)}
      AND (s.name <> ${MEMORY_ARTIFACT_NAME} OR ${input.sandboxAuth === undefined}
        OR (NOT EXISTS (SELECT 1 FROM terminal_lineage)
          AND v.id IS DISTINCT FROM ${memoryParentVersion(input)}))`,
    joins: [],
    returning: [{ path: ["id"], field: storages.id }],
  });
  return sql`
    WITH ${storageCommitAdmission(input, verification)}, locked_storage AS MATERIALIZED (${storageCommitLockedSelection(input)}), inserted_version AS (${storageCommitVersionInsert(input, verification)}), published_version AS MATERIALIZED (SELECT v.*
      FROM existing_version AS v
      WHERE EXISTS(SELECT 1
      FROM admitted_storage AS s
      WHERE s.terminal)
      OR EXISTS(SELECT 1
      FROM locked_storage)
      UNION ALL
      SELECT *
      FROM inserted_version), published_head AS (${head}), recorded_lineage AS (${storageCommitLineageInsert(input)}), enqueued_index AS (${storageCommitIndexInsert(changedAt)})
      SELECT (SELECT row_to_json(r)
      FROM commit_run AS r) AS run, (SELECT row_to_json(s)
      FROM initial_storage AS s) AS storage, (SELECT row_to_json(v)
      FROM published_version AS v) AS version, EXISTS(SELECT 1
      FROM locked_storage)
      OR EXISTS(SELECT 1
      FROM admitted_storage
      WHERE terminal) AS admitted, EXISTS(SELECT 1
      FROM inserted_version) AS inserted, (SELECT count(*)
      FROM enqueued_index)>=0 AS indexed,
      EXISTS (SELECT 1 FROM locked_storage AS s WHERE NOT ${memoryPublicationAllowed(input)}) AS "memoryConflict"
  `;
}

export function storageCommitPublicationResult(
  row: z.output<typeof storageCommitPublicationRow> | undefined,
  input: CommitStorageForStorageInput,
): CommitStorageResponse {
  if (!row) {
    throw new Error("Missing Storage publication result");
  }
  if (input.sandboxAuth && !row.run) {
    return notFound("Agent run not found");
  }
  if (!row.storage) {
    return notFound(
      input.sandboxAuth ? "Writeback storage not found" : "Storage not found",
    );
  }
  if (
    input.sandboxAuth &&
    row.run &&
    !sandboxStorageRunIsActive(row.run.status) &&
    !row.admitted
  ) {
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
  const sandboxAuth = args.input.sandboxAuth;
  const parentVersionId = args.input.parentVersionId;
  const size = totalSize(args.input.files);
  const fileCount = args.input.files.length;
  return (
    version !== undefined &&
    sandboxAuth !== undefined &&
    parentVersionId !== undefined &&
    version.s3Key === `${args.storage.s3Prefix}/${args.input.versionId}` &&
    Number(version.size) === size &&
    version.fileCount === fileCount &&
    version.message === (args.input.message ?? null) &&
    version.createdBy === "agent" &&
    (args.storage.name === MEMORY_ARTIFACT_NAME ||
      (args.storage.headVersionId === args.input.versionId &&
        Number(args.storage.size) === size &&
        args.storage.fileCount === fileCount))
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
