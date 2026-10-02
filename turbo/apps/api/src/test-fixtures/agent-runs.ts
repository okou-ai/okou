import { createStore } from "ccstate";
import type { ModelProviderType } from "@okouai/api-contracts/contracts/model-providers";

import { agentRuns } from "@okouai/db/runtime/agent-run";
import { blobs } from "@okouai/db/schema/blob";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { eq } from "drizzle-orm";
import { db } from "../lib/db";
import { agentRunList } from "../signals/services/agent-runs.service";
/**
 * Test fixtures for agent-run state that no public route reads or seeds
 * directly. Runs themselves start through the real Thread or Pi entries.
 */

export async function readSessionHistoryBlobRefCountFixture(
  hash: string,
): Promise<number> {
  const [blob] = await db()
    .select({ refCount: blobs.refCount })
    .from(blobs)
    .where(eq(blobs.hash, hash))
    .limit(1);
  if (!blob) {
    throw new Error("Expected the Session history Blob fixture to exist");
  }
  return blob.refCount;
}

export async function clearRunLaunchSnapshotFixture(
  runId: string,
): Promise<void> {
  const rows = await db()
    .update(agentRuns)
    .set({ launchSnapshot: null })
    .where(eq(agentRuns.id, runId))
    .returning({ id: agentRuns.id });
  if (rows.length !== 1) {
    throw new Error("Expected one Run launch snapshot to clear");
  }
}

export async function listAgentRunsFixture(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly status?: string;
  readonly agent?: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
}) {
  // Disposable database fixtures replace the pool between operations, so each
  // listing owns its read store instead of retaining a previous db$ binding.
  return await createStore().get(
    agentRunList({
      userId: args.userId,
      orgId: args.orgId,
      status: args.status,
      agent: args.agent,
      since: args.since,
      until: args.until,
      limit: args.limit ?? 50,
    }),
  );
}

export async function readRunModelRuntimeRouteFixture(runId: string) {
  const [run] = await db()
    .select({
      modelProvider: agentRuns.modelProvider,
      selectedModel: agentRuns.selectedModel,
      modelRuntimeProvider: agentRuns.modelRuntimeProvider,
      modelRuntimeModel: agentRuns.modelRuntimeModel,
      builtInModelKeyId: agentRuns.builtInModelKeyId,
      builtInModelKeyVendor: builtInModelKeys.vendor,
    })
    .from(agentRuns)
    .leftJoin(
      builtInModelKeys,
      eq(builtInModelKeys.id, agentRuns.builtInModelKeyId),
    )
    .where(eq(agentRuns.id, runId))
    .limit(1);
  if (!run) {
    throw new Error("Expected one run runtime route");
  }
  return run;
}

/** Launch options a run captured for its runtime (effort and service tier). */
export async function readRunModelLaunchOptionsFixture(runId: string) {
  const [run] = await db()
    .select({
      reasoningEffort: agentRuns.reasoningEffort,
      codexServiceTier: agentRuns.codexServiceTier,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  if (!run) {
    throw new Error("Expected one run launch options row");
  }
  return run;
}

/** Simulate historical or alternate built-in model route metadata not constructible through current policy. */
export async function setRunModelRuntimeRouteFixture(args: {
  readonly runId: string;
  readonly modelRuntimeProvider: string | null;
  readonly modelRuntimeModel: string | null;
  readonly selectedModel?: string;
}): Promise<void> {
  const updated = await db()
    .update(agentRuns)
    .set({
      ...(args.selectedModel !== undefined && {
        selectedModel: args.selectedModel,
      }),
      modelRuntimeProvider: args.modelRuntimeProvider,
      modelRuntimeModel: args.modelRuntimeModel,
    })
    .where(eq(agentRuns.id, args.runId))
    .returning({ id: agentRuns.id });
  if (updated.length !== 1) {
    throw new Error("Expected one run runtime route to update");
  }
}

/**
 * Simulate a persisted discriminator written by a later release. The current
 * production API intentionally cannot construct this canonical row because
 * its write fence still rejects `built-in`; compatibility reads still require
 * permanent coverage before that later writer exists.
 */
export async function setRunModelProviderFixture(args: {
  readonly runId: string;
  readonly modelProvider: ModelProviderType;
}): Promise<void> {
  const updated = await db()
    .update(agentRuns)
    .set({ modelProvider: args.modelProvider })
    .where(eq(agentRuns.id, args.runId))
    .returning({ id: agentRuns.id });
  if (updated.length !== 1) {
    throw new Error("Expected one run model provider to update");
  }
}

/** Operational source and model admission are not exposed by the public run
 * read. Keep this test-owned persisted observation separate from runtime-route
 * assertions so it cannot change existing fixture result contracts. */
export async function readRunModelSourceFixture(runId: string) {
  const [run] = await db()
    .select({
      modelProvider: agentRuns.modelProvider,
      modelProviderId: agentRuns.modelProviderId,
      modelProviderCredentialScope: agentRuns.modelProviderCredentialScope,
      selectedModel: agentRuns.selectedModel,
      creditAdmitted: agentRuns.creditAdmitted,
      builtInModelKeyId: agentRuns.builtInModelKeyId,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  if (!run) {
    throw new Error("Expected one run model source");
  }
  return run;
}
