import type {
  PiInferenceInput,
  PiInferencePublication,
} from "@okouai/api-contracts/contracts/pi-inference-lifecycle";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunInference } from "@okouai/db/schema/agent-run-inference";
import { command } from "ccstate";
import { and, eq, inArray, lte, or } from "drizzle-orm";
import type { z } from "zod";

import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { settle } from "../utils";
import { dispatchCompleteSideEffects$ } from "./agent-run-lifecycle.service";
import { completeAgentRun$ } from "./agent-webhook-complete.service";
import { decryptPersistentSecretsMap } from "./crypto.utils";
import {
  PI_API_FIRST_TURN_COORDINATION_TIMEOUT_MS,
  type PiApiFirstTurnActivation,
} from "./pi-api-first-turn-config";
import { dispatchConfiguredPiApiFirstTurn$ } from "./pi-api-first-turn-dispatch.service";
import { lockPiApiFirstTurnLifecycle } from "./pi-api-first-turn-lifecycle.service";
import {
  recoverDurablePiPublication$,
  recoverDurablePiUsage$,
} from "./pi-api-first-turn.service";
import {
  piDeferredConfigurationSchema,
  piDeferredContextSchema,
  piDeferredSecretsSchema,
  type PiDeferredConfiguration,
} from "./pi-deferred-sandbox-contract";
import { readPiInferenceObject } from "./pi-inference-object.service";

const L = logger("PiApiInferenceRecovery");
const RECOVERY_BATCH_SIZE = 20;
const PUBLICATION_RECOVERY_TIMEOUT_MS = 2 * 60 * 1000;
const FAILURE_TIMEOUT_MS = 10_000;

interface RecoveryRun {
  readonly id: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly chatThreadId: string;
  readonly apiStartedAt: Date;
}

interface RecoveryClaimBase {
  readonly run: RecoveryRun;
  readonly input: PiInferenceInput;
  readonly ownerEpoch: number;
  readonly providerAttemptId: string;
  readonly deadlineAt: Date;
}

type RecoveryClaim =
  | (RecoveryClaimBase & { readonly kind: "activate" })
  | (RecoveryClaimBase & {
      readonly kind: "publish" | "account";
      readonly publication: PiInferencePublication;
    })
  | (RecoveryClaimBase & { readonly kind: "uncertain" });

type DurablePiApiActivation = Extract<
  PiApiFirstTurnActivation,
  { readonly executionMode: "durable-inference" }
>;
type RecoveryApiInferenceContext = Pick<
  DurablePiApiActivation["executionContext"],
  | "encryptedSecrets"
  | "platformEnvironment"
  | "secretConnectorMap"
  | "secretConnectorMetadataMap"
>;

function recoveryActivation(
  claim: RecoveryClaimBase,
  configuration: PiDeferredConfiguration,
  context: z.infer<typeof piDeferredContextSchema>,
  runtime?: RecoveryApiInferenceContext,
): DurablePiApiActivation {
  const digest = context.resourceSnapshotDigest;
  if (!digest) {
    throw new Error("Durable Pi recovery is missing its resource digest");
  }
  const billing = configuration.apiInferenceBilling;
  if (!billing) {
    throw new Error("Durable Pi recovery is missing its billing capture");
  }
  return {
    executionMode: "durable-inference",
    runId: claim.run.id,
    userId: claim.run.userId,
    orgId: claim.run.orgId,
    prompt: configuration.body.prompt,
    appendSystemPrompt: configuration.body.appendSystemPrompt ?? null,
    inference: {
      ownerEpoch: claim.ownerEpoch,
      providerAttemptId: claim.providerAttemptId,
      configurationHash: claim.input.configurationHash,
      contextHash: claim.input.contextHash,
    },
    executionContext: {
      apiStartTime: claim.run.apiStartedAt.getTime(),
      billableFirewalls: billing.billableFirewalls,
      encryptedSecrets: runtime?.encryptedSecrets ?? null,
      modelUsageProvider: billing.modelUsageProvider,
      platformEnvironment: runtime?.platformEnvironment ?? {},
      secretConnectorMap: runtime?.secretConnectorMap ?? null,
      secretConnectorMetadataMap: runtime?.secretConnectorMetadataMap ?? null,
      piLaunchConfig: {
        schemaVersion: 2,
        ...(context.memoryRecall ? { memoryRecall: context.memoryRecall } : {}),
        apiFirstTurn: {
          schemaVersion: 1,
          resourceSnapshotDigest: digest,
          deadlineAt: claim.deadlineAt.getTime(),
          baseSession: context.baseSession,
          sandboxEventSequenceStart: 1,
        },
      },
      piModelConfig: configuration.modelConfig,
      piSessionId: context.baseSession.sessionId,
      resourceSnapshot: context.resourceSnapshot,
      h0SessionHistory: context.h0SessionHistory,
    },
  };
}

async function readRecoveryObjects(db: Db, claim: RecoveryClaimBase) {
  const owner = {
    runId: claim.run.id,
    userId: claim.run.userId,
    orgId: claim.run.orgId,
  };
  const [configuration, context] = await Promise.all([
    readPiInferenceObject(
      db,
      {
        ...owner,
        kind: "configuration",
        hash: claim.input.configurationHash,
      },
      piDeferredConfigurationSchema,
    ),
    readPiInferenceObject(
      db,
      { ...owner, kind: "context", hash: claim.input.contextHash },
      piDeferredContextSchema,
    ),
  ]);
  return { configuration, context };
}

async function readRecoveryApiInferenceContext(
  db: Db,
  claim: RecoveryClaimBase,
): Promise<RecoveryApiInferenceContext> {
  if (claim.input.deferredSecrets.kind === "none") {
    throw new Error(
      "Durable Pi activation recovery lost its credential object",
    );
  }
  if (new Date(claim.input.deferredSecrets.expiresAt) <= nowDate()) {
    throw new Error("Durable Pi recovery secret envelope expired");
  }
  const envelope = await readPiInferenceObject(
    db,
    {
      runId: claim.run.id,
      userId: claim.run.userId,
      orgId: claim.run.orgId,
      kind: "secrets",
      hash: claim.input.deferredSecrets.objectHash,
    },
    piDeferredSecretsSchema,
  );
  const apiInference = envelope.apiInference;
  if (!apiInference) {
    throw new Error("Durable Pi activation recovery state is unavailable");
  }
  const platformEnvironment = await decryptPersistentSecretsMap(
    apiInference.encryptedPlatformEnvironment,
    { userId: claim.run.userId, orgId: claim.run.orgId },
  );
  return {
    encryptedSecrets: apiInference.encryptedModelSecrets,
    platformEnvironment: platformEnvironment ?? {},
    secretConnectorMap: apiInference.secretConnectorMap,
    secretConnectorMetadataMap: apiInference.secretConnectorMetadataMap,
  };
}

function classifyRecovery(args: {
  readonly phase:
    | "admitted"
    | "ready"
    | "provider"
    | "publishing"
    | "sandbox_preparing"
    | "sandbox_ready"
    | "sandbox_running"
    | "sandbox_waiting"
    | "terminal";
  readonly providerAttemptState: "not-started" | "may-have-started" | "settled";
  readonly publication: PiInferencePublication | null;
  readonly usageSettled: boolean;
}): RecoveryClaim["kind"] | null {
  if (args.phase === "ready" && args.providerAttemptState === "not-started") {
    return "activate";
  }
  if (
    args.phase === "publishing" &&
    args.providerAttemptState === "settled" &&
    args.publication
  ) {
    return "publish";
  }
  if (
    args.phase === "terminal" &&
    args.providerAttemptState === "settled" &&
    args.publication &&
    !args.usageSettled
  ) {
    return "account";
  }
  return args.phase === "provider" &&
    args.providerAttemptState === "may-have-started"
    ? "uncertain"
    : null;
}

async function claimExpiredRecovery(
  db: Db,
  runId: string,
  at: Date,
): Promise<RecoveryClaim | null> {
  return await db.transaction(async (tx) => {
    await lockPiApiFirstTurnLifecycle(tx, runId);
    const [row] = await tx
      .select({
        id: agentRuns.id,
        sessionId: agentRuns.sessionId,
        userId: agentRuns.userId,
        orgId: agentRuns.orgId,
        chatThreadId: agentRuns.chatThreadId,
        apiStartedAt: agentRuns.apiStartedAt,
        status: agentRuns.status,
        launchSnapshot: agentRuns.launchSnapshot,
        input: agentRunInference.input,
        phase: agentRunInference.phase,
        activationReady: agentRunInference.activationReady,
        ownerEpoch: agentRunInference.ownerEpoch,
        deadlineAt: agentRunInference.deadlineAt,
        providerAttemptId: agentRunInference.providerAttemptId,
        providerAttemptState: agentRunInference.providerAttemptState,
        publication: agentRunInference.publication,
        usageSettled: agentRunInference.usageSettled,
      })
      .from(agentRuns)
      .innerJoin(agentRunInference, eq(agentRunInference.runId, agentRuns.id))
      .where(eq(agentRuns.id, runId))
      .limit(1);
    if (
      !row ||
      !row.chatThreadId ||
      !row.apiStartedAt ||
      row.launchSnapshot?.schemaVersion !== 4 ||
      row.launchSnapshot.executionMode !== "api-inference" ||
      !row.activationReady ||
      row.deadlineAt > at
    ) {
      return null;
    }
    // Only the producer writes the encrypted activation envelope. Foundation
    // and consumer-only fixtures retain their established timeout owner.
    if (row.input.deferredSecrets.kind !== "encrypted") {
      return null;
    }
    const kind = classifyRecovery(row);
    if (
      !kind ||
      (kind === "account"
        ? !["completed", "failed", "timeout", "cancelled"].includes(row.status)
        : !["pending", "running"].includes(row.status))
    ) {
      return null;
    }
    const ownerEpoch = row.ownerEpoch + 1;
    const deadlineAt = new Date(
      at.getTime() +
        (kind === "publish" || kind === "account"
          ? PUBLICATION_RECOVERY_TIMEOUT_MS
          : PI_API_FIRST_TURN_COORDINATION_TIMEOUT_MS),
    );
    const [claimed] = await tx
      .update(agentRunInference)
      .set({ ownerEpoch, deadlineAt })
      .where(
        and(
          eq(agentRunInference.runId, runId),
          eq(agentRunInference.ownerEpoch, row.ownerEpoch),
          eq(agentRunInference.phase, row.phase),
          eq(agentRunInference.providerAttemptState, row.providerAttemptState),
          lte(agentRunInference.deadlineAt, at),
          ...(kind === "account"
            ? [eq(agentRunInference.usageSettled, false)]
            : []),
        ),
      )
      .returning({ runId: agentRunInference.runId });
    if (!claimed) {
      return null;
    }
    const base: RecoveryClaimBase = {
      run: {
        id: row.id,
        sessionId: row.sessionId,
        userId: row.userId,
        orgId: row.orgId,
        chatThreadId: row.chatThreadId,
        apiStartedAt: row.apiStartedAt,
      },
      input: row.input,
      ownerEpoch,
      providerAttemptId: row.providerAttemptId,
      deadlineAt,
    };
    return kind === "publish" || kind === "account"
      ? { ...base, kind, publication: row.publication! }
      : { ...base, kind };
  });
}

const failRecoveredInference$ = command(
  async (
    { set },
    claim: RecoveryClaimBase,
    message: string,
    parentSignal: AbortSignal,
  ): Promise<void> => {
    const signal = AbortSignal.any([
      parentSignal,
      AbortSignal.timeout(FAILURE_TIMEOUT_MS),
    ]);
    const completion = await set(
      completeAgentRun$,
      {
        inferenceOwnerEpoch: claim.ownerEpoch,
        auth: {
          runId: claim.run.id,
          userId: claim.run.userId,
          orgId: claim.run.orgId,
        },
        executionOwner: "api-first",
        suppressFailureLog: false,
        body: { runId: claim.run.id, exitCode: 1, error: message },
      },
      signal,
    );
    signal.throwIfAborted();
    if (completion.status !== 200) {
      throw new Error("Recovered Pi inference failure was rejected");
    }
    if (completion.sideEffects) {
      await set(
        dispatchCompleteSideEffects$,
        {
          ...completion.sideEffects,
          apiStartTime: claim.run.apiStartedAt.getTime(),
        },
        signal,
      );
      signal.throwIfAborted();
    }
  },
);

const recoverClaim$ = command(
  async (
    { set },
    db: Db,
    claim: RecoveryClaim,
    signal: AbortSignal,
  ): Promise<void> => {
    if (claim.kind === "uncertain") {
      await set(
        failRecoveredInference$,
        claim,
        "Durable Pi provider outcome remained uncertain after owner loss",
        signal,
      );
      signal.throwIfAborted();
      return;
    }
    const { configuration, context } = await readRecoveryObjects(db, claim);
    signal.throwIfAborted();
    if (claim.kind === "account") {
      await set(
        recoverDurablePiUsage$,
        recoveryActivation(claim, configuration, context),
        claim.publication,
        signal,
      );
      signal.throwIfAborted();
      return;
    }
    if (claim.kind === "publish") {
      const sideEffects = await set(
        recoverDurablePiPublication$,
        recoveryActivation(claim, configuration, context),
        claim.publication,
        signal,
      );
      signal.throwIfAborted();
      if (sideEffects) {
        await set(dispatchCompleteSideEffects$, sideEffects, signal);
        signal.throwIfAborted();
      }
      return;
    }
    const runtime = await readRecoveryApiInferenceContext(db, claim);
    signal.throwIfAborted();
    const activation = recoveryActivation(
      claim,
      configuration,
      context,
      runtime,
    );
    await set(
      dispatchConfiguredPiApiFirstTurn$,
      activation,
      undefined,
      AbortSignal.timeout(Math.max(1, claim.deadlineAt.getTime() - now())),
    );
    signal.throwIfAborted();
  },
);

export const recoverDurablePiApiInference$ = command(
  async (
    { set },
    runIds: readonly string[] | null,
    signal: AbortSignal,
  ): Promise<number> => {
    if (runIds?.length === 0) {
      return 0;
    }
    const db = set(writeDb$);
    const at = nowDate();
    const candidates = await db
      .select({ runId: agentRunInference.runId })
      .from(agentRunInference)
      .innerJoin(agentRuns, eq(agentRuns.id, agentRunInference.runId))
      .where(
        and(
          lte(agentRunInference.deadlineAt, at),
          or(
            and(
              inArray(agentRunInference.phase, [
                "ready",
                "provider",
                "publishing",
              ]),
              inArray(agentRuns.status, ["pending", "running"]),
            ),
            and(
              eq(agentRunInference.phase, "terminal"),
              eq(agentRunInference.providerAttemptState, "settled"),
              eq(agentRunInference.usageSettled, false),
              inArray(agentRuns.status, [
                "completed",
                "failed",
                "timeout",
                "cancelled",
              ]),
            ),
          ),
          ...(runIds ? [inArray(agentRunInference.runId, runIds)] : []),
        ),
      )
      .orderBy(agentRunInference.deadlineAt)
      .limit(RECOVERY_BATCH_SIZE);
    signal.throwIfAborted();
    let recovered = 0;
    for (const candidate of candidates) {
      signal.throwIfAborted();
      const claim = await claimExpiredRecovery(db, candidate.runId, at);
      signal.throwIfAborted();
      if (!claim) {
        continue;
      }
      const result = await settle(
        set(recoverClaim$, db, claim, signal),
        signal,
      );
      signal.throwIfAborted();
      if (result.ok) {
        recovered += 1;
        continue;
      }
      L.error("Durable Pi inference recovery failed", {
        runId: claim.run.id,
        kind: claim.kind,
        error: result.error,
      });
      if (
        (claim.kind === "activate" || claim.kind === "publish") &&
        claim.ownerEpoch >= 4
      ) {
        const failed = await settle(
          set(
            failRecoveredInference$,
            claim,
            result.error instanceof Error
              ? result.error.message
              : "Durable Pi inference recovery failed",
            signal,
          ),
        );
        signal.throwIfAborted();
        if (!failed.ok) {
          L.error("Durable Pi recovery could not terminalize its run", {
            runId: claim.run.id,
            error: failed.error,
          });
        }
      }
    }
    return recovered;
  },
);
