import { randomUUID } from "node:crypto";

import type { PiStableContextBuildInput } from "@okouai/db/jsonb-contracts/pi-stable-context";
import { agents } from "@okouai/db/schema/agent";
import {
  piStableContextArtifacts,
  piStableContextGenerations,
  piStableContextHeads,
} from "@okouai/db/schema/pi-stable-context";
import { piResourceVersionIndexes } from "@okouai/db/schema/pi-resource-version-index";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createStore } from "ccstate";

import { env } from "../../../lib/env";
import {
  beginPiStableContextPublication,
  completePiStableContextPublication,
  invalidatePiStableContext,
  invalidatePiStableContextsForUser,
  lockPiStableContextPublication,
  PI_STABLE_CONTEXT_AGENT_SUBJECT,
} from "../pi-stable-context-generation.service";
import { preparePiStableContext } from "../pi-stable-context.service";

describe("Pi stable context generation fences", () => {
  const pool = new Pool({ connectionString: env("DATABASE_URL"), max: 4 });
  const db = drizzle(pool);
  const agentIds: string[] = [];
  const storageIds: string[] = [];

  afterAll(async () => {
    if (agentIds.length > 0) {
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

  async function seed() {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const otherUserId = `user_${randomUUID()}`;
    const agentId = randomUUID();
    agentIds.push(agentId);
    await db.insert(agents).values({
      id: agentId,
      orgId,
      owner: userId,
      name: `stable-${agentId.slice(0, 8)}`,
    });
    const owner = {
      orgId,
      userId,
      agentId,
      resourceOwner: { orgId, userId },
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

    const first = await beginPiStableContextPublication(db, {
      orgId: fixture.orgId,
      agentId: fixture.agentId,
    });
    const second = await beginPiStableContextPublication(db, {
      orgId: fixture.orgId,
      agentId: fixture.agentId,
    });
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
    expect(head).toStrictEqual({
      status: "missing",
      input: null,
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
      rows.map((row) => [row.subject, row.generation] as const),
    );
    expect(generationBySubject.get(fixture.userId)).toBe(2);
    expect(generationBySubject.get(fixture.otherUserId)).toBe(1);
    expect(generationBySubject.get(PI_STABLE_CONTEXT_AGENT_SUBJECT)).toBe(
      second.generation,
    );
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
  });
});
