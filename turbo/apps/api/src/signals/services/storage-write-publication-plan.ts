import type { FileEntryWithHash } from "@okouai/api-contracts/contracts/storage-content-hash";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { piResourceVersionIndexes } from "@okouai/db/schema/pi-resource-version-index";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { storageVersionLineage } from "@okouai/db/schema/storage-version-lineage";
import { eq, getTableColumns, is, Param, SQL, sql } from "drizzle-orm";
import {
  PgColumn,
  PgDialect,
  QueryBuilder,
  type AnyPgColumn,
  type PgTable,
  type PgUpdateSetSource,
} from "drizzle-orm/pg-core";
import * as z from "zod";

import {
  pgInt8ToSafeIntegerSchema,
  pgTimestampWithoutTimezoneToDateSchema,
} from "../../lib/db-raw-rows";
import { notFound } from "../../lib/error";
import type { SandboxAuth } from "../../types/auth";
import {
  piResourceIndexQueueValues,
  piResourceIndexRepairCondition,
  piResourceIndexRepairValues,
} from "./pi-resource-version-index.service";
import {
  sandboxStorageRunCondition,
  storageCommitLineageCondition,
  storageIdentityCondition,
  storageVersionCondition,
} from "./storage-write-conditions";
import type {
  CommitStorageForStorageInput,
  CommitStorageResponse,
  StorageErrorResponse,
  StorageRow,
  StorageVersionRow,
  VerifiedStorageCommit,
} from "./storage-write.service";

// A plan never receives a database, transaction or clock. Its owner supplies
// each statement's rows and captures Date values at the requested steps.
// Separate SQL yields preserve fresh READ COMMITTED snapshots after lock waits.
interface StorageSqlStatement {
  readonly sql: SQL;
  readonly rowSchema: z.ZodType | null;
}
type StorageSqlPlan<T> = Generator<
  StorageSqlStatement | { readonly kind: "timestamp-read" },
  T,
  readonly unknown[]
>;
function* publicationTimestampPlan(): StorageSqlPlan<Date> {
  const [timestamp] = z
    .tuple([z.date()])
    .parse(yield { kind: "timestamp-read" });
  return timestamp;
}
function readStatement(query: SQL, rowSchema: z.ZodType): StorageSqlStatement {
  return { sql: query, rowSchema };
}
function writeStatement(query: SQL): StorageSqlStatement {
  return { sql: query, rowSchema: null };
}

function boundStorageValues(
  table: PgTable,
  values: Readonly<Record<string, unknown>>,
): Record<string, Param | SQL> {
  const columns: Readonly<Record<string, AnyPgColumn>> = getTableColumns(table);
  const encoded: Record<string, Param | SQL> = {};
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) {
      continue;
    }
    const column = columns[name];
    if (!column) {
      throw new Error(`Unknown Storage write field ${name}`);
    }
    encoded[name] =
      is(value, SQL) || is(value, PgColumn)
        ? sql`${value}`
        : sql.param(value, column);
  }
  return encoded;
}
function insertedStorageSql<TTable extends PgTable>(
  table: TTable,
  values: TTable["$inferInsert"],
  conflict = false,
  returning?: AnyPgColumn,
): SQL {
  return new PgDialect().buildInsertQuery({
    table,
    values: [boundStorageValues(table, values)],
    onConflict: conflict ? sql`do nothing` : undefined,
    returning: returning
      ? [{ path: ["id"], field: sql`${returning}`.as("id") }]
      : undefined,
  });
}
function updatedStorageSql<TTable extends PgTable>(
  table: TTable,
  values: PgUpdateSetSource<TTable>,
  where: SQL | undefined,
  returning?: AnyPgColumn,
): SQL {
  return new PgDialect().buildUpdateQuery({
    table,
    set: boundStorageValues(table, values),
    where,
    joins: [],
    returning: returning
      ? [{ path: ["id"], field: sql`${returning}`.as("id") }]
      : undefined,
  });
}
const ACTIVE_SANDBOX_STORAGE_RUN_STATUSES = ["pending", "running"] as const;
const integerRow = z.union([z.int(), pgInt8ToSafeIntegerSchema]);
const dateRow = z.union([z.date(), pgTimestampWithoutTimezoneToDateSchema]);
const idRows = z.array(z.object({ id: z.string() }));
const mountRow = z.object({
  storageId: z.string(),
  orgId: z.string(),
  userId: z.string(),
  name: z.string(),
  writeback: z.boolean().optional(),
});
const runRows = z.array(
  z.object({ status: z.string(), storageMounts: z.array(mountRow).nullable() }),
);
const storageRows = z.array(
  z.object({
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
  }),
);
const versionRows = z.array(
  z.object({
    id: z.string(),
    storageId: z.string(),
    s3Key: z.string(),
    size: integerRow,
    archiveSize: integerRow,
    fileCount: z.int(),
    message: z.string().nullable(),
    createdBy: z.string(),
    createdAt: dateRow,
  }),
);

function storageSnapshotSql(condition: SQL | undefined, lock = false) {
  const query = new QueryBuilder()
    .select({
      id: storages.id,
      userId: sql`${storages.userId}`.as("userId"),
      name: storages.name,
      orgId: sql`${storages.orgId}`.as("orgId"),
      s3Prefix: sql`${storages.s3Prefix}`.as("s3Prefix"),
      size: storages.size,
      fileCount: sql`${storages.fileCount}`.as("fileCount"),
      headVersionId: sql`${storages.headVersionId}`.as("headVersionId"),
      createdAt: sql`${storages.createdAt}`.as("createdAt"),
      updatedAt: sql`${storages.updatedAt}`.as("updatedAt"),
    })
    .from(storages)
    .where(condition)
    .limit(1);
  return lock ? query.for("update", { of: storages }).getSQL() : query.getSQL();
}
function versionSnapshotSql(condition: SQL | undefined) {
  return new QueryBuilder()
    .select({
      id: storageVersions.id,
      storageId: sql`${storageVersions.storageId}`.as("storageId"),
      s3Key: sql`${storageVersions.s3Key}`.as("s3Key"),
      size: storageVersions.size,
      archiveSize: sql`${storageVersions.archiveSize}`.as("archiveSize"),
      fileCount: sql`${storageVersions.fileCount}`.as("fileCount"),
      message: storageVersions.message,
      createdBy: sql`${storageVersions.createdBy}`.as("createdBy"),
      createdAt: sql`${storageVersions.createdAt}`.as("createdAt"),
    })
    .from(storageVersions)
    .where(condition)
    .limit(1)
    .getSQL();
}
function runSnapshotSql(auth: SandboxAuth) {
  return new QueryBuilder()
    .select({
      status: agentRuns.status,
      storageMounts: sql`${agentRuns.storageMounts}`.as("storageMounts"),
    })
    .from(agentRuns)
    .where(sandboxStorageRunCondition(auth))
    .limit(1)
    .for("update")
    .getSQL();
}
function lineageSnapshotSql(
  storageId: string,
  input: CommitStorageForStorageInput,
  parentVersionId: string,
  runId: string,
) {
  return new QueryBuilder()
    .select({ id: storageVersionLineage.id })
    .from(storageVersionLineage)
    .where(
      storageCommitLineageCondition(
        storageId,
        input.versionId,
        parentVersionId,
        runId,
      ),
    )
    .limit(1)
    .getSQL();
}

interface AdmittedCommit {
  readonly storage: StorageRow;
  readonly runStatus?: string;
  readonly version?: StorageVersionRow;
}

function* admitStorageCommit(
  input: CommitStorageForStorageInput,
): StorageSqlPlan<AdmittedCommit | StorageErrorResponse> {
  const auth = input.sandboxAuth;
  const [run] = auth
    ? runRows.parse(yield readStatement(runSnapshotSql(auth), runRows.element))
    : [];
  const mount = auth ? lockedRunMount(run, input) : undefined;
  if (mount && "status" in mount) {
    return mount;
  }
  const [storage] = storageRows.parse(
    yield readStatement(
      storageSnapshotSql(
        mount
          ? storageIdentityCondition(mount)
          : eq(storages.id, input.storageId),
      ),
      storageRows.element,
    ),
  );
  if (!storage) {
    return notFound(auth ? "Writeback storage not found" : "Storage not found");
  }
  const [version] = versionRows.parse(
    yield readStatement(
      versionSnapshotSql(storageVersionCondition(storage.id, input.versionId)),
      versionRows.element,
    ),
  );
  return {
    storage,
    runStatus: run?.status,
    version,
  };
}

function* publishStorageCommit(
  input: CommitStorageForStorageInput,
  verification: VerifiedStorageCommit,
  initial: StorageRow,
  version: StorageVersionRow | undefined,
): StorageSqlPlan<{
  readonly size: number;
  readonly fileCount: number;
  readonly deduplicated: boolean;
}> {
  const [storage] = storageRows.parse(
    yield readStatement(
      storageSnapshotSql(storageIdentityCondition(initial), true),
      storageRows.element,
    ),
  );
  if (!storage) {
    throw new Error("Storage disappeared before HEAD publication");
  }
  const size = version ? Number(version.size) : totalSize(input.files);
  const fileCount = version?.fileCount ?? input.files.length;
  const values = committedVersionValues(input, verification);
  const [inserted] = version
    ? []
    : idRows.parse(
        yield readStatement(
          insertedStorageSql(storageVersions, values, true, storageVersions.id),
          idRows.element,
        ),
      );
  if (!version && !inserted) {
    const [conflict] = versionRows.parse(
      yield readStatement(
        versionSnapshotSql(eq(storageVersions.id, input.versionId)),
        versionRows.element,
      ),
    );
    assertVersionConflict(conflict, input, verification);
  }
  if (storage.headVersionId !== input.versionId) {
    const changedAt = yield* publicationTimestampPlan();
    const [published] = idRows.parse(
      yield readStatement(
        updatedStorageSql(
          storages,
          {
            headVersionId: input.versionId,
            size,
            fileCount,
            updatedAt: changedAt,
          },
          storageIdentityCondition(storage),
          storages.id,
        ),
        idRows.element,
      ),
    );
    requirePublicationRow(
      published,
      "Locked Storage HEAD could not be published",
    );
  }
  if (input.sandboxAuth && input.parentVersionId) {
    yield writeStatement(
      insertedStorageSql(storageVersionLineage, {
        storageId: storage.id,
        versionId: input.versionId,
        parentVersionId: input.parentVersionId,
        runId: input.sandboxAuth.runId,
      }),
    );
  }
  return { size, fileCount, deduplicated: !inserted };
}

function* enqueueStorageIndex(versionId: string): StorageSqlPlan<void> {
  const [version] = versionRows.parse(
    yield readStatement(
      versionSnapshotSql(eq(storageVersions.id, versionId)),
      versionRows.element,
    ),
  );
  const [value] = piResourceIndexQueueValues(
    [versionId],
    new Map(version ? [[version.id, version.archiveSize]] : []),
  );
  if (!value) {
    throw new Error("Missing Storage resource index work");
  }
  const [inserted] = idRows.parse(
    yield readStatement(
      insertedStorageSql(
        piResourceVersionIndexes,
        value,
        true,
        piResourceVersionIndexes.storageVersionId,
      ),
      idRows.element,
    ),
  );
  if (!inserted) {
    const repair = piResourceIndexRepairValues(
      value.sourceArchiveSize,
      yield* publicationTimestampPlan(),
    );
    yield writeStatement(
      updatedStorageSql(
        piResourceVersionIndexes,
        repair,
        piResourceIndexRepairCondition(
          value.storageVersionId,
          value.sourceArchiveSize,
        ),
      ),
    );
  }
}

export function* storageCommitPublicationPlan(
  input: CommitStorageForStorageInput,
  verification: VerifiedStorageCommit,
): StorageSqlPlan<CommitStorageResponse> {
  const admitted = yield* admitStorageCommit(input);
  if ("status" in admitted) {
    return admitted;
  }
  const { storage, version } = admitted;
  const terminal =
    admitted.runStatus !== undefined &&
    !sandboxStorageRunIsActive(admitted.runStatus);
  if (terminal) {
    const auth = input.sandboxAuth;
    if (
      !auth ||
      !input.parentVersionId ||
      !terminalCommitMatches(storage, version, input, verification)
    ) {
      return notFound("Active agent run not found");
    }
    const [lineage] = idRows.parse(
      yield readStatement(
        lineageSnapshotSql(
          storage.id,
          input,
          input.parentVersionId,
          auth.runId,
        ),
        idRows.element,
      ),
    );
    if (!lineage) {
      return notFound("Active agent run not found");
    }
  }
  const result = !terminal
    ? yield* publishStorageCommit(input, verification, storage, version)
    : {
        size: version ? Number(version.size) : totalSize(input.files),
        fileCount: version?.fileCount ?? input.files.length,
        deduplicated: true,
      };
  yield* enqueueStorageIndex(input.versionId);
  return storageCommitSuccess({
    storage,
    versionId: input.versionId,
    ...result,
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
    args.storage.headVersionId === args.input.versionId &&
    Number(args.storage.size) === size &&
    args.storage.fileCount === fileCount
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

function lockedRunMount(
  run: z.output<typeof runRows>[number] | undefined,
  input: CommitStorageForStorageInput,
) {
  if (!run) {
    return notFound("Agent run not found");
  }
  const mount = run.storageMounts?.find((entry) => {
    return entry.storageId === input.storageId && entry.writeback === true;
  });
  return mount
    ? { ...mount, id: mount.storageId }
    : notFound("Writeback storage not found");
}

function committedVersionValues(
  input: CommitStorageForStorageInput,
  verification: VerifiedStorageCommit,
) {
  return {
    id: input.versionId,
    storageId: input.storageId,
    s3Key: verification.s3Key,
    size: totalSize(input.files),
    archiveSize: verification.archiveSize,
    fileCount: input.files.length,
    message: input.message ?? null,
    createdBy: input.runId ? "agent" : "user",
  };
}

function assertVersionConflict(
  version: StorageVersionRow | undefined,
  input: CommitStorageForStorageInput,
  verification: VerifiedStorageCommit,
) {
  if (
    !version ||
    version.storageId !== input.storageId ||
    version.s3Key !== verification.s3Key ||
    Number(version.size) !== totalSize(input.files) ||
    version.fileCount !== input.files.length
  ) {
    throw new Error(
      `Storage version ${input.versionId} conflicts with committed metadata`,
    );
  }
}

function terminalCommitMatches(
  storage: StorageRow,
  version: StorageVersionRow | undefined,
  input: CommitStorageForStorageInput,
  verification: VerifiedStorageCommit,
) {
  return (
    terminalStorageCommitPersistedStateMatches({ storage, version, input }) &&
    version !== undefined &&
    version.s3Key === verification.s3Key &&
    version.archiveSize === verification.archiveSize
  );
}

function requirePublicationRow(row: unknown, message: string) {
  if (!row) {
    throw new Error(message);
  }
}
