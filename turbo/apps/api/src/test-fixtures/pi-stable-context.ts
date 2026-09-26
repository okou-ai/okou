import { randomUUID } from "node:crypto";

import type {
  PiStableContextBuildInput,
  PiStableContextProjection,
} from "@okouai/db/jsonb-contracts/pi-stable-context";
import {
  piStableContextArtifactResources,
  piStableContextArtifacts,
  piStableContextGenerations,
  piStableContextHeads,
  piStableContextPublications,
} from "@okouai/db/schema/pi-stable-context";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { storages } from "@okouai/db/schema/storage";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { onTestFinished } from "vitest";

import { writeDb$, type Db } from "../signals/external/db";
import {
  clearStableAgentPromptBuildHookForTest,
  clearStableContextCacheIdentityBuildHookForTest,
  setStableAgentPromptBuildHookForTest,
  setStableContextCacheIdentityBuildHookForTest,
} from "../signals/services/agent-runs-create.service";
import { piStableContextInputDigest } from "../signals/services/pi-stable-context-digest.service";
import {
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

async function seedReadyStorageArtifact(
  db: Db,
  args: {
    readonly ready: boolean | undefined;
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
    readonly storageId: string;
    readonly versionId: string;
    readonly input: PiStableContextBuildInput;
  },
): Promise<string | null> {
  if (!args.ready) {
    return null;
  }
  const digest = randomUUID().replaceAll("-", "").repeat(2);
  const projection: PiStableContextProjection = {
    ...args.input,
    resourceSnapshot: { schemaVersion: 1, agentsFiles: [], skills: [] },
  };
  await db.insert(piStableContextArtifacts).values({
    digest,
    orgId: args.orgId,
    userId: args.userId,
    agentId: args.agentId,
    projection,
  });
  await db.insert(piStableContextArtifactResources).values({
    artifactDigest: digest,
    ordinal: 0,
    storageId: args.storageId,
    storageVersionId: args.versionId,
  });
  return digest;
}

function registerStableContextStorageDemandCleanup(
  db: Db,
  agentId: string,
): void {
  onTestFinished(async () => {
    await db
      .delete(piStableContextHeads)
      .where(eq(piStableContextHeads.agentId, agentId));
    await db
      .delete(piStableContextArtifacts)
      .where(eq(piStableContextArtifacts.agentId, agentId));
    await db
      .delete(piStableContextPublications)
      .where(eq(piStableContextPublications.agentId, agentId));
    await db
      .delete(piStableContextGenerations)
      .where(eq(piStableContextGenerations.agentId, agentId));
  });
}

export async function seedPiStableContextStorageDemandFixture(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly storageName: string;
  readonly versionId: string;
  readonly archiveSize: number;
  readonly resourceOrgId?: string;
  readonly resourceUserId?: string;
  readonly ready?: boolean;
}): Promise<string> {
  const db = store.set(writeDb$);
  await db
    .insert(orgMembersCache)
    .values({ orgId: args.orgId, userId: args.userId, role: "member" })
    .onConflictDoNothing();
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
        eq(storages.orgId, args.resourceOrgId ?? args.orgId),
        eq(storages.userId, args.resourceUserId ?? args.userId),
        eq(storages.name, args.storageName),
      ),
    )
    .limit(1);
  if (!storage) {
    throw new Error("Expected stable-context Storage fixture authority");
  }
  const mount = {
    orgId: args.resourceOrgId ?? args.orgId,
    userId: args.resourceUserId ?? args.userId,
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
  const artifactDigest = await seedReadyStorageArtifact(db, {
    ready: args.ready,
    orgId: args.orgId,
    userId: args.userId,
    agentId: args.agentId,
    storageId: storage.id,
    versionId: args.versionId,
    input,
  });
  const [head] = await db
    .insert(piStableContextHeads)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      agentId: args.agentId,
      variantDigest: randomUUID().replaceAll("-", "").repeat(2),
      agentGeneration,
      userGeneration,
      status: artifactDigest ? "ready" : "pending",
      input,
      inputDigest: piStableContextInputDigest(input),
      artifactDigest,
    })
    .returning({ id: piStableContextHeads.id });
  if (!head) {
    throw new Error("Expected stable-context Storage demand fixture");
  }
  registerStableContextStorageDemandCleanup(db, args.agentId);
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
): Promise<{
  readonly buildCount: number;
  readonly cacheIdentityBuildCount: number;
  readonly result: T;
}> {
  let buildCount = 0;
  let cacheIdentityBuildCount = 0;
  setStableAgentPromptBuildHookForTest(() => {
    buildCount += 1;
  });
  setStableContextCacheIdentityBuildHookForTest(() => {
    cacheIdentityBuildCount += 1;
  });
  const clear = () => {
    clearStableAgentPromptBuildHookForTest();
    clearStableContextCacheIdentityBuildHookForTest();
  };
  onTestFinished(clear);
  const result = await work();
  clear();
  return { buildCount, cacheIdentityBuildCount, result };
}
