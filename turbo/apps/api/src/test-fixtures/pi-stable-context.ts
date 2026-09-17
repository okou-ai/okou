import { randomUUID } from "node:crypto";

import type { PiStableContextBuildInput } from "@okouai/db/jsonb-contracts/pi-stable-context";
import {
  piStableContextArtifacts,
  piStableContextGenerations,
  piStableContextHeads,
  piStableContextPublications,
} from "@okouai/db/schema/pi-stable-context";
import { storages } from "@okouai/db/schema/storage";
import { createStore } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { onTestFinished } from "vitest";
import { z } from "zod";

import { executeRawRows } from "../lib/db-raw-rows";
import { writeDb$ } from "../signals/external/db";
import { createDeferredPromise } from "../signals/utils";
import {
  clearStableAgentPromptBuildHookForTest,
  setStableAgentPromptBuildHookForTest,
} from "../signals/services/agent-runs-create.service";
import { piStableContextInputDigest } from "../signals/services/pi-stable-context-digest.service";
import {
  beginPiStableContextPublication,
  invalidatePiStableContext,
  withPiStableContextGlobalInvalidationOwnersForTest,
} from "../signals/services/pi-stable-context-generation.service";

const store = createStore();

export async function withOwnedPiStableContextGlobalInvalidationFixture<T>(
  owners: readonly { readonly orgId: string; readonly agentId: string }[],
  work: () => Promise<T>,
): Promise<T> {
  return await withPiStableContextGlobalInvalidationOwnersForTest(owners, work);
}

export async function clearAgentStableContextLifecycleFixture(
  agentId: string,
): Promise<void> {
  await store.set(writeDb$).transaction(async (tx) => {
    await tx
      .delete(piStableContextGenerations)
      .where(eq(piStableContextGenerations.agentId, agentId));
    await tx
      .delete(piStableContextPublications)
      .where(eq(piStableContextPublications.agentId, agentId));
    await tx
      .delete(piStableContextHeads)
      .where(eq(piStableContextHeads.agentId, agentId));
    await tx
      .delete(piStableContextArtifacts)
      .where(eq(piStableContextArtifacts.agentId, agentId));
  });
}

export async function seedAgentStableContextPublicationFixture(args: {
  readonly orgId: string;
  readonly agentId: string;
}): Promise<void> {
  await store
    .set(writeDb$)
    .insert(piStableContextPublications)
    .values({
      orgId: args.orgId,
      agentId: args.agentId,
      subject: "@agent",
      publicationKey: `workflow:${randomUUID()}`,
      generation: 2,
      token: randomUUID(),
    });
}

export async function beginWorkflowStableContextPublicationFixture(args: {
  readonly orgId: string;
  readonly userId?: string;
  readonly agentId: string;
  readonly workflowId: string;
}): Promise<void> {
  await beginPiStableContextPublication(
    store.set(writeDb$),
    {
      orgId: args.orgId,
      agentId: args.agentId,
      ...(args.userId ? { userId: args.userId } : {}),
    },
    `workflow:${args.workflowId}`,
  );
}

export async function countAgentStableContextPublicationsFixture(
  agentId: string,
): Promise<number> {
  const rows = await store
    .set(writeDb$)
    .select({ token: piStableContextPublications.token })
    .from(piStableContextPublications)
    .where(eq(piStableContextPublications.agentId, agentId));
  return rows.length;
}

export async function countAgentStableContextGenerationsFixture(
  agentId: string,
): Promise<number> {
  const rows = await store
    .set(writeDb$)
    .select({ subject: piStableContextGenerations.subject })
    .from(piStableContextGenerations)
    .where(
      and(
        eq(piStableContextGenerations.agentId, agentId),
        eq(piStableContextGenerations.subject, "@agent"),
      ),
    );
  return rows.length;
}

export async function countUserStableContextGenerationsFixture(args: {
  readonly agentId: string;
  readonly userId: string;
}): Promise<number> {
  const rows = await store
    .set(writeDb$)
    .select({ subject: piStableContextGenerations.subject })
    .from(piStableContextGenerations)
    .where(
      and(
        eq(piStableContextGenerations.agentId, args.agentId),
        eq(piStableContextGenerations.subject, args.userId),
      ),
    );
  return rows.length;
}

const backendPidSchema = z.object({ pid: z.int() });

async function holdStableContextGenerationFixture(
  args: {
    readonly orgId: string;
    readonly agentId: string;
    readonly subject: string;
  },
  signal: AbortSignal,
) {
  const started = createDeferredPromise<number>(signal);
  const released = createDeferredPromise<void>(signal);
  const db = store.set(writeDb$);
  const done = db.transaction(async (tx) => {
    const [generation] = await tx
      .select({ generation: piStableContextGenerations.generation })
      .from(piStableContextGenerations)
      .where(
        and(
          eq(piStableContextGenerations.orgId, args.orgId),
          eq(piStableContextGenerations.agentId, args.agentId),
          eq(piStableContextGenerations.subject, args.subject),
        ),
      )
      .for("update")
      .limit(1);
    if (!generation) {
      throw new Error("Expected stable-context generation fixture");
    }
    const [backend] = await executeRawRows(
      tx,
      sql`SELECT pg_backend_pid() AS pid`,
      backendPidSchema,
    );
    if (!backend) {
      throw new Error("Expected generation-lock backend fixture");
    }
    started.resolve(backend.pid);
    await released.promise;
  });
  const holderPid = await started.promise;
  return {
    done,
    release() {
      if (!released.settled()) {
        released.resolve();
      }
    },
    async blockedPids(): Promise<readonly number[]> {
      const rows = await executeRawRows(
        db,
        sql`SELECT pid FROM pg_stat_activity WHERE ${holderPid} = ANY(pg_blocking_pids(pid))`,
        backendPidSchema,
      );
      return rows.map((row) => {
        return row.pid;
      });
    },
    async blockedByPid(pid: number): Promise<readonly number[]> {
      const rows = await executeRawRows(
        db,
        sql`SELECT pid FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`,
        backendPidSchema,
      );
      return rows.map((row) => {
        return row.pid;
      });
    },
  };
}

export async function holdAgentStableContextGenerationFixture(
  args: { readonly orgId: string; readonly agentId: string },
  signal: AbortSignal,
) {
  return await holdStableContextGenerationFixture(
    { ...args, subject: "@agent" },
    signal,
  );
}

export async function holdUserStableContextGenerationFixture(
  args: {
    readonly orgId: string;
    readonly agentId: string;
    readonly userId: string;
  },
  signal: AbortSignal,
) {
  return await holdStableContextGenerationFixture(
    { orgId: args.orgId, agentId: args.agentId, subject: args.userId },
    signal,
  );
}

export async function assertUserStableContextGenerationUnlockedFixture(args: {
  readonly orgId: string;
  readonly agentId: string;
  readonly userId: string;
}): Promise<void> {
  await store.set(writeDb$).transaction(async (tx) => {
    await tx
      .select({ generation: piStableContextGenerations.generation })
      .from(piStableContextGenerations)
      .where(
        and(
          eq(piStableContextGenerations.orgId, args.orgId),
          eq(piStableContextGenerations.agentId, args.agentId),
          eq(piStableContextGenerations.subject, args.userId),
        ),
      )
      .for("update", { noWait: true });
  });
}

export async function seedPiStableContextStorageDemandFixture(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly storageName: string;
  readonly versionId: string;
  readonly archiveSize: number;
}): Promise<string> {
  const db = store.set(writeDb$);
  const agentGeneration = await invalidatePiStableContext(db, {
    orgId: args.orgId,
    agentId: args.agentId,
  });
  const userGeneration = await invalidatePiStableContext(db, {
    orgId: args.orgId,
    agentId: args.agentId,
    userId: args.userId,
  });
  const [storage] = await db
    .select({ id: storages.id })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, args.orgId),
        eq(storages.userId, args.userId),
        eq(storages.name, args.storageName),
      ),
    )
    .limit(1);
  if (!storage) {
    throw new Error("Expected stable-context Storage fixture authority");
  }
  const mount = {
    orgId: args.orgId,
    userId: args.userId,
    name: args.storageName,
    storageId: storage.id,
    versionId: args.versionId,
    mountPath: "/home/user/workspace",
    archiveSize: args.archiveSize,
  } as const;
  const input: PiStableContextBuildInput = {
    schemaVersion: 1,
    owner: {
      orgId: args.orgId,
      userId: args.userId,
      agentId: args.agentId,
      resourceOwner: { orgId: args.orgId, userId: args.userId },
    },
    source: {
      agentGeneration,
      userGeneration,
      catalogIdentity: null,
      catalogSourceId: null,
      agentIdentityDigest: "fixture-agent-identity",
      featurePromptDigest: "fixture-feature-prompt",
      permissionDigest: "fixture-permission",
      connectorScopeDigest: "fixture-connector-scope",
      validityHorizon: null,
      promptSchemaVersion: 1,
      runtimeSchemaVersion: 1,
      extractorVersion: 1,
    },
    prompt: {
      agentIdentity: "fixture identity",
      executionLimit: "fixture limit",
      tools: "fixture tools",
    },
    storageMounts: [mount],
    persistedStorageMounts: [
      {
        orgId: mount.orgId,
        userId: mount.userId,
        name: mount.name,
        storageId: mount.storageId,
        version: mount.versionId,
        mountPath: mount.mountPath,
      },
    ],
  };
  const [head] = await db
    .insert(piStableContextHeads)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      agentId: args.agentId,
      variantDigest: randomUUID().replaceAll("-", "").repeat(2),
      agentGeneration,
      userGeneration,
      status: "pending",
      input,
      inputDigest: piStableContextInputDigest(input),
    })
    .returning({ id: piStableContextHeads.id });
  if (!head) {
    throw new Error("Expected stable-context Storage demand fixture");
  }
  onTestFinished(async () => {
    await db
      .delete(piStableContextHeads)
      .where(eq(piStableContextHeads.agentId, args.agentId));
    await db
      .delete(piStableContextArtifacts)
      .where(eq(piStableContextArtifacts.agentId, args.agentId));
    await db
      .delete(piStableContextPublications)
      .where(eq(piStableContextPublications.agentId, args.agentId));
    await db
      .delete(piStableContextGenerations)
      .where(eq(piStableContextGenerations.agentId, args.agentId));
  });
  return head.id;
}

export async function readPiStableContextStorageDemandFixture(headId: string) {
  const [head] = await store
    .set(writeDb$)
    .select({
      status: piStableContextHeads.status,
      input: piStableContextHeads.input,
      inputDigest: piStableContextHeads.inputDigest,
      artifactDigest: piStableContextHeads.artifactDigest,
      leaseId: piStableContextHeads.leaseId,
    })
    .from(piStableContextHeads)
    .where(eq(piStableContextHeads.id, headId))
    .limit(1);
  return head ?? null;
}

export async function withStableAgentPromptBuildCountFixture<T>(
  work: () => Promise<T>,
): Promise<{ readonly buildCount: number; readonly result: T }> {
  let buildCount = 0;
  setStableAgentPromptBuildHookForTest(() => {
    buildCount += 1;
  });
  onTestFinished(() => {
    clearStableAgentPromptBuildHookForTest();
  });
  const result = await work();
  clearStableAgentPromptBuildHookForTest();
  return { buildCount, result };
}
