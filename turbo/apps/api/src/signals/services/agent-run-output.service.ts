import { runNativeThreadBinding } from "./run-native-session.service";

import { isDeepStrictEqual } from "node:util";

import type { z } from "zod";
import {
  runStatusSchema,
  type RunStatus,
  type RunResult,
  runResultSchema,
} from "@okouai/api-contracts/contracts/runs";
import { nativeContinuationSchema } from "@okouai/api-contracts/contracts/runners";
import { runCompletionMetadataSchema } from "@okouai/api-contracts/contracts/webhooks";

import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { piMemoryPhase2MaintenanceCallbackPayloadSchema } from "./pi-memory-phase2-maintenance.service";
import { piMemoryPhase2Jobs } from "@okouai/db/runtime/pi-memory-phase2-job";
import {
  maintenancePublicationResultCondition,
  maintenancePublicationVersion,
  maintenanceUnpublishedRecoveryCondition,
  maintenanceOutputResultVersion,
} from "./pi-memory-phase2-result";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";

import type { PersistedStorageMount } from "@okouai/db/types";

import { and, eq, isNotNull, or } from "drizzle-orm";

import { badRequestMessage, notFound } from "../../lib/error";

import type { Tx } from "../../lib/db-types";
import type { SandboxAuth } from "../../types/auth";
import type { Db } from "../external/db";

export type AgentRunOutputBody = z.infer<typeof runCompletionMetadataSchema> & {
  readonly runId: string;
};

export interface AgentRunOutputInput {
  readonly auth: SandboxAuth;
  readonly body: AgentRunOutputBody;
  readonly recovery: boolean;
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
  readonly createdAt: Date;
  readonly userId: string;
  readonly orgId: string;
  readonly framework: string | null;
  readonly frameworkSessionId: string | null;
  readonly existingOutput: ExistingRunOutput | undefined;
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
  createdAt: agentRuns.createdAt,
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
        existingOutput: undefined,
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

  const binding = runNativeThreadBinding({
    run,
    owner: { userId: run.userId, orgId: run.orgId },
    framework: body.cliAgentType,
    sessionId: body.cliAgentSessionId,
  });
  if (binding) {
    await tx.update(chatThreads).set(binding.values).where(binding.condition);
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

function finalizedMaintenanceOutput(
  binding: {
    readonly memoryStorageId: string;
    readonly claimedBaseVersionId: string;
  },
  run: RunOutputContext,
  body: AgentRunOutputBody,
): { memoryStorageId: string; versionId: string } | string {
  const outputError = runStorageOutputError(
    run.storageMounts,
    body.storageOutputs,
  );
  if (outputError) {
    return outputError;
  }
  const existing = run.existingOutput;
  const mount = run.storageMounts?.find((entry) => {
    return entry.storageId === binding.memoryStorageId && entry.writeback;
  });
  const snapshot = body.storageOutputs?.find((entry) => {
    return entry.name === mount?.name && entry.mountPath === mount.mountPath;
  });
  const committed = existing?.result?.storageOutputs?.find((entry) => {
    return entry.name === mount?.name && entry.mountPath === mount.mountPath;
  });
  if (
    !mount ||
    !snapshot ||
    !committed ||
    (snapshot.version !== binding.claimedBaseVersionId &&
      snapshot.version !== committed.version) ||
    existing?.result === undefined ||
    existing.type !== body.cliAgentType ||
    existing.sessionId !== body.cliAgentSessionId ||
    existing.historyHash !== null ||
    !isDeepStrictEqual(
      existing.result.storageOutputs,
      storageOutputs(
        resolvedOutputMounts({
          runStorageMounts: run.storageMounts,
          storageOutputs: body.storageOutputs,
        }).map((entry) => {
          // Fresh completion already normalizes the launch base recovery output
          // to the publication result. Retain that same normalization on replay.
          return entry.storageId === binding.memoryStorageId
            ? { ...entry, version: committed.version }
            : entry;
        }),
      ),
    )
  ) {
    return "[RUN_OUTPUT_ALREADY_COMMITTED] Final output does not exactly match the committed Run output";
  }
  return {
    memoryStorageId: binding.memoryStorageId,
    versionId: committed.version,
  };
}

function privateMaintenanceIdentityMatches(
  binding: { readonly orgId: string; readonly userId: string },
  input: AgentRunOutputInput,
  run: RunOutputContext,
): boolean {
  return (
    binding.orgId === input.auth.orgId &&
    binding.userId === input.auth.userId &&
    run.chatThreadId === null &&
    isPiHistoryRun(run) &&
    input.body.cliAgentSessionId === input.body.runId &&
    input.body.cliAgentSessionHistoryDisposition === "native_only"
  );
}

function privateMaintenanceSnapshotOutput(
  binding: {
    readonly memoryStorageId: string;
    readonly claimedBaseVersionId: string;
  },
  run: RunOutputContext,
  body: AgentRunOutputBody,
  versionId: string,
): { memoryStorageId: string; versionId: string } | string {
  const mount = run.storageMounts?.find((entry) => {
    return entry.storageId === binding.memoryStorageId && entry.writeback;
  });
  const snapshot = body.storageOutputs?.find((entry) => {
    return entry.name === mount?.name && entry.mountPath === mount.mountPath;
  });
  if (
    !mount ||
    !snapshot ||
    (snapshot.version !== binding.claimedBaseVersionId &&
      snapshot.version !== versionId)
  ) {
    return "[PI_MAINTENANCE_OUTPUT_INVALID] Private output lacks exact publication or recovery evidence";
  }
  return { memoryStorageId: binding.memoryStorageId, versionId };
}

// Private maintenance has no public Pi history. The Job proves fresh publication;
// a finalized Run's immutable output proves only that Run's exact replay.
async function privateMaintenanceOutput(
  db: Db | Tx,
  input: AgentRunOutputInput,
  run: RunOutputContext,
): Promise<
  { memoryStorageId: string; versionId: string } | string | undefined
> {
  if (!isPiHistoryRun(run)) {
    return undefined;
  }
  const [callback] = await db
    .select({ payload: agentRunCallbacks.payload })
    .from(agentRunCallbacks)
    .where(
      and(
        eq(agentRunCallbacks.runId, input.body.runId),
        eq(agentRunCallbacks.internalKind, "pi-memory:phase2"),
      ),
    )
    .limit(1);
  if (!callback) {
    return undefined;
  }
  const parsed = piMemoryPhase2MaintenanceCallbackPayloadSchema.safeParse(
    callback.payload,
  );
  if (
    !parsed.success ||
    !privateMaintenanceIdentityMatches(parsed.data, input, run)
  ) {
    return "[PI_MAINTENANCE_IDENTITY_INVALID] Private output identity does not match its launch";
  }
  const binding = parsed.data;
  if (
    ["completed", "failed", "cancelled"].includes(run.status) &&
    run.existingOutput?.result !== undefined
  ) {
    return finalizedMaintenanceOutput(binding, run, input.body);
  }
  const [result] = await db
    .select({ versionId: maintenanceOutputResultVersion(input.body.runId) })
    .from(piMemoryPhase2Jobs)
    .where(
      or(
        maintenancePublicationResultCondition({
          ...binding,
          runId: input.body.runId,
        }),
        input.recovery || ["failed", "cancelled"].includes(run.status)
          ? maintenanceUnpublishedRecoveryCondition({
              ...binding,
              runId: input.body.runId,
            })
          : undefined,
      ),
    )
    .limit(1);
  const publicationVersionId = maintenancePublicationVersion(result);
  if (publicationVersionId === undefined) {
    return "[PI_MAINTENANCE_OUTPUT_INVALID] Private output lacks exact publication or recovery evidence";
  }
  return privateMaintenanceSnapshotOutput(
    binding,
    run,
    input.body,
    publicationVersionId,
  );
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

function isTerminalPrivatePiRun(run: RunOutputContext): boolean {
  return (
    ["completed", "failed", "cancelled"].includes(run.status) &&
    run.chatThreadId === null &&
    isPiHistoryRun(run)
  );
}

function restoreTerminalPrivateOutput(
  run: RunOutputContext,
  existing: ExistingRunOutput | undefined,
): RunOutputContext | string {
  if (!existing) {
    return run.status === "completed"
      ? "[RUN_OUTPUT_ALREADY_COMMITTED] Final output does not exactly match the committed Run output"
      : run;
  }
  if (
    existing.result !== undefined &&
    !(
      existing.result.framework === existing.type &&
      existing.result.frameworkSessionId === existing.sessionId
    )
  ) {
    return "[RUN_OUTPUT_ALREADY_COMMITTED] Final output does not exactly match the committed Run output";
  }
  return {
    ...run,
    existingOutput: existing,
  };
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
  let run = await lockRunOutputContext(tx, input);
  signal.throwIfAborted();
  if (!run) {
    return notFound("Agent run not found");
  }

  if (isTerminalPrivatePiRun(run)) {
    // Read native identity and exact committed output from the same locked Run.
    const existing = await loadExistingRunOutput(tx, input.body.runId);
    signal.throwIfAborted();
    const terminalRun = restoreTerminalPrivateOutput(run, existing);
    if (typeof terminalRun === "string") {
      return badRequestMessage(terminalRun);
    }
    run = terminalRun;
  }

  const maintenance = await privateMaintenanceOutput(tx, input, run);
  signal.throwIfAborted();
  if (typeof maintenance === "string") {
    return badRequestMessage(maintenance);
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
  }).map((mount) => {
    return maintenance?.memoryStorageId === mount.storageId
      ? { ...mount, version: maintenance.versionId }
      : mount;
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
