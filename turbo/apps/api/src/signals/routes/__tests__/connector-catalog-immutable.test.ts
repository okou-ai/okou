/* eslint-disable no-restricted-imports, api/no-package-variable, api/no-test-vi-mocks -- Standalone N1-N5 lifecycle fixtures own PGlite and mock only the existing realtime external boundary; the real-database test context is intentionally not loaded (target-state v5). */
/* oxlint-disable vitest/warn-todo -- N1/N4/N5 belong to the later pointer/reader stages, not P3. */
/* oxlint-disable vitest/prefer-to-be-truthy, vitest/prefer-to-be-falsy, jest/prefer-to-be -- CAS results require strict boolean equality rather than truthiness (target-state v5 lifecycle-file exception only). */
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/schema/connector-catalog";
import { connectorCatalogArtifactSchema } from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { SYSTEM_ORG_ID, VOLUME_ORG_USER_ID } from "@okouai/core/storage-names";
import { API_TEST_CONNECTOR_CATALOG_ARTIFACT } from "../../../test-fixtures/connector-catalog-artifact";
import {
  activateImmutableCatalog,
  prepareImmutableCatalogEntries,
  readImmutableCatalogHash,
  ImmutableCatalogActivationConflict,
} from "../../services/connector-catalog-immutable.service";
import {
  prepareConnectorCatalogSkills,
  registerPreparedConnectorCatalogSkills,
} from "../../services/connector-catalog-skill-registration.service";
import { readStorageBaseIndex } from "../../services/storage-index.service";
import { publishCatalogRuntimeWakeups } from "../../services/connector-catalog-sync.service";
import { publishConnectorRuntimeSyncBatch } from "../../external/realtime";

vi.mock("../../external/realtime", async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import("../../external/realtime")>()),
    publishConnectorRuntimeSyncBatch:
      vi.fn<typeof publishConnectorRuntimeSyncBatch>(),
  };
});

let postgres: PGlite | undefined;

async function migration(name: string) {
  return await readFile(
    new URL(
      `../../../../../../packages/db/src/migrations/${name}`,
      import.meta.url,
    ),
    "utf8",
  );
}

beforeEach(async () => {
  vi.mocked(publishConnectorRuntimeSyncBatch).mockReset();
  postgres = new PGlite();
  await postgres.exec(await migration("1319_fair_doctor_spectrum.sql"));
  // Use the historical owning DDL, selecting only tables required by this
  // isolated lifecycle. Their unrelated owner FKs are outside this database.
  const baseline = await migration("1078_baseline.sql");
  for (const name of [
    "storages",
    "storage_versions",
    "system_storage_presigned_url_cache",
    "connectors",
    "org_custom_connectors",
    "org_custom_connector_oauth_configs",
    "agent_sessions",
    "agent_runs",
  ]) {
    const statement = baseline.match(
      new RegExp(`CREATE TABLE public\\.${name} \\([\\s\\S]*?\\n\\);`),
    )?.[0];
    if (!statement) {
      throw new Error(`Missing owning migration for ${name}`);
    }
    await postgres.exec(statement);
  }
  await postgres.exec(
    `ALTER TABLE storages ADD PRIMARY KEY (id); ALTER TABLE storages ADD UNIQUE (org_id, user_id, name); ALTER TABLE storage_versions ADD PRIMARY KEY (id);`,
  );
  await postgres.exec(await migration("1114_pi_resource_version_indexes.sql"));
  const pi = await migration("1168_unique_skrulls.sql");
  for (const name of [
    "pi_stable_context_generations",
    "pi_stable_context_heads",
  ]) {
    const statement = pi.match(
      new RegExp(`CREATE TABLE "${name}" \\([\\s\\S]*?\\n\\);`),
    )?.[0];
    if (!statement) {
      throw new Error(`Missing owning migration for ${name}`);
    }
    await postgres.exec(statement);
  }
});

afterEach(async () => {
  await postgres?.close();
  postgres = undefined;
});

function catalogMechanismDatabase() {
  if (!postgres) {
    throw new Error("Catalog mechanism database is not initialized");
  }
  return drizzle(postgres, {
    schema: { connectorCatalog, connectorCatalogEntries },
  });
}

function candidate(version: string) {
  const artifact = connectorCatalogArtifactSchema.parse(
    structuredClone(API_TEST_CONNECTOR_CATALOG_ARTIFACT),
  );
  artifact.catalogVersion = version;
  const hash = createHash("sha256")
    .update(JSON.stringify(artifact))
    .digest("hex");
  return { artifact, hash };
}

async function prepare(next: ReturnType<typeof candidate>) {
  const db = catalogMechanismDatabase();
  const signal = new AbortController().signal;
  const registrations = await prepareConnectorCatalogSkills(
    { db, artifact: next.artifact },
    signal,
  );
  await registerPreparedConnectorCatalogSkills({ db, registrations }, signal);
  await prepareImmutableCatalogEntries({ db, ...next }, signal);
}

async function activate(
  next: ReturnType<typeof candidate>,
  baselineHash: string | null,
) {
  const db = catalogMechanismDatabase();
  return await db.transaction(async (tx) => {
    return await activateImmutableCatalog(
      {
        db: tx,
        ...next,
        baselineHash,
        activatedAt: new Date("2099-01-01T00:00:00Z"),
        catalogSourceId: null,
      },
      new AbortController().signal,
    );
  });
}

// This observable query is the future reader's specified current-hash join;
// production readers remain on the old tables until P4.
async function currentSlugs() {
  const db = catalogMechanismDatabase();
  return await db
    .select({
      slug: connectorCatalogEntries.slug,
      hash: connectorCatalogEntries.hash,
    })
    .from(connectorCatalogEntries)
    .innerJoin(
      connectorCatalog,
      eq(connectorCatalog.hash, connectorCatalogEntries.hash),
    );
}

describe("immutable connector catalog lifecycle", () => {
  it.todo("n1: rejects downloaded bytes whose hash differs from the pointer");
  it("n2: prepares before activation, resumes partial preparation, and mounts exact skills with null HEAD", async () => {
    const previous = candidate("2099-01-01.previous");
    const next = candidate("2099-01-01.next");
    await prepare(previous);
    await activate(previous, null);
    const blocked = next.artifact.connectors[1];
    if (!blocked || !postgres) {
      throw new Error("Missing preparation fixture");
    }
    // A real database constraint fails after at least one immutable insert.
    await postgres.query(
      "ALTER TABLE connector_catalog_entries ADD CONSTRAINT preparation_failure CHECK (hash <> '" +
        next.hash +
        "' OR slug <> '" +
        blocked.slug +
        "')",
    );
    await expect(prepare(next)).rejects.toMatchObject({
      cause: { code: "23514", constraint: "preparation_failure" },
    });
    expect(
      (await currentSlugs()).every((row) => {
        return row.hash === previous.hash;
      }),
    ).toStrictEqual(true);
    await expect(
      readImmutableCatalogHash(catalogMechanismDatabase(), 4),
    ).resolves.toBe(previous.hash);
    const partial = await catalogMechanismDatabase()
      .select()
      .from(connectorCatalogEntries)
      .where(eq(connectorCatalogEntries.hash, next.hash));
    expect(partial).toHaveLength(1);
    await postgres.exec(
      "ALTER TABLE connector_catalog_entries DROP CONSTRAINT preparation_failure",
    );
    await prepare(next);
    await expect(activate(next, previous.hash)).resolves.toStrictEqual(true);
    const visible = await currentSlugs();
    expect(
      visible
        .map((row) => {
          return row.slug;
        })
        .sort(),
    ).toStrictEqual(
      next.artifact.connectors
        .map((row) => {
          return row.slug;
        })
        .sort(),
    );
    expect(
      visible.every((row) => {
        return row.hash === next.hash;
      }),
    ).toStrictEqual(true);
    await prepare(next);
    await expect(activate(next, next.hash)).resolves.toStrictEqual(false);
    const skill = next.artifact.connectors.flatMap((entry) => {
      return entry.skill.kind === "bundled" ? [entry.skill] : [];
    })[0];
    if (!skill) {
      throw new Error("Fixed catalog must contain a bundled skill");
    }
    const index = await readStorageBaseIndex(catalogMechanismDatabase(), [
      {
        lookup: {
          orgId: SYSTEM_ORG_ID,
          userId: VOLUME_ORG_USER_ID,
          name: skill.storageName,
        },
        version: skill.versionId,
      },
    ]);
    const mounted = [...index.values()][0];
    expect(mounted?.headVersionId).toBeNull();
    expect(mounted?.exactVersions.get(skill.versionId)).toMatchObject({
      id: skill.versionId,
      s3Key: skill.storageVersionPrefix,
    });
  });

  it("n2: rejects conflicting bytes and an extra persisted slug without switching", async () => {
    const previous = candidate("2099-01-01.conflict-previous");
    const next = candidate("2099-01-01.conflict-next");
    await prepare(previous);
    await activate(previous, null);
    const entry = next.artifact.connectors[0];
    if (!entry || !postgres) {
      throw new Error("Missing conflict fixture");
    }
    const corrupted = { ...entry, label: "Conflicting original payload" };
    await catalogMechanismDatabase()
      .insert(connectorCatalogEntries)
      .values({ hash: next.hash, slug: entry.slug, payload: corrupted });
    await expect(prepare(next)).rejects.toThrow("entry content conflicts");
    await expect(
      readImmutableCatalogHash(catalogMechanismDatabase(), 4),
    ).resolves.toBe(previous.hash);
    const stored = await catalogMechanismDatabase()
      .select()
      .from(connectorCatalogEntries)
      .where(eq(connectorCatalogEntries.hash, next.hash));
    expect(
      stored.map((row) => {
        return row.payload;
      }),
    ).toStrictEqual([corrupted]);
    await postgres.query(
      "DELETE FROM connector_catalog_entries WHERE hash = $1",
      [next.hash],
    );
    await prepare(next);
    await catalogMechanismDatabase()
      .insert(connectorCatalogEntries)
      .values({ hash: next.hash, slug: "unexpected-slug", payload: entry });
    await expect(prepare(next)).rejects.toThrow(
      "entry manifest does not match",
    );
    await expect(
      readImmutableCatalogHash(catalogMechanismDatabase(), 4),
    ).resolves.toBe(previous.hash);
  });

  it("n2: preserves an existing skill HEAD while preparing a new exact version", async () => {
    const previous = candidate("2099-01-01.head-previous");
    await prepare(previous);
    const skill = previous.artifact.connectors.flatMap((entry) => {
      return entry.skill.kind === "bundled" ? [entry.skill] : [];
    })[0];
    if (!skill || !postgres) {
      throw new Error("Missing bundled skill fixture");
    }
    await postgres.query(
      "UPDATE storages SET head_version_id = $1 WHERE name = $2",
      [skill.versionId, skill.storageName],
    );
    const next = candidate("2099-01-01.head-next");
    const nextSkill = next.artifact.connectors.find((entry) => {
      return entry.skill.kind === "bundled";
    })?.skill;
    if (!nextSkill || nextSkill.kind !== "bundled") {
      throw new Error("Missing next skill fixture");
    }
    nextSkill.versionId = "d".repeat(64);
    nextSkill.storageVersionPrefix =
      nextSkill.storageVersionPrefix.slice(0, -64) + nextSkill.versionId;
    next.hash = createHash("sha256")
      .update(JSON.stringify(next.artifact))
      .digest("hex");
    await prepare(next);
    await prepare(next);
    expect(
      (
        await postgres.query(
          "SELECT head_version_id FROM storages WHERE name = $1",
          [skill.storageName],
        )
      ).rows,
    ).toStrictEqual([{ head_version_id: skill.versionId }]);
    const index = await readStorageBaseIndex(catalogMechanismDatabase(), [
      {
        lookup: {
          orgId: SYSTEM_ORG_ID,
          userId: VOLUME_ORG_USER_ID,
          name: skill.storageName,
        },
        version: nextSkill.versionId,
      },
    ]);
    expect(
      [...index.values()][0]?.exactVersions.get(nextSkill.versionId)?.id,
    ).toBe(nextSkill.versionId);
  });

  it("n3: cold insertion and same-baseline CAS have one winner and one transactional Pi invalidation", async () => {
    if (!postgres) {
      throw new Error("Missing lifecycle database");
    }
    const agentId = randomUUID();
    await postgres.query(
      "INSERT INTO pi_stable_context_generations (org_id, agent_id, subject) VALUES ('lifecycle', $1, '@agent')",
      [agentId],
    );
    await postgres.query(
      "INSERT INTO pi_stable_context_heads (org_id, user_id, agent_id, variant_digest, status, input, input_digest, artifact_digest) VALUES ('lifecycle', 'catalog-test', $1, $2, 'ready', '{}', $3, $4)",
      [agentId, "a".repeat(64), "b".repeat(64), "c".repeat(64)],
    );
    const first = candidate("2099-01-01.first");
    await prepare(first);
    await postgres.query(
      "INSERT INTO connectors (auth_method, user_id, org_id, storage_version, connector_slug) VALUES ('token', 'catalog-test', 'lifecycle', 1, $1)",
      [first.artifact.connectors[0]?.slug],
    );
    const sessionId = randomUUID();
    const runId = randomUUID();
    await postgres.query(
      "INSERT INTO agent_sessions (id, user_id, org_id, agent_id) VALUES ($1, 'catalog-test', 'lifecycle', $2)",
      [sessionId, agentId],
    );
    await postgres.query(
      "INSERT INTO agent_runs (id, status, prompt, user_id, org_id, runner_group, session_id) VALUES ($1, 'running', 'catalog lifecycle', 'catalog-test', 'lifecycle', 'catalog-n3', $2)",
      [runId, sessionId],
    );
    const attemptedAfterCommit: string[] = [];
    vi.mocked(publishConnectorRuntimeSyncBatch).mockImplementation(
      async (group, messages) => {
        expect(group).toBe("catalog-n3");
        expect(messages).toHaveLength(1);
        expect(messages[0]?.name).toBe("connector-runtime-sync");
        expect(JSON.parse(String(messages[0]?.data))).toStrictEqual({
          runId,
          target: {
            kind: "builtin",
            connectorSlug: first.artifact.connectors[0]?.slug,
          },
        });
        const visibleHash = await readImmutableCatalogHash(
          catalogMechanismDatabase(),
          4,
        );
        if (!visibleHash) {
          throw new Error("Wakeup preceded catalog commit");
        }
        attemptedAfterCommit.push(visibleHash);
      },
    );
    async function commitAndWake(
      next: ReturnType<typeof candidate>,
      baselineHash: string | null,
    ) {
      const switched = await activate(next, baselineHash);
      await publishCatalogRuntimeWakeups({
        db: catalogMechanismDatabase(),
        switched,
        currentArtifact: next.artifact,
        previousSnapshot: undefined,
      });
      return switched;
    }
    const cold = await Promise.allSettled([
      commitAndWake(first, null),
      commitAndWake(first, null),
    ]);
    expect(
      cold.filter((result) => {
        return result.status === "fulfilled" && result.value;
      }),
    ).toHaveLength(1);
    expect(
      cold.filter((result) => {
        return (
          result.status === "rejected" &&
          result.reason instanceof ImmutableCatalogActivationConflict
        );
      }),
    ).toHaveLength(1);
    expect(
      (
        await postgres.query<{ generation: number }>(
          "SELECT generation FROM pi_stable_context_generations",
        )
      ).rows,
    ).toStrictEqual([{ generation: 2 }]);
    const second = candidate("2099-01-01.second");
    const third = candidate("2099-01-01.third");
    await prepare(second);
    await prepare(third);
    expect(attemptedAfterCommit).toStrictEqual([first.hash]);
    const competing = await Promise.allSettled([
      commitAndWake(second, first.hash),
      commitAndWake(third, first.hash),
    ]);
    expect(
      competing.filter((result) => {
        return result.status === "fulfilled" && result.value;
      }),
    ).toHaveLength(1);
    expect(
      competing.filter((result) => {
        return (
          result.status === "rejected" &&
          result.reason instanceof ImmutableCatalogActivationConflict
        );
      }),
    ).toHaveLength(1);
    expect(
      (
        await postgres.query<{ generation: number }>(
          "SELECT generation FROM pi_stable_context_generations",
        )
      ).rows,
    ).toStrictEqual([{ generation: 3 }]);
    const winnerHash = await readImmutableCatalogHash(
      catalogMechanismDatabase(),
      4,
    );
    expect([second.hash, third.hash]).toContain(winnerHash);
    expect(attemptedAfterCommit).toStrictEqual([first.hash, winnerHash]);
    await publishCatalogRuntimeWakeups({
      db: catalogMechanismDatabase(),
      switched: false,
      currentArtifact: first.artifact,
      previousSnapshot: undefined,
    });
    expect(publishConnectorRuntimeSyncBatch).toHaveBeenCalledTimes(2);
    expect(
      (
        await postgres.query(
          "SELECT status, generation, artifact_digest FROM pi_stable_context_heads",
        )
      ).rows,
    ).toStrictEqual([
      { status: "missing", generation: 3, artifact_digest: null },
    ]);
    const winner = winnerHash === second.hash ? second : third;
    await expect(commitAndWake(winner, winner.hash)).resolves.toStrictEqual(
      false,
    );
    expect(publishConnectorRuntimeSyncBatch).toHaveBeenCalledTimes(2);
    const last = candidate("2099-01-01.last");
    await prepare(last);
    await postgres.exec(
      "ALTER TABLE pi_stable_context_heads ADD CONSTRAINT invalidation_failure CHECK (generation <= 3)",
    );
    await expect(commitAndWake(last, winner.hash)).rejects.toMatchObject({
      cause: { code: "23514", constraint: "invalidation_failure" },
    });
    await expect(
      readImmutableCatalogHash(catalogMechanismDatabase(), 4),
    ).resolves.toBe(winner.hash);
    expect(
      (
        await postgres.query(
          "SELECT generation FROM pi_stable_context_generations",
        )
      ).rows,
    ).toStrictEqual([{ generation: 3 }]);
    expect(publishConnectorRuntimeSyncBatch).toHaveBeenCalledTimes(2);
    await postgres.exec(
      "ALTER TABLE pi_stable_context_heads DROP CONSTRAINT invalidation_failure",
    );
    vi.mocked(publishConnectorRuntimeSyncBatch).mockRejectedValueOnce(
      new Error("Best-effort wakeup unavailable"),
    );
    await expect(commitAndWake(last, winner.hash)).resolves.toStrictEqual(true);
    await expect(
      readImmutableCatalogHash(catalogMechanismDatabase(), 4),
    ).resolves.toBe(last.hash);
    expect(publishConnectorRuntimeSyncBatch).toHaveBeenCalledTimes(3);
    expect(
      (await currentSlugs()).every((row) => {
        return row.hash === last.hash;
      }),
    ).toStrictEqual(true);
  });
  it.todo(
    "n4: reads the old immutable entries after switching back to their hash",
  );
  it.todo(
    "n5: distinguishes unknown slugs from missing entries without fallback",
  );
});
