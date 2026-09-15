import { hasUndeliveredRunCallbacks } from "./agent-run-callback.service";
import {
  COMPUTE_CLOSURE_ERROR,
  failDeferredPiRun,
} from "./agent-run-terminal-transition.service";
import { finalizeActiveInputDelivery } from "./active-input-delivery.service";
import { dispatchCompleteSideEffectsCore$ } from "./agent-webhook-complete.service";
import type { z } from "zod";
import { logger } from "../../lib/log";
import { settle } from "../utils";
import { agentRunInferenceObjects } from "@okouai/db/schema/pi-inference-object";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { command } from "ccstate";
import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNull,
  isNotNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { inspectPiSessionJsonl } from "@okouai/pi-agent-runtime/api";
import {
  claimCompatibleStoredExecutionContextSchema,
  piDeferredSandboxConfigSchema,
  type PiDeferredSandboxConfig,
} from "@okouai/api-contracts/contracts/runners";
import {
  piSandboxContinuationSchema,
  type PiSandboxContinuation,
} from "@okouai/api-contracts/contracts/pi-inference-lifecycle";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import {
  agentRunInference,
  agentRunSandboxIntent,
  agentRunSandboxLease,
} from "@okouai/db/schema/agent-run-inference";
import { agentRunQueue } from "@okouai/db/schema/agent-run-queue";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import type { Tx } from "../../lib/db-types";
import { nowDate, now } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import {
  prepareComputeRunAdmission,
  validateComputeRunAdmission,
  validateComputeRunCleanupOwnership,
  stopClosedComputeCandidate,
  withComputeOwnershipRetry,
} from "./compute-erasure-admission.service";
import {
  isPiInferenceRun,
  readPiInferenceLifecycle,
} from "./pi-inference-lifecycle.service";
import {
  cappedBaseConcurrencyLimit,
  loadOrgConcurrencyState,
  totalConcurrencyLimit,
} from "./org-concurrency-entitlements.service";
import {
  readPiInferenceObject,
  readPublishedPiInferenceObject,
  retainPiInferenceObject,
} from "./pi-inference-object.service";
import {
  piDeferredConfigurationSchema,
  piDeferredContextSchema,
  piDeferredH1Schema,
  piDeferredSecretsSchema,
} from "./pi-deferred-sandbox-contract";
import { decryptPersistentSecretsMap } from "./crypto.utils";
import {
  materializeDeferredPiRun$,
  lockDeferredPiCatalog,
  validateDeferredPiMaterialization,
  type DeferredPiMaterializationAdmission,
} from "./agent-run-create.service";

const ATTEMPT_MS = 120_000;
const RUN_MS = 2 * 60 * 60 * 1000;
const digest = (value: string) => {
  return createHash("sha256").update(value).digest("hex");
};
type Run = typeof agentRuns.$inferSelect;
interface PiSandboxFence {
  readonly runId: string;
  readonly ownerEpoch: number;
  readonly generation: number;
}

/** Discovery grants no authority. Every writing callback receives a new complete
 * sorted B1 admission, capacity lock, thread lock, then run/session validation. */
async function withDeferredAdmission<T>(
  db: Db,
  runId: string,
  mutate: (tx: Tx, run: Run, closed: boolean) => Promise<T>,
  catalog?: DeferredPiMaterializationAdmission,
  cleanupOnly = false,
): Promise<T | undefined> {
  return await withComputeOwnershipRetry(async () => {
    const [owner] = await db
      .select({
        userId: agentRuns.userId,
        orgId: agentRuns.orgId,
        agentId: agentSessions.agentId,
        input: agentRunInference.input,
      })
      .from(agentRuns)
      .innerJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
      .innerJoin(agentRunInference, eq(agentRunInference.runId, agentRuns.id))
      .where(eq(agentRuns.id, runId));
    if (!owner) {
      return undefined;
    }
    const captured = await readPublishedPiInferenceObject(
      db,
      { ...owner, hash: owner.input.configurationHash, kind: "configuration" },
      piDeferredConfigurationSchema,
    );
    if (!cleanupOnly && (captured.body.agentId ?? null) !== owner.agentId) {
      throw new Error("Captured Pi Agent identity changed");
    }
    return db.transaction(async (tx) => {
      const admission = await prepareComputeRunAdmission(tx, runId, {
        ...owner,
        resourceOwner: cleanupOnly ? undefined : captured.resourceOwner,
        capturedCleanupOwner: cleanupOnly ? captured.resourceOwner : undefined,
      });
      if (!admission) {
        throw new Error("Captured Pi resource ownership changed");
      }
      if (catalog) {
        await lockDeferredPiCatalog(tx, catalog);
      }
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${owner.orgId}))`,
      );
      await tx
        .select({ id: chatThreads.id })
        .from(chatThreads)
        .where(
          inArray(
            chatThreads.id,
            tx
              .select({ id: agentRuns.chatThreadId })
              .from(agentRuns)
              .where(eq(agentRuns.id, runId)),
          ),
        )
        .orderBy(chatThreads.id)
        .for("update");
      if (
        !(await (cleanupOnly
          ? validateComputeRunCleanupOwnership(tx, admission)
          : validateComputeRunAdmission(tx, admission)))
      ) {
        if (!cleanupOnly) {
          const [rejected] = await tx
            .select()
            .from(agentRuns)
            .where(
              and(
                eq(agentRuns.id, runId),
                exists(
                  tx
                    .select({ runId: agentRunSandboxIntent.runId })
                    .from(agentRunSandboxIntent)
                    .where(eq(agentRunSandboxIntent.runId, runId)),
                ),
              ),
            );
          if (
            rejected?.status === "pending" &&
            isPiInferenceRun(rejected.launchSnapshot)
          ) {
            const at = nowDate();
            await failDeferredPiRun(tx, {
              runId: runId,
              snapshot: rejected.launchSnapshot,
              at,
              status: "cancelled",
              error: "Deferred Pi maintenance authority expired",
            });
          }
        }
        return undefined;
      }
      if (admission.closed && !cleanupOnly) {
        await stopClosedComputeCandidate(tx, admission);
        return undefined;
      }
      const [run] = await tx
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, runId));
      if (!run || !isPiInferenceRun(run.launchSnapshot)) {
        return undefined;
      }
      return mutate(tx, run, admission.closed);
    });
  });
}

/** Durable producer interface for #34244. It only accepts an already admitted
 * inference owner; this change adds no API producer or switch activation. */
async function commitPiSandboxDemand(
  db: Db,
  fence: PiSandboxFence,
  continuation: PiSandboxContinuation,
): Promise<boolean> {
  const parsed = piSandboxContinuationSchema.parse(continuation);
  return (
    (await withDeferredAdmission(db, fence.runId, async (tx, run) => {
      const lifecycle = await readPiInferenceLifecycle(
        tx,
        run.id,
        run.launchSnapshot,
      );
      if (
        !lifecycle ||
        lifecycle.inference.ownerEpoch !== fence.ownerEpoch ||
        run.status !== "pending"
      ) {
        return false;
      }
      if (lifecycle.intent) {
        return (
          lifecycle.intent.generation === fence.generation &&
          isDeepStrictEqual(lifecycle.intent.continuation, parsed)
        );
      }
      if (
        lifecycle.inference.deadlineAt <= nowDate() ||
        !["admitted", "ready", "publishing"].includes(lifecycle.inference.phase)
      ) {
        return false;
      }
      if (
        fence.generation !== 1 ||
        !lifecycle.inference.activationReady ||
        (parsed.mode === "untouched-h0"
          ? lifecycle.inference.phase !== "ready" ||
            lifecycle.inference.providerAttemptState !== "not-started"
          : lifecycle.inference.phase !== "publishing")
      ) {
        return false;
      }
      const input = lifecycle.inference.input;
      const reference = { runId: run.id, userId: run.userId, orgId: run.orgId };
      await retainPiInferenceObject(tx, {
        ...reference,
        kind: "configuration",
        hash: input.configurationHash,
      });
      await retainPiInferenceObject(tx, {
        ...reference,
        kind: "context",
        hash: input.contextHash,
      });
      if (input.deferredSecrets.kind === "encrypted") {
        await retainPiInferenceObject(tx, {
          ...reference,
          kind: "secrets",
          hash: input.deferredSecrets.objectHash,
        });
      }
      if (parsed.mode !== "untouched-h0") {
        const receipt = lifecycle.inference.publication;
        if (
          !receipt ||
          receipt.h1Hash !== parsed.h1Hash ||
          receipt.manifestGeneration !== parsed.manifestGeneration ||
          receipt.lastEventSequence !== parsed.lastEventSequence
        ) {
          throw new Error("Pi demand does not match the H1 publication");
        }
        await retainPiInferenceObject(tx, {
          ...reference,
          kind: "h1",
          hash: parsed.h1Hash,
        });
      }
      const at = nowDate();
      await tx.insert(agentRunSandboxIntent).values({
        runId: run.id,
        ownerEpoch: fence.ownerEpoch,
        generation: fence.generation,
        state: "waiting",
        continuation: parsed,
        enqueuedAt: at,
        expiresAt: new Date(at.getTime() + RUN_MS),
      });
      await tx
        .update(agentRunInference)
        .set({ phase: "sandbox_waiting" })
        .where(eq(agentRunInference.runId, run.id));
      return true;
    })) ?? false
  );
}

export async function publishPiSandboxDemand(
  db: Db,
  fence: PiSandboxFence,
  continuation: PiSandboxContinuation,
): Promise<boolean> {
  const accepted = await commitPiSandboxDemand(db, fence, continuation);
  if (accepted) {
    const [intent] = await db
      .select({ enqueuedAt: agentRunSandboxIntent.enqueuedAt })
      .from(agentRunSandboxIntent)
      .where(eq(agentRunSandboxIntent.runId, fence.runId));
    logger("PiDeferredSandbox").debug("Deferred Sandbox intent committed", {
      ...fence,
      enqueuedAt: intent?.enqueuedAt.getTime(),
    });
  }
  return accepted;
}

function retainedDemand(tx: Pick<Db, "select">) {
  return and(
    ...["configuration", "context"].map((kind) => {
      return exists(
        tx
          .select({ hash: agentRunInferenceObjects.hash })
          .from(agentRunInferenceObjects)
          .where(
            and(
              eq(agentRunInferenceObjects.runId, agentRunSandboxIntent.runId),
              eq(agentRunInferenceObjects.kind, kind),
            ),
          ),
      );
    }),
  );
}

export async function listDeferredPiCandidates(
  db: Pick<Db, "select">,
  orgId: string,
) {
  return await db
    .select({
      runId: agentRunSandboxIntent.runId,
      createdAt: agentRunSandboxIntent.enqueuedAt,
    })
    .from(agentRunSandboxIntent)
    .innerJoin(agentRuns, eq(agentRuns.id, agentRunSandboxIntent.runId))
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        eq(agentRuns.status, "pending"),
        eq(agentRunSandboxIntent.state, "waiting"),
        retainedDemand(db),
      ),
    )
    .orderBy(
      asc(agentRunSandboxIntent.enqueuedAt),
      asc(agentRunSandboxIntent.runId),
    )
    .limit(100);
}

/** Both queue writers call this while owning the same org capacity lock. */
export async function hasEarlierDeferredDemand(
  tx: Tx,
  orgId: string,
  at: Date,
  runId: string,
): Promise<boolean> {
  const [earlier] = await tx
    .select({ id: agentRunSandboxIntent.runId })
    .from(agentRunSandboxIntent)
    .innerJoin(agentRuns, eq(agentRuns.id, agentRunSandboxIntent.runId))
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        eq(agentRuns.status, "pending"),
        eq(agentRunSandboxIntent.state, "waiting"),
        retainedDemand(tx),
        or(
          lt(agentRunSandboxIntent.enqueuedAt, at),
          and(
            eq(agentRunSandboxIntent.enqueuedAt, at),
            lt(agentRunSandboxIntent.runId, runId),
          ),
        ),
      ),
    )
    .limit(1);
  return !!earlier;
}

async function reserveDeferredPiRun(db: Db, runId: string) {
  return await withDeferredAdmission(db, runId, async (tx, run) => {
    const lifecycle = await readPiInferenceLifecycle(
      tx,
      runId,
      run.launchSnapshot,
    );
    if (
      !lifecycle ||
      lifecycle.inference.phase !== "sandbox_waiting" ||
      !lifecycle.intent
    ) {
      return undefined;
    }
    const at = nowDate();
    if (lifecycle.intent.expiresAt <= at) {
      await failDeferredPiRun(tx, {
        runId: runId,
        snapshot: run.launchSnapshot,
        at,
        status: "timeout",
        error: "Deferred Pi demand expired",
      });
      return undefined;
    }
    const [legacy] = await tx
      .select({ id: agentRunQueue.runId })
      .from(agentRunQueue)
      .innerJoin(agentRuns, eq(agentRuns.id, agentRunQueue.runId))
      .where(
        and(
          eq(agentRunQueue.orgId, run.orgId),
          eq(agentRuns.status, "queued"),
          sql`${agentRuns.triggerSource} IS DISTINCT FROM 'goal'`,
          or(
            lt(agentRunQueue.createdAt, lifecycle.intent.enqueuedAt),
            and(
              eq(agentRunQueue.createdAt, lifecycle.intent.enqueuedAt),
              lt(agentRunQueue.runId, runId),
            ),
          ),
        ),
      )
      .limit(1);
    if (
      legacy ||
      (await hasEarlierDeferredDemand(
        tx,
        run.orgId,
        lifecycle.intent.enqueuedAt,
        runId,
      ))
    ) {
      return undefined;
    }
    const capacity = await loadOrgConcurrencyState(tx, {
      orgId: run.orgId,
      at,
      activePendingAfter: new Date(at.getTime() - 15 * 60 * 1000),
    });
    if (
      capacity.activeRunCount >=
      totalConcurrencyLimit({
        baseLimit: cappedBaseConcurrencyLimit(capacity.baseConcurrencyLimit),
        paidSlots: capacity.paidSlots,
      })
    ) {
      return undefined;
    }
    const ownerEpoch = lifecycle.inference.ownerEpoch + 1;
    const deadlineAt = new Date(
      Math.min(at.getTime() + ATTEMPT_MS, lifecycle.intent.expiresAt.getTime()),
    );
    await tx
      .update(agentRunInference)
      .set({ phase: "sandbox_preparing", ownerEpoch })
      .where(eq(agentRunInference.runId, runId));
    await tx
      .update(agentRunSandboxIntent)
      .set({
        state: "preparing",
        ownerEpoch,
        attemptDeadlineAt: deadlineAt,
        attempts: sql`${agentRunSandboxIntent.attempts} + 1`,
      })
      .where(eq(agentRunSandboxIntent.runId, runId));
    await tx
      .insert(agentRunSandboxLease)
      .values({ runId, state: "preparing", ownerEpoch, deadlineAt })
      .onConflictDoUpdate({
        target: agentRunSandboxLease.runId,
        set: {
          state: "preparing",
          ownerEpoch,
          deadlineAt,
          releaseEvidence: null,
          runnerId: null,
        },
        setWhere: eq(agentRunSandboxLease.state, "released"),
      });
    return {
      runId,
      ownerEpoch,
      generation: lifecycle.intent.generation,
      enqueuedAt: lifecycle.intent.enqueuedAt.getTime(),
      apiStartedAt: run.apiStartedAt?.getTime(),
    };
  });
}

function validateCapturedExecution(
  run: Run,
  configuration: z.infer<typeof piDeferredConfigurationSchema>,
): void {
  if (
    configuration.selectedModel !== run.selectedModel ||
    configuration.modelProviderType !== run.modelProvider ||
    configuration.modelProviderId !== run.modelProviderId ||
    configuration.modelProviderCredentialScope !==
      run.modelProviderCredentialScope ||
    configuration.builtInModelRuntimeRoute?.modelKeyId !==
      (run.builtInModelKeyId ?? undefined) ||
    configuration.body.prompt !== run.prompt ||
    (configuration.body.appendSystemPrompt ?? null) !== run.appendSystemPrompt
  ) {
    throw new Error("Pi captured execution identity mismatch");
  }
}
function validateCapturedRuntime(
  run: Run,
  configuration: z.infer<typeof piDeferredConfigurationSchema>,
): void {
  if (
    configuration.runtimeProvider !== run.modelRuntimeProvider ||
    configuration.runtimeModel !== run.modelRuntimeModel ||
    (configuration.codexServiceTier ?? null) !== run.codexServiceTier ||
    (configuration.reasoningEffort ?? null) !== run.reasoningEffort ||
    !isDeepStrictEqual(configuration.body.vars ?? null, run.vars)
  ) {
    throw new Error("Pi captured model/input metadata mismatch");
  }
}
function validateCapturedH0(
  run: Run,
  context: z.infer<typeof piDeferredContextSchema>,
  input: (typeof agentRunInference.$inferSelect)["input"],
): void {
  if (
    context.baseSession.sessionId !== (run.chatThreadId ?? run.id) ||
    context.baseSession.sha256 !==
      (input.h0.kind === "history" ? input.h0.historyHash : null) ||
    (input.h0.kind === "history" &&
      digest(context.h0SessionHistory) !== input.h0.historyHash)
  ) {
    throw new Error("Pi captured H0 identity mismatch");
  }
}

async function readDeferredSecrets(
  db: Db,
  run: Run,
  deferredSecrets: (typeof agentRunInference.$inferSelect)["input"]["deferredSecrets"],
) {
  let secrets: Record<string, string> | undefined;
  if (deferredSecrets.kind === "encrypted") {
    if (new Date(deferredSecrets.expiresAt) <= nowDate()) {
      throw new Error("Deferred Pi secret envelope expired");
    }
    const envelope = await readPiInferenceObject(
      db,
      {
        runId: run.id,
        orgId: run.orgId,
        userId: run.userId,
        kind: "secrets",
        hash: deferredSecrets.objectHash,
      },
      piDeferredSecretsSchema,
    );
    secrets =
      (await decryptPersistentSecretsMap(envelope.ciphertext, {
        orgId: run.orgId,
        userId: run.userId,
      })) ?? undefined;
  }
  return secrets;
}

function validateCapturedSession(
  context: z.infer<typeof piDeferredContextSchema>,
  continuation: PiSandboxContinuation,
  h1: z.infer<typeof piDeferredH1Schema> | undefined,
  sessionHistory: string,
): void {
  const inspection = inspectPiSessionJsonl(sessionHistory);
  if (
    inspection.sessionId !== context.baseSession.sessionId ||
    (h1 &&
      (digest(sessionHistory) !== h1.historyHash ||
        continuation.mode === "untouched-h0" ||
        h1.manifestGeneration !== continuation.manifestGeneration ||
        h1.lastEventSequence !== continuation.lastEventSequence))
  ) {
    throw new Error("Pi durable session integrity mismatch");
  }
  if (
    continuation.mode === "pending-tools" &&
    JSON.stringify(inspection.pendingToolIds) !==
      JSON.stringify(continuation.pendingToolIds)
  ) {
    throw new Error("Pi pending tool identity mismatch");
  }
  if (
    continuation.mode === "settled-session" &&
    inspection.hasPendingToolCalls
  ) {
    throw new Error("Settled Pi session has pending tools");
  }
}

async function readMaterialization(db: Db, fence: PiSandboxFence) {
  const [run] = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, fence.runId));
  if (!run?.apiStartedAt) {
    throw new Error("Pi materialization lost original API clock");
  }
  const lifecycle = await readPiInferenceLifecycle(
    db,
    run.id,
    run.launchSnapshot,
  );
  if (
    !lifecycle?.intent ||
    lifecycle.inference.phase !== "sandbox_preparing" ||
    lifecycle.inference.ownerEpoch !== fence.ownerEpoch ||
    lifecycle.intent.generation !== fence.generation
  ) {
    throw new Error("Stale Pi materializer");
  }
  const input = lifecycle.inference.input;
  const owner = { runId: run.id, orgId: run.orgId, userId: run.userId };
  const configuration = await readPiInferenceObject(
    db,
    { ...owner, kind: "configuration", hash: input.configurationHash },
    piDeferredConfigurationSchema,
  );
  const context = await readPiInferenceObject(
    db,
    { ...owner, kind: "context", hash: input.contextHash },
    piDeferredContextSchema,
  );
  validateCapturedExecution(run, configuration);
  validateCapturedRuntime(run, configuration);
  validateCapturedH0(run, context, input);
  const continuation = lifecycle.intent.continuation;
  const h1 =
    continuation.mode === "untouched-h0"
      ? undefined
      : await readPiInferenceObject(
          db,
          { ...owner, kind: "h1", hash: continuation.h1Hash },
          piDeferredH1Schema,
        );
  const sessionHistory = h1?.sessionHistory ?? context.h0SessionHistory;
  validateCapturedSession(context, continuation, h1, sessionHistory);
  const secrets = await readDeferredSecrets(db, run, input.deferredSecrets);
  const handoff = piDeferredSandboxConfigSchema.parse({
    schemaVersion: 2,
    ownerEpoch: fence.ownerEpoch,
    generation: fence.generation,
    deadlineAt: lifecycle.intent.expiresAt.getTime(),
    baseSession: context.baseSession,
    sandboxEventSequenceStart:
      continuation.mode === "untouched-h0"
        ? 1
        : continuation.lastEventSequence + 1,
    continuation,
    runId: run.id,
    activeInput: run.chatThreadId !== null,
    historyHash: digest(sessionHistory),
    resourceSnapshotDigest: digest(JSON.stringify(context.resourceSnapshot)),
  });
  return {
    run: { ...run, apiStartedAt: run.apiStartedAt },
    configuration,
    context,
    handoff,
    secrets,
  };
}

export const consumeDeferredPiRun$ = command(
  async ({ set }, runId: string, signal: AbortSignal): Promise<boolean> => {
    const db = set(writeDb$);
    const reservationStartedAt = now();
    const fence = await reserveDeferredPiRun(db, runId);
    signal.throwIfAborted();
    if (!fence) {
      await set(settleDeferredPiTerminal$, runId, signal);
      return false;
    }
    const reservedAt = now();
    logger("PiDeferredSandbox").debug(
      "Deferred Sandbox reservation committed",
      {
        ...fence,
        reservedAt,
        capacityWaitMs: reservedAt - fence.enqueuedAt,
        reservationMs: reservedAt - reservationStartedAt,
      },
    );
    // I/O and environment preparation run only after reservation has committed.
    const input = await readMaterialization(db, fence);
    signal.throwIfAborted();
    const prepared = await set(materializeDeferredPiRun$, input, signal);
    signal.throwIfAborted();
    const materializedAt = now();
    logger("PiDeferredSandbox").debug(
      "Deferred Sandbox materialization completed",
      {
        ...fence,
        materializedAt,
        materializationMs: materializedAt - reservedAt,
      },
    );
    const published =
      (await withDeferredAdmission(
        db,
        runId,
        async (tx, run) => {
          const lifecycle = await readPiInferenceLifecycle(
            tx,
            runId,
            run.launchSnapshot,
          );
          const at = nowDate();
          if (
            !lifecycle?.intent ||
            !lifecycle.lease ||
            lifecycle.inference.phase !== "sandbox_preparing" ||
            lifecycle.inference.ownerEpoch !== fence.ownerEpoch ||
            lifecycle.intent.generation !== fence.generation ||
            lifecycle.lease.ownerEpoch !== fence.ownerEpoch ||
            lifecycle.lease.deadlineAt <= at ||
            !lifecycle.intent.attemptDeadlineAt ||
            lifecycle.intent.attemptDeadlineAt <= at ||
            lifecycle.intent.expiresAt <= at
          ) {
            return false;
          }
          await validateDeferredPiMaterialization(tx, {
            admission: prepared.admission,
            run,
            mounts: prepared.runStorageMounts,
          });
          const payload = prepared.runnerJobPayload;
          await tx.insert(runnerJobQueue).values({
            runId,
            runnerGroup: payload.runnerGroup,
            profile: payload.profile,
            cliAgentSessionId: payload.cliAgentSessionId,
            reuseKey: null,
            executionContext: payload.executionContext,
            createdAt: at,
            expiresAt: lifecycle.intent.expiresAt,
          });
          await tx
            .update(agentRuns)
            .set({
              runnerGroup: payload.runnerGroup,
              storageMounts: [...prepared.runStorageMounts],
            })
            .where(eq(agentRuns.id, runId));
          await tx
            .update(agentRunInference)
            .set({ phase: "sandbox_ready" })
            .where(eq(agentRunInference.runId, runId));
          await tx
            .update(agentRunSandboxIntent)
            .set({ state: "ready" })
            .where(eq(agentRunSandboxIntent.runId, runId));
          await tx
            .update(agentRunSandboxLease)
            .set({ state: "ready", deadlineAt: lifecycle.intent.expiresAt })
            .where(eq(agentRunSandboxLease.runId, runId));
          return true;
        },
        prepared.admission,
      )) ?? false;
    logger("PiDeferredSandbox").debug("Deferred Sandbox publication settled", {
      ...fence,
      published,
      publishedAt: now(),
      publicationMs: now() - materializedAt,
    });
    return published;
  },
);

/** Lost materializers cannot have dispatched a Sandbox: the claim serializes on
 * the Run and requires a ready lease + job. Fencing first makes deletion proof. */
async function recoverDeferredPiPreparation(
  db: Db,
  runId: string,
): Promise<boolean> {
  return (
    (await withDeferredAdmission(
      db,
      runId,
      async (tx, run) => {
        const lifecycle = await readPiInferenceLifecycle(
          tx,
          runId,
          run.launchSnapshot,
        );
        if (
          !lifecycle?.intent ||
          !lifecycle.lease ||
          lifecycle.lease.runnerId !== null
        ) {
          return false;
        }
        if (
          lifecycle.inference.phase === "terminal" &&
          lifecycle.lease.state === "releasing"
        ) {
          await tx
            .delete(runnerJobQueue)
            .where(eq(runnerJobQueue.runId, runId));
          await tx
            .update(agentRunSandboxLease)
            .set({
              state: "released",
              releaseEvidence: "unclaimed:terminal-fenced-job-removed",
            })
            .where(eq(agentRunSandboxLease.runId, runId));
          return true;
        }
        if (
          lifecycle.inference.phase !== "sandbox_preparing" ||
          lifecycle.lease.deadlineAt > nowDate()
        ) {
          return false;
        }
        if (
          lifecycle.intent.attempts >= 3 ||
          lifecycle.intent.expiresAt <= nowDate()
        ) {
          const at = nowDate();
          await failDeferredPiRun(tx, {
            runId: runId,
            snapshot: run.launchSnapshot,
            at,
            status: "failed",
            error:
              "Deferred Pi preparation did not complete within its retry budget",
          });
          await tx
            .delete(runnerJobQueue)
            .where(eq(runnerJobQueue.runId, runId));
          await tx
            .update(agentRunSandboxLease)
            .set({
              state: "released",
              releaseEvidence: "unclaimed:retry-budget-exhausted-job-removed",
            })
            .where(eq(agentRunSandboxLease.runId, runId));
          return true;
        }
        await tx.delete(runnerJobQueue).where(eq(runnerJobQueue.runId, runId));
        const ownerEpoch = lifecycle.inference.ownerEpoch + 1;
        await tx
          .update(agentRunInference)
          .set({ phase: "sandbox_waiting", ownerEpoch })
          .where(eq(agentRunInference.runId, runId));
        await tx
          .update(agentRunSandboxIntent)
          .set({
            state: "waiting",
            ownerEpoch,
            generation: lifecycle.intent.generation + 1,
            attemptDeadlineAt: null,
          })
          .where(eq(agentRunSandboxIntent.runId, runId));
        await tx
          .update(agentRunSandboxLease)
          .set({
            state: "released",
            ownerEpoch,
            releaseEvidence: "unclaimed:run-locked-job-removed",
          })
          .where(eq(agentRunSandboxLease.runId, runId));
        return true;
      },
      undefined,
      true,
    )) ?? false
  );
}

/** Called after the Runner route's fresh B1 and ownership admission. The job
 * decoded before I/O is only a candidate; compare its fence to the locked job. */
export async function claimDeferredPiJob(
  tx: Tx,
  args: {
    readonly fence: PiDeferredSandboxConfig;
    readonly runId: string;
    readonly runnerId: string;
    readonly heartbeatGeneration: number;
    readonly runnerHostname: string | null;
    readonly runnerVersion: string | null;
  },
): Promise<Date | undefined> {
  const [run] = await tx
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, args.runId))
    .for("update");
  if (
    !run ||
    !isPiInferenceRun(run.launchSnapshot) ||
    run.status !== "pending"
  ) {
    return undefined;
  }
  const lifecycle = await readPiInferenceLifecycle(
    tx,
    run.id,
    run.launchSnapshot,
  );
  const [job] = await tx
    .select({
      context: runnerJobQueue.executionContext,
      expiresAt: runnerJobQueue.expiresAt,
    })
    .from(runnerJobQueue)
    .where(eq(runnerJobQueue.runId, run.id))
    .for("update");
  const at = nowDate();
  if (
    !lifecycle?.intent ||
    !lifecycle.lease ||
    !job ||
    job.expiresAt <= at ||
    lifecycle.inference.phase !== "sandbox_ready" ||
    lifecycle.inference.ownerEpoch !== args.fence.ownerEpoch ||
    lifecycle.intent.generation !== args.fence.generation ||
    lifecycle.lease.ownerEpoch !== args.fence.ownerEpoch ||
    lifecycle.lease.deadlineAt <= at
  ) {
    return undefined;
  }
  const stored = claimCompatibleStoredExecutionContextSchema.parse(job.context)
    .piLaunchConfig?.apiFirstTurn;
  if (stored?.schemaVersion !== 2 || !isDeepStrictEqual(stored, args.fence)) {
    return undefined;
  }
  await tx
    .update(agentRuns)
    .set({
      status: "running",
      startedAt: at,
      lastHeartbeatAt: at,
      cancellationRecoveryCompleted: false,
      runnerId: args.runnerId,
      runnerHeartbeatGeneration: args.heartbeatGeneration,
      runnerHostname: args.runnerHostname,
      runnerVersion: args.runnerVersion,
    })
    .where(eq(agentRuns.id, run.id));
  await tx
    .update(agentRunInference)
    .set({ phase: "sandbox_running" })
    .where(eq(agentRunInference.runId, run.id));
  await tx
    .update(agentRunSandboxIntent)
    .set({ state: "claimed" })
    .where(eq(agentRunSandboxIntent.runId, run.id));
  await tx
    .update(agentRunSandboxLease)
    .set({
      state: "claimed",
      runnerId: args.runnerId,
      claimedOwnerEpoch: args.fence.ownerEpoch,
      claimedGeneration: args.fence.generation,
      deadlineAt: new Date(at.getTime() + RUN_MS),
    })
    .where(eq(agentRunSandboxLease.runId, run.id));
  await tx.delete(runnerJobQueue).where(eq(runnerJobQueue.runId, run.id));
  return at;
}

/** Official Runner proof is separate from completion. Closure permits cleanup,
 * and terminal fencing never removes the immutable claim identity. */
type DeferredReleaseProof = {
  readonly runId: string;
  readonly runnerId: string;
  readonly ownerEpoch?: number;
  readonly generation?: number;
  readonly heartbeatGeneration?: number;
  readonly proof: "destroyed" | "process-absent" | "not-started";
};
async function releaseUnclaimedDemand(
  tx: Tx,
  run: Run,
  lease: typeof agentRunSandboxLease.$inferSelect | undefined,
  args: DeferredReleaseProof,
): Promise<boolean> {
  const lifecycle = await readPiInferenceLifecycle(
    tx,
    run.id,
    run.launchSnapshot,
  );
  if (!lifecycle?.intent) {
    return false;
  }
  // A timed-out claim may still be waiting to commit. Fence the original
  // Run while owning its locks before acknowledging the no-start proof.
  // The Runner retains its per-Run journal until this acknowledgement.
  const at = nowDate();
  if (["pending", "running"].includes(run.status)) {
    await failDeferredPiRun(tx, {
      runId: run.id,
      snapshot: run.launchSnapshot,
      at,
      status: "failed",
      error: "Runner abandoned claim before Sandbox activation",
    });
  }
  await tx.delete(runnerJobQueue).where(eq(runnerJobQueue.runId, run.id));
  if (lease) {
    await tx
      .update(agentRunSandboxLease)
      .set({
        state: "released",
        releaseEvidence: `runner-not-started-fenced:${args.runnerId}:${args.heartbeatGeneration}`,
      })
      .where(eq(agentRunSandboxLease.runId, run.id));
  }
  return true;
}

function matchesDeferredClaimProof(
  run: Run,
  lease: typeof agentRunSandboxLease.$inferSelect,
  args: DeferredReleaseProof,
): boolean {
  if (lease.runnerId !== args.runnerId) {
    return false;
  }
  if (args.proof === "not-started") {
    if (
      args.heartbeatGeneration === undefined ||
      run.runnerHeartbeatGeneration !== args.heartbeatGeneration ||
      run.runnerId !== args.runnerId ||
      lease.claimedOwnerEpoch === null ||
      lease.claimedGeneration === null
    ) {
      return false;
    }
  } else if (
    lease.claimedOwnerEpoch !== args.ownerEpoch ||
    lease.claimedGeneration !== args.generation ||
    (args.proof === "process-absent" &&
      run.runnerHeartbeatGeneration !== args.heartbeatGeneration)
  ) {
    return false;
  }
  return true;
}

export async function releaseDeferredPiSandbox(
  db: Db,
  args: DeferredReleaseProof,
): Promise<boolean> {
  return await withComputeOwnershipRetry(async () => {
    const [owner] = await db
      .select({
        userId: agentRuns.userId,
        orgId: agentRuns.orgId,
        agentId: agentSessions.agentId,
        input: agentRunInference.input,
      })
      .from(agentRuns)
      .innerJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
      .innerJoin(agentRunInference, eq(agentRunInference.runId, agentRuns.id))
      .where(eq(agentRuns.id, args.runId));
    if (!owner) {
      return false;
    }
    const captured = await readPublishedPiInferenceObject(
      db,
      { ...owner, hash: owner.input.configurationHash, kind: "configuration" },
      piDeferredConfigurationSchema,
    );
    return db.transaction(async (tx) => {
      const admission = await prepareComputeRunAdmission(tx, args.runId, {
        ...owner,
        capturedCleanupOwner: captured.resourceOwner,
      });
      if (!admission) {
        return false;
      }
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${owner.orgId}))`,
      );
      await tx
        .select({ id: chatThreads.id })
        .from(chatThreads)
        .where(
          inArray(
            chatThreads.id,
            tx
              .select({ id: agentRuns.chatThreadId })
              .from(agentRuns)
              .where(eq(agentRuns.id, args.runId)),
          ),
        )
        .orderBy(chatThreads.id)
        .for("update");
      // Cleanup does not require a still-live private execution lease. It only
      // removes capacity after real release, never publishes provider output.
      if (!(await validateComputeRunCleanupOwnership(tx, admission))) {
        return false;
      }
      const [lease] = await tx
        .select()
        .from(agentRunSandboxLease)
        .where(eq(agentRunSandboxLease.runId, args.runId))
        .for("update");
      const [run] = await tx
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, args.runId));
      if (!run || !isPiInferenceRun(run.launchSnapshot)) {
        return false;
      }
      if (args.proof === "not-started" && (!lease || lease.runnerId === null)) {
        return await releaseUnclaimedDemand(tx, run, lease, args);
      }
      if (!lease || !matchesDeferredClaimProof(run, lease, args)) {
        return false;
      }
      if (lease.state === "released") {
        return true;
      }
      if (["pending", "running"].includes(run.status)) {
        const at = nowDate();
        await failDeferredPiRun(tx, {
          runId: args.runId,
          snapshot: run.launchSnapshot,
          at,
          status: "failed",
          error: "Sandbox stopped before terminal completion was recorded",
        });
      }
      await tx
        .update(agentRunSandboxLease)
        .set({
          state: "released",
          releaseEvidence: `runner-${args.proof}:${args.runnerId}:${lease.claimedOwnerEpoch}:${lease.claimedGeneration}`,
        })
        .where(eq(agentRunSandboxLease.runId, args.runId));
      return true;
    });
  });
}

export async function failWaitingPiCandidate(
  db: Db,
  runId: string,
): Promise<void> {
  await withDeferredAdmission(
    db,
    runId,
    async (tx, run) => {
      const lifecycle = await readPiInferenceLifecycle(
        tx,
        runId,
        run.launchSnapshot,
      );
      if (lifecycle?.inference.phase !== "sandbox_waiting") {
        return;
      }
      const at = nowDate();
      await failDeferredPiRun(tx, {
        runId: runId,
        snapshot: run.launchSnapshot,
        at,
        status: "failed",
        error: "Invalid durable Pi Sandbox demand",
      });
    },
    undefined,
    true,
  );
}

/** Periodic recovery is the outbox reader. Notifications are optional hints. */
export const recoverDeferredPiRuns$ = command(
  async (
    { set },
    runIds: readonly string[] | null,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const terminals = await db
      .select({ runId: agentRunSandboxIntent.runId })
      .from(agentRunSandboxIntent)
      .where(
        and(
          isNotNull(agentRunSandboxIntent.terminalEffectsPendingAt),
          lte(agentRunSandboxIntent.terminalEffectsPendingAt, nowDate()),
          runIds === null
            ? undefined
            : inArray(agentRunSandboxIntent.runId, runIds),
        ),
      )
      .orderBy(
        agentRunSandboxIntent.terminalEffectsPendingAt,
        agentRunSandboxIntent.runId,
      )
      .limit(100);
    signal.throwIfAborted();
    for (const { runId } of terminals) {
      signal.throwIfAborted();
      await settle(set(settleDeferredPiTerminal$, runId, signal), signal);
    }
    const candidates = await db
      .select({ runId: agentRunSandboxLease.runId })
      .from(agentRunSandboxLease)
      .where(
        and(
          isNull(agentRunSandboxLease.runnerId),
          or(
            and(
              eq(agentRunSandboxLease.state, "preparing"),
              lt(agentRunSandboxLease.deadlineAt, nowDate()),
            ),
            eq(agentRunSandboxLease.state, "releasing"),
          ),
          runIds === null
            ? undefined
            : inArray(agentRunSandboxLease.runId, runIds),
        ),
      )
      .orderBy(agentRunSandboxLease.deadlineAt, agentRunSandboxLease.runId)
      .limit(100);
    signal.throwIfAborted();
    for (const { runId } of candidates) {
      signal.throwIfAborted();
      const result = await settle(
        recoverDeferredPiPreparation(db, runId),
        signal,
      );
      if (result.ok) {
        await set(settleDeferredPiTerminal$, runId, signal);
      }
      if (!result.ok) {
        logger("PiDeferredSandbox").warn(
          "Deferred recovery retained an invalid candidate for diagnosis",
          { runId },
        );
      }
    }
  },
);

/** Stable authenticated transport has no staging TTL or signed-URL expiry.
 * Each response stays below the deployed function response limit. */
export async function readDeferredPiHandoffChunk(
  db: Db,
  auth: {
    readonly runId: string;
    readonly userId: string;
    readonly orgId: string;
    readonly piSandbox?: {
      readonly ownerEpoch: number;
      readonly generation: number;
    };
  },
  offset: number,
) {
  if (
    !auth.piSandbox ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 32 * 1024 * 1024 ||
    offset % (1024 * 1024) !== 0
  ) {
    return undefined;
  }
  const fence = auth.piSandbox;
  return await withDeferredAdmission(db, auth.runId, async (tx, run) => {
    const lifecycle = await readPiInferenceLifecycle(
      tx,
      run.id,
      run.launchSnapshot,
    );
    if (
      run.userId !== auth.userId ||
      run.orgId !== auth.orgId ||
      run.status !== "running" ||
      lifecycle?.inference.phase !== "sandbox_running" ||
      lifecycle.inference.ownerEpoch !== fence.ownerEpoch ||
      lifecycle.intent?.generation !== fence.generation ||
      lifecycle.lease?.state !== "claimed"
    ) {
      return undefined;
    }
    const owner = { runId: run.id, userId: run.userId, orgId: run.orgId };
    const context = await readPiInferenceObject(
      tx,
      {
        ...owner,
        kind: "context",
        hash: lifecycle.inference.input.contextHash,
      },
      piDeferredContextSchema,
    );
    const continuation = lifecycle.intent.continuation;
    const h1 =
      continuation.mode === "untouched-h0"
        ? undefined
        : await readPiInferenceObject(
            tx,
            { ...owner, kind: "h1", hash: continuation.h1Hash },
            piDeferredH1Schema,
          );
    const bytes = Buffer.from(
      JSON.stringify({
        sessionHistory: h1?.sessionHistory ?? context.h0SessionHistory,
        resourceSnapshot: context.resourceSnapshot,
      }),
    );
    if (bytes.length > 32 * 1024 * 1024 || offset >= bytes.length) {
      return undefined;
    }
    const end = Math.min(offset + 1024 * 1024, bytes.length);
    return {
      chunk: bytes.subarray(offset, end).toString("base64"),
      nextOffset: end === bytes.length ? null : end,
    };
  });
}

/** Normal failures settle delivery/callback work separately from erasure closure.
 * This uses fresh cleanup admission and never clears diagnostic, provider, credit
 * or Sandbox release obligations. Core side effects do not recursively drain the
 * organization queue already owned by a consumer caller. */
export const settleDeferredPiTerminal$ = command(
  async ({ set }, runId: string, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    const [candidate] = await db
      .select({ pending: agentRunSandboxIntent.terminalEffectsPendingAt })
      .from(agentRunSandboxIntent)
      .where(eq(agentRunSandboxIntent.runId, runId));
    signal.throwIfAborted();
    if (!candidate?.pending) {
      return;
    }
    const terminal = await withDeferredAdmission(
      db,
      runId,
      async (tx, run, closed) => {
        if (closed || run.error === COMPUTE_CLOSURE_ERROR) {
          // Suppression is not usage settlement or proof that a Sandbox stopped.
          await tx
            .update(agentRuns)
            .set({ error: COMPUTE_CLOSURE_ERROR })
            .where(eq(agentRuns.id, runId));
          await tx
            .update(agentRunSandboxIntent)
            .set({ terminalEffectsPendingAt: null })
            .where(eq(agentRunSandboxIntent.runId, runId));
          return undefined;
        }
        if (
          run.status !== "failed" &&
          run.status !== "timeout" &&
          run.status !== "cancelled"
        ) {
          return undefined;
        }
        const delivery = run.chatThreadId
          ? await finalizeActiveInputDelivery(tx, {
              runId,
              chatThreadId: run.chatThreadId,
              deliveredDeliveryIds: new Set<string>(),
            })
          : undefined;
        return {
          kind: "terminal" as const,
          runId,
          orgId: run.orgId,
          status: "failed" as const,
          error: run.error ?? undefined,
          apiStartTime: run.apiStartedAt?.getTime(),
          ...(run.chatThreadId
            ? {
                deliveryNotification: {
                  userId: run.userId,
                  chatThreadId: run.chatThreadId,
                  chatEventsAppended: delivery?.chatEventsAppended ?? false,
                },
              }
            : {}),
        };
      },
      undefined,
      true,
    );
    signal.throwIfAborted();
    if (terminal) {
      await set(dispatchCompleteSideEffectsCore$, terminal, signal);
      signal.throwIfAborted();
      await withDeferredAdmission(
        db,
        runId,
        async (tx) => {
          await tx
            .update(agentRunSandboxIntent)
            .set({
              terminalEffectsPendingAt: (await hasUndeliveredRunCallbacks(
                tx,
                runId,
              ))
                ? new Date(nowDate().getTime() + 60_000)
                : null,
            })
            .where(eq(agentRunSandboxIntent.runId, runId));
        },
        undefined,
        true,
      );
    }
  },
);
