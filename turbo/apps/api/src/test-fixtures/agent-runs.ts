/**
 * Test fixtures for retired agent-run API capabilities.
 *
 * Production no longer exposes direct-run creation or run listing, while the
 * integration suites still need those capabilities to construct and inspect
 * runner state. Keep the exception at this narrow service boundary and assert
 * product behavior through the remaining production routes.
 */
import { randomUUID } from "node:crypto";

import { createStore, state } from "ccstate";
import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";
import type { ModelProviderType } from "@okouai/api-contracts/contracts/model-providers";
import { SYSTEM_ORG_ID, VOLUME_ORG_USER_ID } from "@okouai/core/storage-names";
import type { AgentRunLaunchSnapshot } from "@okouai/db/jsonb-contracts/agent-run-session-conversation";
import { agents } from "@okouai/db/schema/agent";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { blobs } from "@okouai/db/schema/blob";
import { checkpoints } from "@okouai/db/schema/checkpoint";
import { conversations } from "@okouai/db/schema/conversation";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { storages } from "@okouai/db/schema/storage";
import { and, count, eq, inArray } from "drizzle-orm";

import { db } from "../lib/db";
import { badRequestMessage, notFound } from "../lib/error";
import { now } from "../lib/time";
import {
  createAgentRun$,
  type CreateAgentRunArgs,
} from "../signals/services/agent-run-create.service";
import { buildAgentExecutionConfig } from "../signals/services/agent-execution-config";
import { agentRunList } from "../signals/services/agent-runs.service";
import {
  isCompressedSessionHistoryBlobEncoding,
  normalizeSessionHistoryBlobEncoding,
} from "../signals/services/session-history-blobs";
import { projectLegacyWritebackArtifacts } from "../signals/services/storage-legacy-projection.service";

const store = createStore();

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

/**
 * Test-only historical-row fixture.  Completion reads this persisted value
 * after the runner has claimed the run, which lets API tests exercise the
 * compatibility decoder without changing a production writer.
 */
export async function setRunLaunchSnapshotFixture(
  runId: string,
  launchSnapshot: AgentRunLaunchSnapshot | null,
): Promise<void> {
  const rows = await db()
    .update(agentRuns)
    .set({ launchSnapshot })
    .where(eq(agentRuns.id, runId))
    .returning({ id: agentRuns.id });
  if (rows.length !== 1) {
    throw new Error("Expected one Run launch snapshot to update");
  }
}

export async function setRunPiMemoryAdmissionInputsFixture(
  runId: string,
  inputs: {
    readonly triggerSource?: TriggerSource;
    readonly chatThreadId?: string | null;
  },
): Promise<void> {
  if (inputs.triggerSource === undefined && inputs.chatThreadId === undefined) {
    return;
  }
  const rows = await db()
    .update(agentRuns)
    .set({
      ...(inputs.triggerSource === undefined
        ? {}
        : { triggerSource: inputs.triggerSource }),
      ...(inputs.chatThreadId === undefined
        ? {}
        : { chatThreadId: inputs.chatThreadId }),
    })
    .where(eq(agentRuns.id, runId))
    .returning({ id: agentRuns.id });
  if (rows.length !== 1) {
    throw new Error("Expected one Run admission input to update");
  }
}

type DirectRunResolver = NonNullable<
  CreateAgentRunArgs["testOnlyResolveDirectRun"]
>;
type DirectRunResolution = Awaited<ReturnType<DirectRunResolver>>;
type DirectRunResolverArgs = Parameters<DirectRunResolver>[0];
type ResolvedDirectRun = Extract<
  DirectRunResolution,
  { readonly agentId: string }
>;
export type DirectAgentExecutionConfig = ResolvedDirectRun["content"];

const directAgentExecutionConfigs$ = state<
  ReadonlyMap<string, DirectAgentExecutionConfig>
>(new Map());

export async function createDirectAgentExecutionFixture(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly content: DirectAgentExecutionConfig;
  readonly signal: AbortSignal;
}): Promise<{ readonly agentId: string; readonly name: string }> {
  const names = Object.keys(args.content.agents ?? {});
  if (names.length !== 1 || !names[0]) {
    throw new Error(
      "Direct Agent execution fixtures require exactly one Agent",
    );
  }
  const name = names[0].toLowerCase();
  const [agent] = await db()
    .insert(agents)
    .values({
      id: randomUUID(),
      orgId: args.orgId,
      owner: args.userId,
      name,
      displayName: "Direct run fixture",
      visibility: "private",
    })
    .onConflictDoUpdate({
      target: [agents.orgId, agents.name],
      set: {
        owner: args.userId,
        displayName: "Direct run fixture",
        visibility: "private",
      },
    })
    .returning({ id: agents.id });
  if (!agent) {
    throw new Error("Expected the direct Agent fixture to be persisted");
  }
  args.signal.throwIfAborted();
  store.set(
    directAgentExecutionConfigs$,
    new Map(store.get(directAgentExecutionConfigs$)).set(
      agent.id,
      args.content,
    ),
  );
  return { agentId: agent.id, name };
}

async function measureDirectResolution<T>(
  timing: DirectRunResolverArgs["timing"],
  actionType:
    | "api_dispatch_resolve_agent_execution_lookup_agent"
    | "api_dispatch_resolve_agent_execution_lookup_session_snapshot"
    | "api_dispatch_resolve_agent_execution_resolve_session_history",
  work: () => Promise<T> | T,
): Promise<T> {
  return timing
    ? await timing.measure(actionType, "nested", work)
    : await Promise.resolve(work());
}

function resumeSessionFromSnapshotFixture(snapshot: {
  readonly runId: string;
  readonly cliAgentSessionId: string;
  readonly cliAgentSessionHistory: string | null;
  readonly cliAgentSessionHistoryHash: string | null;
  readonly sessionHistoryBlobEncoding: string | null;
}): ResolvedDirectRun["resumeSession"] {
  const hash = snapshot.cliAgentSessionHistoryHash;
  let encoding;
  if (snapshot.sessionHistoryBlobEncoding !== null) {
    const parsedEncoding = normalizeSessionHistoryBlobEncoding(
      snapshot.sessionHistoryBlobEncoding,
    );
    if (isCompressedSessionHistoryBlobEncoding(parsedEncoding)) {
      encoding = parsedEncoding;
    }
  }
  if (hash) {
    return {
      sessionId: snapshot.cliAgentSessionId,
      historyGenerationRunId: snapshot.runId,
      historyRef: {
        kind: "blob",
        hash,
        ...(encoding ? { encoding } : {}),
      },
    };
  }
  if (snapshot.cliAgentSessionHistory) {
    return {
      sessionId: snapshot.cliAgentSessionId,
      sessionHistory: snapshot.cliAgentSessionHistory,
    };
  }
  return undefined;
}

async function resolveDirectAgentRun(
  args: DirectRunResolverArgs,
  agentId: string,
): Promise<DirectRunResolution> {
  const [agent] = await measureDirectResolution(
    args.timing,
    "api_dispatch_resolve_agent_execution_lookup_agent",
    async () => {
      return await args.db
        .select({
          id: agents.id,
          name: agents.name,
          orgId: agents.orgId,
          owner: agents.owner,
        })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1);
    },
  );
  if (!agent) {
    return notFound("Agent not found");
  }
  return {
    agentId: agent.id,
    ownerUserId: agent.owner,
    orgId: agent.orgId,
    content:
      store.get(directAgentExecutionConfigs$).get(agent.id) ??
      buildAgentExecutionConfig(agent.name),
    artifacts: [],
  };
}

async function loadDirectSessionSnapshot(
  args: DirectRunResolverArgs,
  sessionId: string,
) {
  return await measureDirectResolution(
    args.timing,
    "api_dispatch_resolve_agent_execution_lookup_session_snapshot",
    async () => {
      return await args.db
        .select({
          session: {
            id: agentSessions.id,
            storageMounts: agentSessions.storageMounts,
          },
          agent: {
            id: agents.id,
            name: agents.name,
            orgId: agents.orgId,
            owner: agents.owner,
          },
          conversation: {
            id: conversations.id,
            runId: conversations.runId,
            cliAgentType: conversations.cliAgentType,
            cliAgentSessionId: conversations.cliAgentSessionId,
            cliAgentSessionHistory: conversations.cliAgentSessionHistory,
            cliAgentSessionHistoryHash:
              conversations.cliAgentSessionHistoryHash,
          },
          historyBlob: { hash: blobs.hash, encoding: blobs.encoding },
          previousRun: {
            id: agentRuns.id,
            vars: agentRuns.vars,
            selectedModel: agentRuns.selectedModel,
          },
        })
        .from(agentSessions)
        .leftJoin(agents, eq(agentSessions.agentId, agents.id))
        .leftJoin(
          conversations,
          eq(agentSessions.conversationId, conversations.id),
        )
        .leftJoin(
          blobs,
          eq(conversations.cliAgentSessionHistoryHash, blobs.hash),
        )
        .leftJoin(agentRuns, eq(conversations.runId, agentRuns.id))
        .where(
          and(
            eq(agentSessions.id, sessionId),
            eq(agentSessions.userId, args.userId),
            eq(agentSessions.orgId, args.orgId),
          ),
        )
        .limit(1);
    },
  );
}

async function resolveDirectSessionRun(
  args: DirectRunResolverArgs,
  sessionId: string,
): Promise<DirectRunResolution> {
  const [snapshot] = await loadDirectSessionSnapshot(args, sessionId);
  if (!snapshot) {
    return notFound("Agent session not found");
  }
  if (!snapshot.agent) {
    return notFound("Agent not found");
  }
  if (snapshot.session.storageMounts === null) {
    throw new Error(
      `Agent session "${snapshot.session.id}" is missing canonical Storage mounts`,
    );
  }

  const conversation = snapshot.conversation;
  const resumeSession = conversation
    ? await measureDirectResolution(
        args.timing,
        "api_dispatch_resolve_agent_execution_resolve_session_history",
        () => {
          return resumeSessionFromSnapshotFixture({
            ...conversation,
            sessionHistoryBlobEncoding: snapshot.historyBlob?.encoding ?? null,
          });
        },
      )
    : undefined;
  return {
    agentId: snapshot.agent.id,
    ownerUserId: snapshot.agent.owner,
    orgId: snapshot.agent.orgId,
    content:
      store.get(directAgentExecutionConfigs$).get(snapshot.agent.id) ??
      buildAgentExecutionConfig(snapshot.agent.name),
    artifacts: projectLegacyWritebackArtifacts(snapshot.session.storageMounts),
    persistedStorageMounts: snapshot.session.storageMounts,
    vars:
      (snapshot.previousRun?.vars as Record<string, string> | null) ??
      undefined,
    agentSessionId: snapshot.session.id,
    continuedFromAgentSessionId: snapshot.session.id,
    resumeSession,
    resumeSessionIdentity: {
      selectedModel: snapshot.previousRun?.selectedModel ?? null,
      cliAgentType: conversation?.cliAgentType ?? null,
    },
  };
}

const resolveDirectRun: DirectRunResolver = async (args) => {
  if (args.body.sessionId) {
    return await resolveDirectSessionRun(args, args.body.sessionId);
  }
  return args.body.agentId
    ? await resolveDirectAgentRun(args, args.body.agentId)
    : badRequestMessage("Missing agentId or sessionId");
};

export type DirectRunFixtureRequest = Omit<
  CreateAgentRunArgs["body"],
  "triggerSource"
> & {
  readonly triggerSource?: TriggerSource;
  readonly connectorScope?: CreateAgentRunArgs["connectorScope"];
  readonly ownedSystemStorageMounts?: readonly {
    readonly storageId: string;
    readonly version?: string;
    readonly mountPath: string;
  }[];
};

async function resolveOwnedSystemStorageMounts(
  mounts: DirectRunFixtureRequest["ownedSystemStorageMounts"],
  signal: AbortSignal,
) {
  if (!mounts || mounts.length === 0) {
    return [];
  }

  const storageIds = mounts.map((mount) => {
    return mount.storageId;
  });
  if (new Set(storageIds).size !== storageIds.length) {
    throw new Error("Owned system storage mount ids must be unique");
  }

  const rows = await db()
    .select({ id: storages.id, name: storages.name })
    .from(storages)
    .where(
      and(
        inArray(storages.id, storageIds),
        eq(storages.orgId, SYSTEM_ORG_ID),
        eq(storages.userId, VOLUME_ORG_USER_ID),
      ),
    );
  signal.throwIfAborted();
  const storageNameById = new Map(
    rows.map((row) => {
      return [row.id, row.name];
    }),
  );

  return mounts.map((mount) => {
    const name = storageNameById.get(mount.storageId);
    if (!name) {
      throw new Error("Owned system storage mount is unavailable");
    }
    return {
      name,
      ...(mount.version === undefined ? {} : { version: mount.version }),
      mountPath: mount.mountPath,
      system: true,
    };
  });
}

export async function createDirectRunFixture(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly body: DirectRunFixtureRequest;
  readonly signal: AbortSignal;
}) {
  const { connectorScope, ownedSystemStorageMounts, ...body } = args.body;
  const resolvedOwnedSystemStorageMounts =
    await resolveOwnedSystemStorageMounts(
      ownedSystemStorageMounts,
      args.signal,
    );
  args.signal.throwIfAborted();
  return await store.set(
    createAgentRun$,
    {
      userId: args.userId,
      orgId: args.orgId,
      apiStartTime: now(),
      modelProviderType: body.modelProviderType,
      piExecution: false,
      testOnlyResolveDirectRun: resolveDirectRun,
      connectorScope: connectorScope ?? {
        allowedConnectorSlugs: [],
        allowedCustomConnectorIds: [],
      },
      body: {
        ...body,
        ...(resolvedOwnedSystemStorageMounts.length === 0
          ? {}
          : {
              additionalVolumes: [
                ...(body.additionalVolumes ?? []),
                ...resolvedOwnedSystemStorageMounts,
              ],
            }),
        triggerSource: body.triggerSource ?? "test",
      },
    },
    args.signal,
  );
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
  return await store.get(
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

function exactlyOneCount(
  source: string,
  rows: readonly { readonly count: number }[],
): number {
  const [row] = rows;
  if (!row || rows.length !== 1) {
    throw new Error(
      `Expected exactly one ${source} COUNT row, received ${rows.length}`,
    );
  }
  return row.count;
}

/**
 * Exceptional internal assertion for the Run identity mismatch contract.
 *
 * Production APIs cannot observe the absence of Session, callback,
 * conversation, or checkpoint rows. Keep this fixture narrowly scoped to the
 * contract requirement that an Agent/Session mismatch fails before every
 * launch write; ordinary route tests must continue to verify state through
 * production API surfaces.
 */
export async function readRunIdentityMismatchWriteCountsFixture(args: {
  readonly userId: string;
  readonly orgId: string;
}) {
  const ownedRuns = and(
    eq(agentRuns.userId, args.userId),
    eq(agentRuns.orgId, args.orgId),
  );
  const [runRows, sessionRows, callbackRows, conversationRows, checkpointRows] =
    await Promise.all([
      db().select({ count: count() }).from(agentRuns).where(ownedRuns),
      db()
        .select({ count: count() })
        .from(agentSessions)
        .where(
          and(
            eq(agentSessions.userId, args.userId),
            eq(agentSessions.orgId, args.orgId),
          ),
        ),
      db()
        .select({ count: count() })
        .from(agentRunCallbacks)
        .innerJoin(agentRuns, eq(agentRunCallbacks.runId, agentRuns.id))
        .where(ownedRuns),
      db()
        .select({ count: count() })
        .from(conversations)
        .innerJoin(agentRuns, eq(conversations.runId, agentRuns.id))
        .where(ownedRuns),
      db()
        .select({ count: count() })
        .from(checkpoints)
        .innerJoin(agentRuns, eq(checkpoints.runId, agentRuns.id))
        .where(ownedRuns),
    ]);

  return {
    runs: exactlyOneCount("Run", runRows),
    sessions: exactlyOneCount("Session", sessionRows),
    callbacks: exactlyOneCount("callback", callbackRows),
    conversations: exactlyOneCount("conversation", conversationRows),
    checkpoints: exactlyOneCount("checkpoint", checkpointRows),
  };
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
