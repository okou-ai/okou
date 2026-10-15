import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import { agentRuns } from "../src/schema/agent-run";
import { storages, storageVersions } from "../src/schema/storage";
import { storageVersionLineage } from "../src/schema/storage-version-lineage";

/** Physical retention contract on replayed and freshly generated schemas. */
export async function validatePermanentStorageLineage(databaseUrl: string) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const db = drizzle(client);
  const owner = `lineage-owner-${randomUUID()}`;
  const orgId = `lineage-org-${randomUUID()}`;
  const runIds: [string, string] = [randomUUID(), randomUUID()];
  const storageValues = [
    { id: randomUUID(), orgId, userId: owner, name: "memory" },
    { id: randomUUID(), orgId, userId: "__org__", name: "shared" },
    { id: randomUUID(), orgId, userId: `${owner}-other`, name: "memory" },
    {
      id: randomUUID(),
      orgId: `${orgId}-other`,
      userId: "__org__",
      name: "shared",
    },
  ] as const;
  const storageIds = storageValues.map((storage) => {
    return storage.id;
  });
  try {
    const constraints = await client.query<{ name: string; deletion: string }>(`
      SELECT conname AS name, confdeltype AS deletion
      FROM pg_constraint
      WHERE conrelid = 'storage_version_lineage'::regclass AND contype = 'f'
    `);
    assert.deepEqual(constraints.rows, [
      {
        name: "storage_version_lineage_storage_id_storages_id_fk",
        deletion: "c",
      },
    ]);
    const column = await client.query<{ type: string; nullable: string }>(`
      SELECT data_type AS type, is_nullable AS nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'storage_version_lineage'
        AND column_name = 'run_id'
    `);
    assert.deepEqual(column.rows, [{ type: "uuid", nullable: "NO" }]);
    const index = await client.query<{ definition: string }>(`
      SELECT indexdef AS definition FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'storage_version_lineage'
        AND indexname = 'idx_storage_version_lineage_run'
    `);
    assert.equal(index.rows.length, 1);
    const runIndex = index.rows[0];
    assert.ok(runIndex);
    assert.match(runIndex.definition, /USING btree \(run_id\)/);

    await db.insert(agentRuns).values(
      runIds.map((id) => {
        return {
          id,
          orgId,
          userId: owner,
          status: "completed",
          prompt: "lineage producer",
        };
      }),
    );
    const createdStorages = await db
      .insert(storages)
      .values(
        storageValues.map((storage) => {
          return {
            ...storage,
            s3Prefix: `${storage.orgId}/${storage.id}`,
          };
        }),
      )
      .returning();
    const versions = await db
      .insert(storageVersions)
      .values(
        createdStorages.map((storage) => {
          return {
            id: randomUUID().replaceAll("-", ""),
            storageId: storage.id,
            s3Key: `${storage.s3Prefix}/archive.tar.gz`,
            archiveSize: 1,
            size: 1,
            fileCount: 1,
            createdBy: owner,
          };
        }),
      )
      .returning();
    for (const version of versions) {
      await db
        .update(storages)
        .set({ headVersionId: version.id, size: 1, fileCount: 1 })
        .where(eq(storages.id, version.storageId));
    }
    const lineage = await db
      .insert(storageVersionLineage)
      .values(
        versions.flatMap((version) => {
          return runIds.map((runId) => {
            return {
              storageId: version.storageId,
              versionId: version.id,
              parentVersionId: "0".repeat(64),
              runId,
            };
          });
        }),
      )
      .returning();
    const readLineage = () => {
      return db
        .select()
        .from(storageVersionLineage)
        .where(inArray(storageVersionLineage.storageId, storageIds))
        .orderBy(storageVersionLineage.id);
    };
    const readStorages = () => {
      return db
        .select()
        .from(storages)
        .where(inArray(storages.id, storageIds))
        .orderBy(storages.id);
    };
    const readVersions = () => {
      return db
        .select()
        .from(storageVersions)
        .where(inArray(storageVersions.storageId, storageIds))
        .orderBy(storageVersions.id);
    };
    const retainedLineage = await readLineage();
    const retainedStorages = await readStorages();
    const retainedVersions = await readVersions();

    assert.deepEqual(
      await db
        .delete(agentRuns)
        .where(eq(agentRuns.id, runIds[0]))
        .returning({ id: agentRuns.id }),
      [{ id: runIds[0] }],
    );
    assert.deepEqual(await readLineage(), retainedLineage);
    assert.deepEqual(await readStorages(), retainedStorages);
    assert.deepEqual(await readVersions(), retainedVersions);

    // Clerk user cleanup deletes the user's Runs and personally owned Storage.
    // A producer's identity does not own organization or another member's lineage.
    assert.deepEqual(
      await db
        .delete(agentRuns)
        .where(eq(agentRuns.userId, owner))
        .returning({ id: agentRuns.id }),
      [{ id: runIds[1] }],
    );
    await db.delete(storages).where(eq(storages.userId, owner));
    const personalId = storageValues[0].id;
    assert.deepEqual(
      await readLineage(),
      retainedLineage.filter((row) => {
        return row.storageId !== personalId;
      }),
    );
    assert.deepEqual(
      await readStorages(),
      retainedStorages.filter((row) => {
        return row.id !== personalId;
      }),
    );
    assert.deepEqual(
      await readVersions(),
      retainedVersions.filter((row) => {
        return row.storageId !== personalId;
      }),
    );
    assert.ok(
      (await readLineage()).every((row) => {
        return runIds.includes(row.runId);
      }),
    );
    assert.equal(lineage.length, 8);

    // Clerk organization cleanup deletes every Storage owned in that organization.
    await db.delete(storages).where(eq(storages.orgId, orgId));
    const unrelatedId = storageValues[3].id;
    assert.deepEqual(
      await readLineage(),
      retainedLineage.filter((row) => {
        return row.storageId === unrelatedId;
      }),
    );
    assert.deepEqual(
      await readStorages(),
      retainedStorages.filter((row) => {
        return row.id === unrelatedId;
      }),
    );
    assert.deepEqual(
      await readVersions(),
      retainedVersions.filter((row) => {
        return row.storageId === unrelatedId;
      }),
    );
    await db.delete(storages).where(eq(storages.id, unrelatedId));
    assert.deepEqual(await readLineage(), []);
    assert.deepEqual(await readVersions(), []);
    console.log(
      "Storage lineage retains opaque Run provenance and follows Storage deletion and ownership",
    );
  } finally {
    try {
      await db.delete(storages).where(inArray(storages.id, storageIds));
      await db.delete(agentRuns).where(inArray(agentRuns.id, runIds));
    } finally {
      await client.end();
    }
  }
}
