import { createHash, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { createClerkClient } from "@clerk/backend";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { memorySummaryProjections } from "../../../src/schema/memory-summary-projection";
import { piResourceVersionIndexes } from "../../../src/schema/pi-resource-version-index";
import { storages, storageVersions } from "../../../src/schema/storage";

// This permanent migration freezes the empty-memory format and extractor v1.
// Do not import the evolving API initialization service into this record.
const emptyProjection = { schemaVersion: 1 as const, files: [] };
const emptyProjectionHash = createHash("sha256")
  .update(JSON.stringify(emptyProjection))
  .digest("hex");
type Database = ReturnType<typeof drizzle>;

async function initializeMemory(db: Database, orgId: string, userId: string) {
  await db.transaction(async (tx) => {
    const storageId = randomUUID();
    await tx
      .insert(storages)
      .values({
        id: storageId,
        orgId,
        userId,
        name: "memory",
        s3Prefix: `${orgId}/${storageId}`,
      })
      .onConflictDoNothing({
        target: [storages.orgId, storages.userId, storages.name],
      });
    const [storage] = await tx
      .select({
        id: storages.id,
        s3Prefix: storages.s3Prefix,
        head: storages.headVersionId,
      })
      .from(storages)
      .where(
        and(
          eq(storages.orgId, orgId),
          eq(storages.userId, userId),
          eq(storages.name, "memory"),
        ),
      )
      .limit(1)
      .for("update");
    if (!storage)
      throw new Error("Memory storage disappeared during initialization");
    if (storage.head !== null) return;
    const versionId = createHash("sha256")
      .update(`storage:${storage.id}\n`)
      .digest("hex");
    await tx
      .insert(storageVersions)
      .values({
        id: versionId,
        storageId: storage.id,
        s3Key: `${storage.s3Prefix}/${versionId}`,
        size: 0,
        archiveSize: 0,
        fileCount: 0,
        message: "Initial empty artifact",
        createdBy: userId,
      })
      .onConflictDoNothing();
    await tx
      .insert(piResourceVersionIndexes)
      .values({
        storageVersionId: versionId,
        extractorVersion: 1,
        status: "ready",
        projection: emptyProjection,
        projectionHash: emptyProjectionHash,
        sourceArchiveSize: 0,
      })
      .onConflictDoUpdate({
        target: [
          piResourceVersionIndexes.storageVersionId,
          piResourceVersionIndexes.extractorVersion,
        ],
        set: {
          status: "ready",
          projection: emptyProjection,
          projectionHash: emptyProjectionHash,
          sourceArchiveSize: 0,
          leaseId: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        },
      });
    await tx
      .insert(memorySummaryProjections)
      .values({
        memoryStorageId: storage.id,
        storageVersionId: versionId,
        orgId,
        userId,
      })
      .onConflictDoNothing();
    await tx
      .update(storages)
      .set({
        headVersionId: versionId,
        size: 0,
        fileCount: 0,
        updatedAt: new Date(),
      })
      .where(and(eq(storages.id, storage.id), isNull(storages.headVersionId)));
  });
}

async function memoryIsInitialized(
  db: Database,
  orgId: string,
  userId: string,
) {
  const [row] = await db
    .select({
      head: storages.headVersionId,
      versionStorageId: storageVersions.storageId,
      storageId: storages.id,
    })
    .from(storages)
    .leftJoin(storageVersions, eq(storageVersions.id, storages.headVersionId))
    .where(
      and(
        eq(storages.orgId, orgId),
        eq(storages.userId, userId),
        eq(storages.name, "memory"),
      ),
    )
    .limit(1);
  if (row?.head && row.versionStorageId !== row.storageId) {
    throw new Error(
      `Memory HEAD does not belong to its storage: ${row.storageId}`,
    );
  }
  return row?.head !== undefined && row.head !== null;
}

const { values } = parseArgs({
  options: {
    help: { type: "boolean", default: false },
    apply: { type: "boolean", default: false },
    "org-id": { type: "string" },
    offset: { type: "string", default: "0" },
    limit: { type: "string", default: "100" },
  },
  strict: true,
});
if (values.help) {
  console.log(
    "Usage: backfill.ts --org-id <Clerk organization ID> [--offset 0] [--limit 100] [--apply]\nDefault: read-only dry run of one authoritative membership page. Environment: DATABASE_URL, CLERK_SECRET_KEY.",
  );
} else {
  const orgId = values["org-id"];
  const offset = Number(values.offset);
  const limit = Number(values.limit);
  if (!orgId)
    throw new Error(
      "--org-id is required; there is no implicit all-organizations scope",
    );
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error("--offset must be a nonnegative integer");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error("--limit must be between 1 and 100");
  const connectionUrl = process.env.DATABASE_URL;
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!connectionUrl || !secretKey)
    throw new Error("DATABASE_URL and CLERK_SECRET_KEY are required");
  const clerk = createClerkClient({ secretKey });
  const page = await clerk.organizations.getOrganizationMembershipList({
    organizationId: orgId,
    offset,
    limit,
  });
  const connection = postgres(connectionUrl, { max: 1 });
  const db = drizzle(connection);
  try {
    let missing = 0;
    let initialized = 0;
    for (const member of page.data) {
      const userId = member.publicUserData?.userId;
      if (!userId)
        throw new Error("Clerk membership is missing its user identity");
      if (await memoryIsInitialized(db, orgId, userId)) continue;
      missing++;
      if (values.apply) {
        await initializeMemory(db, orgId, userId);
        if (!(await memoryIsInitialized(db, orgId, userId)))
          throw new Error("Memory initialization failed its readback");
        initialized++;
      }
    }
    console.log(
      JSON.stringify(
        {
          dryRun: !values.apply,
          orgId,
          offset,
          inspected: page.data.length,
          totalMemberships: page.totalCount,
          missing,
          initialized,
          nextOffset:
            offset + page.data.length < page.totalCount
              ? offset + page.data.length
              : null,
        },
        null,
        2,
      ),
    );
  } finally {
    await connection.end();
  }
}
