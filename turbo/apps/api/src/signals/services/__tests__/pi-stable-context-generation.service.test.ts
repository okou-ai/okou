import { randomUUID } from "node:crypto";

import type { PiStableContextBuildInput } from "@okouai/db/jsonb-contracts/pi-stable-context";
import { agents } from "@okouai/db/schema/agent";
import {
  piStableContextArtifactResources,
  piStableContextArtifacts,
  piStableContextGenerations,
  piStableContextHeads,
  piStableContextPublications,
} from "@okouai/db/schema/pi-stable-context";
import { piResourceVersionIndexes } from "@okouai/db/schema/pi-resource-version-index";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createStore } from "ccstate";

import { env } from "../../../lib/env";
import { createDeferredPromise } from "../../utils";
import {
  beginPiStableContextPublication,
  completePiStableContextPublication,
  enqueuePiStableContextStorageDemands,
  invalidatePiStableContext,
  invalidatePiStableContextsForUser,
  lockPiStableContextPublication,
  PI_STABLE_CONTEXT_AGENT_SUBJECT,
  retirePiStableContextPublication,
} from "../pi-stable-context-generation.service";
import { deleteClerkAgentLifecycleData } from "../agent-lifecycle.service";
import { lockCanonicalAgentMutation } from "../agent-mutation-lock.service";
import {
  executePiStableContextWork,
  preparePiStableContext,
} from "../pi-stable-context.service";

describe("Pi stable context generation fences", () => {
  const pool = new Pool({ connectionString: env("DATABASE_URL"), max: 4 });
  const db = drizzle(pool);
  const agentIds: string[] = [];
  const storageIds: string[] = [];

  afterEach(async () => {
    if (agentIds.length === 0) {
      return;
    }
    await db
      .delete(piStableContextHeads)
      .where(inArray(piStableContextHeads.agentId, agentIds));
    await db
      .delete(piStableContextArtifacts)
      .where(inArray(piStableContextArtifacts.agentId, agentIds));
    await db
      .delete(piStableContextPublications)
      .where(inArray(piStableContextPublications.agentId, agentIds));
    await db
      .delete(piStableContextGenerations)
      .where(inArray(piStableContextGenerations.agentId, agentIds));
  });

  afterAll(async () => {
    if (agentIds.length > 0) {
      await db
        .delete(piStableContextPublications)
        .where(inArray(piStableContextPublications.agentId, agentIds));
      await db
        .delete(piStableContextGenerations)
        .where(inArray(piStableContextGenerations.agentId, agentIds));
      await db.delete(agents).where(inArray(agents.id, agentIds));
    }
    if (storageIds.length > 0) {
      await db.delete(storages).where(inArray(storages.id, storageIds));
    }
    await pool.end();
  });

  async function seed(options?: { readonly ownedByOtherUser?: boolean }) {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const otherUserId = `user_${randomUUID()}`;
    const agentOwnerId = options?.ownedByOtherUser ? otherUserId : userId;
    const agentId = randomUUID();
    agentIds.push(agentId);
    await db.insert(agents).values({
      id: agentId,
      orgId,
      owner: agentOwnerId,
      name: `stable-${agentId.slice(0, 8)}`,
    });
    const owner = {
      orgId,
      userId,
      agentId,
      resourceOwner: { orgId, userId: agentOwnerId },
    };
    const input: PiStableContextBuildInput = {
      schemaVersion: 1,
      owner,
      source: {
        agentGeneration: 1,
        userGeneration: 1,
        catalogIdentity: null,
        featurePromptDigest: "feature",
        permissionDigest: "permission",
        connectorScopeDigest: "connector",
        validityHorizon: null,
        promptSchemaVersion: 1,
        runtimeSchemaVersion: 1,
        extractorVersion: 1,
      },
      prompt: {
        agentIdentity: "identity",
        executionLimit: "limit",
        tools: "tools",
      },
      storageMounts: [],
      persistedStorageMounts: [],
    };
    await invalidatePiStableContext(db, { orgId, agentId });
    await invalidatePiStableContext(db, { orgId, agentId, userId });
    await invalidatePiStableContext(db, {
      orgId,
      agentId,
      userId: otherUserId,
    });
    const [head] = await db
      .insert(piStableContextHeads)
      .values({
        orgId,
        userId,
        agentId,
        variantDigest: "a".repeat(64),
        agentGeneration: 1,
        userGeneration: 1,
        status: "pending",
        input,
        inputDigest: "b".repeat(64),
      })
      .returning({ id: piStableContextHeads.id });
    if (!head) {
      throw new Error("Expected stable-context head fixture");
    }
    return { orgId, userId, otherUserId, agentId, headId: head.id };
  }

  it("rolls invalidation back and fences stale multi-stage completion", async () => {
    const fixture = await seed();
    await expect(
      db.transaction(async (tx) => {
        await invalidatePiStableContext(tx, {
          orgId: fixture.orgId,
          agentId: fixture.agentId,
        });
        throw new Error("rollback fixture");
      }),
    ).rejects.toThrow("rollback fixture");

    const [afterRollback] = await db
      .select({
        generation: piStableContextGenerations.generation,
        state: piStableContextGenerations.publicationState,
      })
      .from(piStableContextGenerations)
      .where(
        and(
          eq(piStableContextGenerations.orgId, fixture.orgId),
          eq(piStableContextGenerations.agentId, fixture.agentId),
          eq(
            piStableContextGenerations.subject,
            PI_STABLE_CONTEXT_AGENT_SUBJECT,
          ),
        ),
      );
    expect(afterRollback).toStrictEqual({ generation: 1, state: "ready" });

    const first = await beginPiStableContextPublication(
      db,
      {
        orgId: fixture.orgId,
        agentId: fixture.agentId,
      },
      "workflow:first",
    );
    const second = await beginPiStableContextPublication(
      db,
      {
        orgId: fixture.orgId,
        agentId: fixture.agentId,
      },
      "workflow:first",
    );
    expect(second.generation).toBe(first.generation + 1);
    await expect(
      lockPiStableContextPublication(db, first),
    ).resolves.toBeFalsy();
    await expect(
      completePiStableContextPublication(db, first),
    ).resolves.toBeFalsy();
    await expect(
      lockPiStableContextPublication(db, second),
    ).resolves.toBeTruthy();
    await expect(
      completePiStableContextPublication(db, second),
    ).resolves.toBeTruthy();

    const [head] = await db
      .select({
        status: piStableContextHeads.status,
        input: piStableContextHeads.input,
        artifactDigest: piStableContextHeads.artifactDigest,
      })
      .from(piStableContextHeads)
      .where(eq(piStableContextHeads.id, fixture.headId));
    expect(head).toMatchObject({
      status: "pending",
      input: {
        source: { agentGeneration: second.generation, userGeneration: 1 },
      },
      artifactDigest: null,
    });

    await invalidatePiStableContextsForUser(db, {
      orgId: fixture.orgId,
      userId: fixture.userId,
    });
    const rows = await db
      .select({
        subject: piStableContextGenerations.subject,
        generation: piStableContextGenerations.generation,
      })
      .from(piStableContextGenerations)
      .where(
        and(
          eq(piStableContextGenerations.orgId, fixture.orgId),
          eq(piStableContextGenerations.agentId, fixture.agentId),
        ),
      );
    const generationBySubject = new Map(
      rows.map((row) => {
        return [row.subject, row.generation] as const;
      }),
    );
    expect(generationBySubject.get(fixture.userId)).toBe(2);
    expect(generationBySubject.get(fixture.otherUserId)).toBe(1);
    expect(generationBySubject.get(PI_STABLE_CONTEXT_AGENT_SUBJECT)).toBe(
      second.generation,
    );
  });

  it("keeps independent workflow publications pending until both complete", async () => {
    const fixture = await seed();
    const scope = { orgId: fixture.orgId, agentId: fixture.agentId };
    const first = await beginPiStableContextPublication(
      db,
      scope,
      "workflow:first",
    );
    const second = await beginPiStableContextPublication(
      db,
      scope,
      "workflow:second",
    );

    await db.transaction(async (tx) => {
      await expect(
        lockPiStableContextPublication(tx, first),
      ).resolves.toBeTruthy();
      await expect(
        completePiStableContextPublication(tx, first),
      ).resolves.toBeTruthy();
    });
    await expect(
      db
        .select({ state: piStableContextGenerations.publicationState })
        .from(piStableContextGenerations)
        .where(
          and(
            eq(piStableContextGenerations.orgId, fixture.orgId),
            eq(piStableContextGenerations.agentId, fixture.agentId),
            eq(
              piStableContextGenerations.subject,
              PI_STABLE_CONTEXT_AGENT_SUBJECT,
            ),
          ),
        ),
    ).resolves.toStrictEqual([{ state: "pending" }]);

    await db.transaction(async (tx) => {
      await expect(
        lockPiStableContextPublication(tx, second),
      ).resolves.toBeTruthy();
      await expect(
        completePiStableContextPublication(tx, second),
      ).resolves.toBeTruthy();
    });
    await expect(
      db
        .select({ state: piStableContextGenerations.publicationState })
        .from(piStableContextGenerations)
        .where(
          and(
            eq(piStableContextGenerations.orgId, fixture.orgId),
            eq(piStableContextGenerations.agentId, fixture.agentId),
            eq(
              piStableContextGenerations.subject,
              PI_STABLE_CONTEXT_AGENT_SUBJECT,
            ),
          ),
        ),
    ).resolves.toStrictEqual([{ state: "ready" }]);
  });

  it("retires an abandoned publication when its source is deleted", async () => {
    const fixture = await seed();
    const scope = { orgId: fixture.orgId, agentId: fixture.agentId };
    await beginPiStableContextPublication(db, scope, "workflow:deleted");
    await expect(
      retirePiStableContextPublication(db, scope, "workflow:deleted"),
    ).resolves.toBeTruthy();
    await expect(
      db
        .select({ state: piStableContextGenerations.publicationState })
        .from(piStableContextGenerations)
        .where(
          and(
            eq(piStableContextGenerations.orgId, fixture.orgId),
            eq(piStableContextGenerations.agentId, fixture.agentId),
            eq(
              piStableContextGenerations.subject,
              PI_STABLE_CONTEXT_AGENT_SUBJECT,
            ),
          ),
        ),
    ).resolves.toStrictEqual([{ state: "ready" }]);
  });

  it("coalesces concurrent first-run demand and reuses write-time worker output", async () => {
    const fixture = await seed();
    await db
      .delete(piStableContextHeads)
      .where(eq(piStableContextHeads.id, fixture.headId));
    let waitingRegistrations = 0;
    const registrationsReleased = createDeferredPromise<void>(
      AbortSignal.timeout(5000),
    );
    const args = {
      db,
      owner: {
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentId: fixture.agentId,
        resourceOwner: {
          orgId: fixture.orgId,
          userId: fixture.userId,
        },
      },
      variantDigest: "f".repeat(64),
      prompt: {
        agentIdentity: "identity",
        executionLimit: "limit",
        tools: "tools",
      },
      source: {
        catalogIdentity: null,
        featurePromptDigest: "feature",
        permissionDigest: "permission",
        connectorScopeDigest: "connector",
        validityHorizon: null,
        promptSchemaVersion: 1,
        runtimeSchemaVersion: 1,
      },
      mounts: [],
      persistedStorageMounts: [],
      eligible: true,
      checkedAt: new Date("2026-09-17T00:00:00.000Z"),
      beforeDemandRegistration: async () => {
        waitingRegistrations += 1;
        if (waitingRegistrations === 2) {
          registrationsReleased.resolve();
        }
        await registrationsReleased.promise;
      },
    } as const;

    const firstReads = await Promise.all(
      [createStore(), createStore()].map(async (store) => {
        return await store.get(
          preparePiStableContext(args, AbortSignal.timeout(5000)),
        );
      }),
    );
    expect(
      firstReads.map((read) => {
        return read.kind;
      }),
    ).toStrictEqual(["missing", "missing"]);
    await expect(
      db
        .select({ id: piStableContextHeads.id })
        .from(piStableContextHeads)
        .where(
          and(
            eq(piStableContextHeads.orgId, fixture.orgId),
            eq(piStableContextHeads.userId, fixture.userId),
            eq(piStableContextHeads.agentId, fixture.agentId),
            eq(piStableContextHeads.variantDigest, args.variantDigest),
          ),
        ),
    ).resolves.toHaveLength(1);

    const updatedArgs = {
      ...args,
      prompt: { ...args.prompt, agentIdentity: "updated identity" },
    } as const;
    await invalidatePiStableContext(
      db,
      { orgId: fixture.orgId, agentId: fixture.agentId },
      {
        transformInput(input) {
          return { ...input, prompt: updatedArgs.prompt };
        },
      },
    );
    await expect(
      executePiStableContextWork(db, AbortSignal.timeout(5000)),
    ).resolves.toMatchObject({ claimed: 1, ready: 1 });
    await expect(
      createStore().get(
        preparePiStableContext(updatedArgs, AbortSignal.timeout(5000)),
      ),
    ).resolves.toMatchObject({ kind: "ready", prompt: updatedArgs.prompt });
  });

  it("coalesces two Storage writes while aggregate demand is pending", async () => {
    const fixture = await seed();
    await db
      .delete(piStableContextHeads)
      .where(eq(piStableContextHeads.id, fixture.headId));
    const firstStorageId = randomUUID();
    const secondStorageId = randomUUID();
    storageIds.push(firstStorageId, secondStorageId);
    const firstV1 = randomUUID().replaceAll("-", "").repeat(2);
    const firstV2 = randomUUID().replaceAll("-", "").repeat(2);
    const secondV1 = randomUUID().replaceAll("-", "").repeat(2);
    const secondV2 = randomUUID().replaceAll("-", "").repeat(2);
    await db.insert(storages).values([
      {
        id: firstStorageId,
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: `first-${firstStorageId}`,
        s3Prefix: `test/pi-stable-context/${firstStorageId}`,
      },
      {
        id: secondStorageId,
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: `second-${secondStorageId}`,
        s3Prefix: `test/pi-stable-context/${secondStorageId}`,
      },
    ]);
    await db.insert(storageVersions).values(
      [
        [firstStorageId, firstV1],
        [firstStorageId, firstV2],
        [secondStorageId, secondV1],
        [secondStorageId, secondV2],
      ].map(([storageId, id]) => {
        if (!storageId || !id) {
          throw new Error("Expected exact Storage version fixture");
        }
        return {
          id,
          storageId,
          s3Key: `test/pi-stable-context/${storageId}/${id}`,
          archiveSize: 1,
          fileCount: 1,
          createdBy: fixture.userId,
        };
      }),
    );
    const mounts = [
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: `first-${firstStorageId}`,
        storageId: firstStorageId,
        versionId: firstV1,
        mountPath: "/home/user/workspace",
        archiveSize: 1,
        empty: true,
      },
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: `second-${secondStorageId}`,
        storageId: secondStorageId,
        versionId: secondV1,
        mountPath: "/home/user/workspace",
        archiveSize: 1,
        empty: true,
      },
    ] as const;
    const persistedStorageMounts = mounts.map((mount) => {
      return {
        orgId: mount.orgId,
        userId: mount.userId,
        name: mount.name,
        storageId: mount.storageId,
        version: mount.versionId,
        mountPath: mount.mountPath,
      };
    });
    await createStore().get(
      preparePiStableContext(
        {
          db,
          owner: {
            orgId: fixture.orgId,
            userId: fixture.userId,
            agentId: fixture.agentId,
            resourceOwner: {
              orgId: fixture.orgId,
              userId: fixture.userId,
            },
          },
          variantDigest: "7".repeat(64),
          prompt: {
            agentIdentity: "storage identity",
            executionLimit: "storage limit",
            tools: "storage tools",
          },
          source: {
            catalogIdentity: null,
            featurePromptDigest: "storage-feature",
            permissionDigest: "storage-permission",
            connectorScopeDigest: "storage-connector",
            validityHorizon: null,
            promptSchemaVersion: 1,
            runtimeSchemaVersion: 1,
          },
          mounts,
          persistedStorageMounts,
          eligible: true,
          checkedAt: new Date("2026-09-17T00:00:00.000Z"),
        },
        AbortSignal.timeout(5000),
      ),
    );
    await enqueuePiStableContextStorageDemands(db, {
      storageId: firstStorageId,
      versionId: firstV2,
      archiveSize: 2,
      fileCount: 1,
    });
    await enqueuePiStableContextStorageDemands(db, {
      storageId: secondStorageId,
      versionId: secondV2,
      archiveSize: 2,
      fileCount: 1,
    });
    const [pending] = await db
      .select({ input: piStableContextHeads.input })
      .from(piStableContextHeads)
      .where(eq(piStableContextHeads.variantDigest, "7".repeat(64)));
    expect(
      pending?.input?.storageMounts.map((mount) => {
        return {
          storageId: mount.storageId,
          versionId: mount.versionId,
          empty: mount.empty,
        };
      }),
    ).toStrictEqual([
      { storageId: firstStorageId, versionId: firstV2, empty: undefined },
      { storageId: secondStorageId, versionId: secondV2, empty: undefined },
    ]);
  });

  it("recovers expired leases and terminally fails an exhausted lease", async () => {
    const fixture = await seed();
    await db
      .delete(piStableContextHeads)
      .where(eq(piStableContextHeads.id, fixture.headId));
    const args = {
      db,
      owner: {
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentId: fixture.agentId,
        resourceOwner: {
          orgId: fixture.orgId,
          userId: fixture.userId,
        },
      },
      variantDigest: "e".repeat(64),
      prompt: {
        agentIdentity: "lease identity",
        executionLimit: "lease limit",
        tools: "lease tools",
      },
      source: {
        catalogIdentity: null,
        featurePromptDigest: "feature-lease",
        permissionDigest: "permission-lease",
        connectorScopeDigest: "connector-lease",
        validityHorizon: null,
        promptSchemaVersion: 1,
        runtimeSchemaVersion: 1,
      },
      mounts: [],
      persistedStorageMounts: [],
      eligible: true,
      checkedAt: new Date("2026-09-17T00:00:00.000Z"),
    } as const;
    await createStore().get(
      preparePiStableContext(args, AbortSignal.timeout(5000)),
    );
    const [head] = await db
      .select({ id: piStableContextHeads.id })
      .from(piStableContextHeads)
      .where(eq(piStableContextHeads.agentId, fixture.agentId));
    if (!head) {
      throw new Error("Expected a registered lease-recovery head");
    }
    await db
      .update(piStableContextHeads)
      .set({
        status: "running",
        artifactDigest: null,
        leaseId: randomUUID(),
        leaseExpiresAt: new Date(0),
        attemptCount: 1,
      })
      .where(eq(piStableContextHeads.id, head.id));
    await expect(
      executePiStableContextWork(db, AbortSignal.timeout(5000)),
    ).resolves.toMatchObject({ claimed: 1, ready: 1 });

    await invalidatePiStableContext(db, {
      orgId: fixture.orgId,
      agentId: fixture.agentId,
    });
    await db
      .update(piStableContextHeads)
      .set({
        status: "running",
        leaseId: randomUUID(),
        leaseExpiresAt: new Date(0),
        attemptCount: 5,
      })
      .where(eq(piStableContextHeads.id, head.id));
    await expect(
      executePiStableContextWork(db, AbortSignal.timeout(5000)),
    ).resolves.toMatchObject({ claimed: 0, ready: 0 });
    await expect(
      db
        .select({
          status: piStableContextHeads.status,
          leaseId: piStableContextHeads.leaseId,
          lastErrorClass: piStableContextHeads.lastErrorClass,
        })
        .from(piStableContextHeads)
        .where(eq(piStableContextHeads.id, head.id))
        .then(([row]) => {
          return row;
        }),
    ).resolves.toStrictEqual({
      status: "failed",
      leaseId: null,
      lastErrorClass: "lease_expired_exhausted",
    });
  });

  it("uses Agent-before-head ordering when publication overlaps a source write", async () => {
    const fixture = await seed();
    const barrierSignal = AbortSignal.timeout(5000);
    const sourceLocked = createDeferredPromise<void>(barrierSignal);
    const releaseSource = createDeferredPromise<void>(barrierSignal);
    const publisherEntered = createDeferredPromise<void>(barrierSignal);
    const sourceWrite = db.transaction(async (tx) => {
      await lockCanonicalAgentMutation(tx, fixture.agentId);
      await tx
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, fixture.agentId))
        .for("update");
      sourceLocked.resolve();
      await releaseSource.promise;
      await invalidatePiStableContext(tx, {
        orgId: fixture.orgId,
        agentId: fixture.agentId,
      });
    });
    await sourceLocked.promise;
    const publication = executePiStableContextWork(db, barrierSignal, {
      beforePublish: () => {
        publisherEntered.resolve();
        return publisherEntered.promise;
      },
      scope: { headIds: [fixture.headId] },
    });
    await publisherEntered.promise;
    releaseSource.resolve();
    await expect(sourceWrite).resolves.toBeUndefined();
    await expect(publication).resolves.toMatchObject({ claimed: 1, stale: 1 });
  });

  it("does not register first demand after user erasure removed its authority", async () => {
    const fixture = await seed({ ownedByOtherUser: true });
    const barrierSignal = AbortSignal.timeout(5000);
    const registrationEntered = createDeferredPromise<void>(barrierSignal);
    const registrationReleased = createDeferredPromise<void>(barrierSignal);
    const preparation = createStore().get(
      preparePiStableContext(
        {
          db,
          owner: {
            orgId: fixture.orgId,
            userId: fixture.userId,
            agentId: fixture.agentId,
            resourceOwner: {
              orgId: fixture.orgId,
              userId: fixture.otherUserId,
            },
          },
          variantDigest: "8".repeat(64),
          prompt: {
            agentIdentity: "erased identity",
            executionLimit: "erased limit",
            tools: "erased tools",
          },
          source: {
            catalogIdentity: null,
            featurePromptDigest: "erased-feature",
            permissionDigest: "erased-permission",
            connectorScopeDigest: "erased-connector",
            validityHorizon: null,
            promptSchemaVersion: 1,
            runtimeSchemaVersion: 1,
          },
          mounts: [],
          persistedStorageMounts: [],
          eligible: true,
          checkedAt: new Date("2026-09-17T00:00:00.000Z"),
          beforeDemandRegistration: async () => {
            registrationEntered.resolve();
            await registrationReleased.promise;
          },
        },
        barrierSignal,
      ),
    );
    await registrationEntered.promise;
    await deleteClerkAgentLifecycleData(db, {
      kind: "user",
      userId: fixture.userId,
    });
    registrationReleased.resolve();
    await expect(preparation).resolves.toMatchObject({ kind: "missing" });
    await expect(
      db
        .select({ id: piStableContextHeads.id })
        .from(piStableContextHeads)
        .where(eq(piStableContextHeads.userId, fixture.userId)),
    ).resolves.toHaveLength(0);
    await expect(
      db
        .select({ digest: piStableContextArtifacts.digest })
        .from(piStableContextArtifacts)
        .where(eq(piStableContextArtifacts.userId, fixture.userId)),
    ).resolves.toHaveLength(0);
  });

  it("does not recreate an artifact after user erasure wins a claimed build", async () => {
    const fixture = await seed({ ownedByOtherUser: true });
    await db
      .delete(piStableContextHeads)
      .where(eq(piStableContextHeads.id, fixture.headId));
    const args = {
      db,
      owner: {
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentId: fixture.agentId,
        resourceOwner: {
          orgId: fixture.orgId,
          userId: fixture.otherUserId,
        },
      },
      variantDigest: "9".repeat(64),
      prompt: {
        agentIdentity: "identity",
        executionLimit: "limit",
        tools: "tools",
      },
      source: {
        catalogIdentity: null,
        featurePromptDigest: "feature",
        permissionDigest: "permission",
        connectorScopeDigest: "connector",
        validityHorizon: null,
        promptSchemaVersion: 1,
        runtimeSchemaVersion: 1,
      },
      mounts: [],
      persistedStorageMounts: [],
      eligible: true,
      checkedAt: new Date("2026-09-17T00:00:00.000Z"),
    } as const;
    await createStore().get(
      preparePiStableContext(args, AbortSignal.timeout(5000)),
    );
    await invalidatePiStableContext(db, {
      orgId: fixture.orgId,
      agentId: fixture.agentId,
      userId: fixture.userId,
    });

    const barrierSignal = AbortSignal.timeout(5000);
    const buildEntered = createDeferredPromise<void>(barrierSignal);
    const buildReleased = createDeferredPromise<void>(barrierSignal);
    const work = executePiStableContextWork(db, AbortSignal.timeout(5000), {
      beforePublish: async () => {
        buildEntered.resolve();
        await buildReleased.promise;
      },
    });
    await buildEntered.promise;
    await deleteClerkAgentLifecycleData(db, {
      kind: "user",
      userId: fixture.userId,
    });
    buildReleased.resolve();
    await expect(work).resolves.toMatchObject({ claimed: 1, stale: 1 });
    await expect(
      db
        .select({ digest: piStableContextArtifacts.digest })
        .from(piStableContextArtifacts)
        .where(eq(piStableContextArtifacts.userId, fixture.userId)),
    ).resolves.toHaveLength(0);
  });

  it("reuses one cold-process aggregate without resource indexes and binds memory separately", async () => {
    const fixture = await seed();
    const storageId = randomUUID();
    const versionId = randomUUID().replaceAll("-", "").repeat(2);
    storageIds.push(storageId);
    await db.insert(storages).values({
      id: storageId,
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: `empty-${storageId}`,
      s3Prefix: `test/pi-stable-context/${storageId}`,
    });
    await db.insert(storageVersions).values({
      id: versionId,
      storageId,
      s3Key: `test/pi-stable-context/${storageId}/${versionId}`,
      archiveSize: 0,
      fileCount: 0,
      createdBy: fixture.userId,
    });
    const mounts = Array.from({ length: 32 }, (_, index) => {
      return {
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: `empty-${index}`,
        storageId,
        versionId,
        mountPath: "/home/oai/share",
        archiveSize: 0,
        empty: true as const,
      };
    });
    const persistedStorageMounts = mounts.map((mount) => {
      return {
        orgId: mount.orgId,
        userId: mount.userId,
        name: mount.name,
        storageId: mount.storageId,
        version: mount.versionId,
        mountPath: mount.mountPath,
      };
    });
    const args = {
      db,
      owner: {
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentId: fixture.agentId,
        resourceOwner: {
          orgId: fixture.orgId,
          userId: fixture.userId,
        },
      },
      variantDigest: "c".repeat(64),
      prompt: {
        agentIdentity: "identity",
        executionLimit: "limit",
        tools: "tools",
      },
      source: {
        catalogIdentity: null,
        featurePromptDigest: "feature",
        permissionDigest: "permission",
        connectorScopeDigest: "connector",
        validityHorizon: "2026-09-19T00:00:00.000Z",
        promptSchemaVersion: 1,
        runtimeSchemaVersion: 1,
      },
      mounts,
      persistedStorageMounts,
      eligible: true,
      checkedAt: new Date("2026-09-17T00:00:00.000Z"),
    } as const;
    const first = await createStore().get(
      preparePiStableContext(args, AbortSignal.timeout(5000)),
    );
    const second = await createStore().get(
      preparePiStableContext(
        {
          ...args,
          memoryRecall: {
            status: "no-content",
            memoryStorageId: randomUUID(),
            storageVersionId: "d".repeat(64),
          },
        },
        AbortSignal.timeout(5000),
      ),
    );
    const expired = await createStore().get(
      preparePiStableContext(
        {
          ...args,
          checkedAt: new Date("2026-09-20T00:00:00.000Z"),
        },
        AbortSignal.timeout(5000),
      ),
    );

    expect(first.kind).toBe("missing");
    expect(first.snapshot).toStrictEqual({
      schemaVersion: 1,
      agentsFiles: [],
      skills: [],
    });
    expect(second.kind).toBe("ready");
    expect(second.snapshot).toMatchObject({
      schemaVersion: 2,
      memoryRecall: { status: "no-content" },
    });
    expect(expired.kind).toBe("missing");
    const [artifactCount, indexCount] = await Promise.all([
      db
        .select({ digest: piStableContextArtifacts.digest })
        .from(piStableContextArtifacts)
        .where(eq(piStableContextArtifacts.agentId, fixture.agentId)),
      db
        .select({ versionId: piResourceVersionIndexes.storageVersionId })
        .from(piResourceVersionIndexes)
        .where(eq(piResourceVersionIndexes.storageVersionId, versionId)),
    ]);
    expect(artifactCount).toHaveLength(1);
    expect(indexCount).toHaveLength(0);

    await invalidatePiStableContext(db, {
      orgId: fixture.orgId,
      agentId: fixture.agentId,
    });
    await expect(
      db.delete(storages).where(eq(storages.id, storageId)),
    ).resolves.toBeDefined();
    await expect(
      db
        .select({ ordinal: piStableContextArtifactResources.ordinal })
        .from(piStableContextArtifactResources)
        .where(
          inArray(
            piStableContextArtifactResources.artifactDigest,
            artifactCount.map((artifact) => {
              return artifact.digest;
            }),
          ),
        ),
    ).resolves.toHaveLength(0);
  });

  it("erases an executing user's projection without deleting another owner's Agent", async () => {
    const fixture = await seed({ ownedByOtherUser: true });
    await createStore().get(
      preparePiStableContext(
        {
          db,
          owner: {
            orgId: fixture.orgId,
            userId: fixture.userId,
            agentId: fixture.agentId,
            resourceOwner: {
              orgId: fixture.orgId,
              userId: fixture.otherUserId,
            },
          },
          variantDigest: "e".repeat(64),
          prompt: {
            agentIdentity: "identity",
            executionLimit: "limit",
            tools: "tools",
          },
          source: {
            catalogIdentity: null,
            featurePromptDigest: "feature",
            permissionDigest: "permission",
            connectorScopeDigest: "connector",
            validityHorizon: null,
            promptSchemaVersion: 1,
            runtimeSchemaVersion: 1,
          },
          mounts: [],
          persistedStorageMounts: [],
          eligible: true,
          checkedAt: new Date("2026-09-17T00:00:00.000Z"),
        },
        AbortSignal.timeout(5000),
      ),
    );

    await deleteClerkAgentLifecycleData(db, {
      kind: "user",
      userId: fixture.userId,
    });

    await expect(
      db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, fixture.agentId)),
    ).resolves.toHaveLength(1);
    await expect(
      db
        .select({ id: piStableContextHeads.id })
        .from(piStableContextHeads)
        .where(eq(piStableContextHeads.userId, fixture.userId)),
    ).resolves.toHaveLength(0);
    await expect(
      db
        .select({ digest: piStableContextArtifacts.digest })
        .from(piStableContextArtifacts)
        .where(eq(piStableContextArtifacts.userId, fixture.userId)),
    ).resolves.toHaveLength(0);
    await expect(
      db
        .select({ subject: piStableContextGenerations.subject })
        .from(piStableContextGenerations)
        .where(eq(piStableContextGenerations.subject, fixture.userId)),
    ).resolves.toHaveLength(0);
  });
});
