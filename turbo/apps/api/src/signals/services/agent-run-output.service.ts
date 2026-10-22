import { nativeThreadBindingSql } from "@okouai/db/operations/native-thread-binding";

import { isDeepStrictEqual } from "node:util";

import { nativeContinuationSchema } from "@okouai/api-contracts/contracts/runners";
import {
  runResultSchema,
  runStatusSchema,
  type RunResult,
  type RunStatus,
} from "@okouai/api-contracts/contracts/runs";
import { runCompletionMetadataSchema } from "@okouai/api-contracts/contracts/webhooks";
import type { z } from "zod";

import { agentRuns } from "@okouai/db/runtime/agent-run";

import type { PersistedStorageMount } from "@okouai/db/types";

import { and, eq, isNotNull } from "drizzle-orm";

import { badRequestMessage, notFound } from "../../lib/error";

import type { Tx } from "../../lib/db-types";
import type { SandboxAuth } from "../../types/auth";

export type AgentRunOutputBody = z.infer<typeof runCompletionMetadataSchema> & {
  readonly runId: string;
};

export interface AgentRunOutputInput {
  readonly auth: SandboxAuth;
  readonly body: AgentRunOutputBody;
}

export type AgentRunOutputErrorResponse =
  ReturnType<typeof badRequestMessage> | ReturnType<typeof notFound>;

interface RunOutputContext {
  readonly chatThreadId: string | null;
  readonly officialWorkflowProvenance: (typeof agentRuns.$inferSelect)["officialWorkflowProvenance"];
  readonly launchSnapshot: typeof agentRuns.$inferSelect.launchSnapshot;
  readonly status: RunStatus;
  readonly storageMounts: typeof agentRuns.$inferSelect.storageMounts;
  readonly id: string;
  readonly agentId: string | null;
  readonly userId: string;
  readonly orgId: string;
  readonly framework: string | null;
  readonly frameworkSessionId: string | null;
}

function resolvedOutputMounts(args: {
  readonly runStorageMounts: readonly PersistedStorageMount[] | null;
  readonly storageOutputs: AgentRunOutputBody["storageOutputs"];
}): PersistedStorageMount[] {
  if (args.runStorageMounts === null) {
    throw new Error("Agent run is missing canonical Storage mounts");
  }
  const snapshotsByIdentity = new Map(
    (args.storageOutputs ?? []).map((snapshot) => {
      return [
        JSON.stringify([snapshot.name, snapshot.mountPath]),
        snapshot,
      ] as const;
    }),
  );
  return args.runStorageMounts.map((mount) => {
    if (!mount.writeback) {
      return mount;
    }
    const snapshot = snapshotsByIdentity.get(
      JSON.stringify([mount.name, mount.mountPath]),
    );
    if (!snapshot) {
      return mount;
    }
    const {
      version: _runVersion,
      missingRootPolicy: _runMissingRootPolicy,
      ...mountBase
    } = mount;
    const missingRootPolicy =
      snapshot.missingRootPolicy ?? mount.missingRootPolicy;
    return {
      ...mountBase,
      version: snapshot.version,
      ...(missingRootPolicy === undefined ? {} : { missingRootPolicy }),
    };
  });
}

const outputRunColumns = {
  id: agentRuns.id,
  agentId: agentRuns.agentId,
  userId: agentRuns.userId,
  orgId: agentRuns.orgId,
  chatThreadId: agentRuns.chatThreadId,
  officialWorkflowProvenance: agentRuns.officialWorkflowProvenance,
  launchSnapshot: agentRuns.launchSnapshot,
  status: agentRuns.status,
  storageMounts: agentRuns.storageMounts,
  framework: agentRuns.framework,
  frameworkSessionId: agentRuns.frameworkSessionId,
} as const;

async function lockRunOutputContext(
  tx: Tx,
  input: AgentRunOutputInput,
): Promise<RunOutputContext | undefined> {
  const [run] = await tx
    .select(outputRunColumns)
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, input.body.runId),
        eq(agentRuns.userId, input.auth.userId),
        eq(agentRuns.orgId, input.auth.orgId),
      ),
    )
    .for("update", { of: agentRuns })
    .limit(1);
  return run
    ? {
        ...run,
        status: runStatusSchema.parse(run.status),
      }
    : undefined;
}

function runOutputSuccessResponse(result: RunResult) {
  return { status: 200 as const, result };
}

type AgentRunOutputSuccessResponse = ReturnType<
  typeof runOutputSuccessResponse
>;

type AgentRunOutputResponse =
  AgentRunOutputSuccessResponse | AgentRunOutputErrorResponse;

function isPiHistoryRun(run: RunOutputContext): boolean {
  return run.launchSnapshot?.framework === "pi";
}

function piHistoryTypeError(
  run: RunOutputContext,
  body: AgentRunOutputBody,
): string | null {
  if (isPiHistoryRun(run) === (body.cliAgentType === "pi")) {
    return null;
  }
  return "[PI_H2_TYPE_MISMATCH] Native session type does not match the run launch framework";
}

function runOutputStateError(status: RunStatus): string {
  return `[RUN_HISTORY_TERMINAL] Native history cannot become canonical while the run status is ${status}`;
}

interface ExistingRunOutput {
  readonly historyHash: string | null;
  readonly sessionId: string | null;
  readonly result?: RunResult;
  readonly type: string | null;
}

function parseExistingRunOutput(
  existing:
    | (Omit<ExistingRunOutput, "result"> & {
        readonly result: typeof agentRuns.$inferSelect.result;
      })
    | undefined,
): ExistingRunOutput | undefined {
  if (!existing) {
    return undefined;
  }
  const parsed =
    existing.result === null
      ? undefined
      : runResultSchema.parse(existing.result);
  const result = parsed?.storageOutputs === undefined ? undefined : parsed;
  const { result: _persistedResult, ...identity } = existing;
  return { ...identity, ...(result === undefined ? {} : { result }) };
}

async function loadExistingRunOutput(
  tx: Tx,
  runId: string,
): Promise<ExistingRunOutput | undefined> {
  const [existing] = await tx
    .select({
      historyHash: agentRuns.legacyConversationHistoryHash,
      sessionId: agentRuns.frameworkSessionId,
      result: agentRuns.result,
      type: agentRuns.framework,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), isNotNull(agentRuns.result)))
    .limit(1);
  // Pre-transition terminal callbacks must drain before cutover. Historical
  // results remain readable, but cannot supply absent exact output evidence.
  if (!existing) {
    return undefined;
  }
  return parseExistingRunOutput(existing);
}

function storageOutputs(
  mounts: readonly PersistedStorageMount[],
): NonNullable<RunResult["storageOutputs"]> {
  const outputs: NonNullable<RunResult["storageOutputs"]> = [];
  for (const mount of mounts) {
    if (mount.version === undefined) {
      throw new Error(`Invalid Run Storage "${mount.name}": missing version`);
    }
    if (mount.writeback) {
      outputs.push({
        name: mount.name,
        version: mount.version,
        mountPath: mount.mountPath,
        ...(mount.missingRootPolicy === undefined
          ? {}
          : { missingRootPolicy: mount.missingRootPolicy }),
      });
    }
  }
  return outputs;
}

function buildRunResult(
  run: RunOutputContext,
  body: AgentRunOutputBody,
  mounts: readonly PersistedStorageMount[],
): RunResult {
  const framework = run.launchSnapshot?.framework;
  return {
    ...(framework !== undefined && framework === body.cliAgentType
      ? { framework, frameworkSessionId: body.cliAgentSessionId }
      : {}),
    storageOutputs: storageOutputs(mounts),
  };
}

async function persistAgentRunOutput(
  tx: Tx,
  run: RunOutputContext,
  body: AgentRunOutputBody,
  options: {
    storageMounts: PersistedStorageMount[];
  },
  signal: AbortSignal,
) {
  const { storageMounts } = options;
  await tx
    .update(agentRuns)
    .set({
      framework: body.cliAgentType,
      frameworkSessionId: body.cliAgentSessionId,
    })
    .where(eq(agentRuns.id, body.runId));
  signal.throwIfAborted();

  const binding = nativeThreadBindingSql({
    run,
    owner: { userId: run.userId, orgId: run.orgId },
    framework: body.cliAgentType,
    sessionId: body.cliAgentSessionId,
  });
  if (binding) {
    await tx.execute(binding);
  }
  const result = buildRunResult(run, body, storageMounts);

  return runOutputSuccessResponse(result);
}

async function exactRunOutputRetryResponse(
  tx: Tx,
  run: RunOutputContext,
  body: AgentRunOutputBody,
  storageMounts: readonly PersistedStorageMount[],
  signal: AbortSignal,
): Promise<AgentRunOutputSuccessResponse | undefined> {
  const existing = await loadExistingRunOutput(tx, body.runId);
  signal.throwIfAborted();
  if (existing?.result === undefined) {
    return undefined;
  }
  const exactRetry =
    existing?.type === body.cliAgentType &&
    existing.sessionId === body.cliAgentSessionId &&
    existing.historyHash === null &&
    isDeepStrictEqual(
      existing.result.storageOutputs,
      storageOutputs(storageMounts),
    );
  if (!exactRetry) {
    return undefined;
  }
  return runOutputSuccessResponse(existing.result);
}

function runStorageOutputError(
  mounts: readonly PersistedStorageMount[] | null,
  outputs: AgentRunOutputBody["storageOutputs"],
): string | null {
  const identities = new Set<string>();
  for (const output of outputs ?? []) {
    const identity = JSON.stringify([output.name, output.mountPath]);
    if (
      identities.has(identity) ||
      !mounts?.some((mount) => {
        return (
          mount.writeback &&
          mount.name === output.name &&
          mount.mountPath === output.mountPath
        );
      })
    ) {
      return "Run output does not identify a unique authorized writeback mount";
    }
    identities.add(identity);
  }
  return null;
}

function capturedNativeOutputError(
  run: RunOutputContext,
  body: AgentRunOutputBody,
): string | undefined {
  if (
    run.launchSnapshot?.schemaVersion === 5 &&
    (body.cliAgentSessionHistoryDisposition !== "native_only" ||
      !nativeContinuationSchema.shape.sessionId.safeParse(
        body.cliAgentSessionId,
      ).success ||
      (run.launchSnapshot.framework === "pi" &&
        body.cliAgentSessionId !== (run.chatThreadId ?? run.id) &&
        !(
          run.officialWorkflowProvenance && body.cliAgentSessionId === run.id
        )) ||
      body.cliAgentType !== run.launchSnapshot.framework)
  ) {
    return "Native Run output does not match its captured Framework identity";
  }
}

function nativeRunIdentityChanged(
  run: RunOutputContext,
  body: AgentRunOutputBody,
): boolean {
  return (
    run.launchSnapshot?.schemaVersion === 5 &&
    run.frameworkSessionId !== null &&
    run.frameworkSessionId !== body.cliAgentSessionId
  );
}

export async function persistAgentRunOutputsInTransaction(
  tx: Tx,
  input: AgentRunOutputInput,
  signal: AbortSignal,
): Promise<AgentRunOutputResponse> {
  const run = await lockRunOutputContext(tx, input);
  signal.throwIfAborted();
  if (!run) {
    return notFound("Agent run not found");
  }

  const outputError = runStorageOutputError(
    run.storageMounts,
    input.body.storageOutputs,
  );
  if (outputError) {
    return badRequestMessage(outputError);
  }
  const storageMounts = resolvedOutputMounts({
    runStorageMounts: run.storageMounts,
    storageOutputs: input.body.storageOutputs,
  });
  const nativeError = capturedNativeOutputError(run, input.body);
  if (nativeError) {
    return badRequestMessage(nativeError);
  }
  const typeError = piHistoryTypeError(run, input.body);
  if (typeError) {
    return badRequestMessage(typeError);
  }
  const piRun = isPiHistoryRun(run);
  if (!piRun && run.status === "timeout") {
    return badRequestMessage(runOutputStateError(run.status));
  }
  if (["completed", "failed", "cancelled"].includes(run.status)) {
    const exactRetry = await exactRunOutputRetryResponse(
      tx,
      run,
      input.body,
      storageMounts,
      signal,
    );
    if (exactRetry) {
      return exactRetry;
    }
    if (
      run.status === "completed" ||
      (await loadExistingRunOutput(tx, input.body.runId))
    ) {
      return badRequestMessage(
        "[RUN_OUTPUT_ALREADY_COMMITTED] Final output does not exactly match the committed Run output",
      );
    }
  }
  if (nativeRunIdentityChanged(run, input.body)) {
    return badRequestMessage(
      "Native Run output does not match its captured Framework identity",
    );
  }

  return await persistAgentRunOutput(
    tx,
    run,
    input.body,
    {
      storageMounts,
    },
    signal,
  );
}
