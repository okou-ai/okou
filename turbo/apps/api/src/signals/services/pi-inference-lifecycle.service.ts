import {
  piInferenceInputSchema,
  piInferencePublicationSchema,
  piInferencePhaseSchema,
  piSandboxContinuationSchema,
} from "@okouai/api-contracts/contracts/pi-inference-lifecycle";
import type { AgentRunLaunchSnapshot } from "@okouai/db/jsonb-contracts/agent-run-session-conversation";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  agentRunInference,
  agentRunSandboxIntent,
  agentRunSandboxLease,
} from "@okouai/db/schema/agent-run-inference";
import { agents } from "@okouai/db/schema/agent";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { conversations } from "@okouai/db/schema/conversation";
import { alias } from "drizzle-orm/pg-core";
import { and, asc, eq, gt, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import type { Tx } from "../../lib/db-types";
import type { Db } from "../external/db";
import { activePendingRunPredicate } from "./agent-run-activity.service";
import { nowDate } from "../../lib/time";

/** No producer consumes this switch until both #34243 and #34244 are ready. */
export function isPiInferenceRun(
  snapshot: AgentRunLaunchSnapshot | null,
): boolean {
  return snapshot?.schemaVersion === 4;
}

/** Explicit mode, never absence of a Runner job. NULL remains legitimate history. */
export function legacySandboxRunPredicate(): SQL {
  return sql`${agentRuns.launchSnapshot} IS NULL OR ${agentRuns.launchSnapshot}->'schemaVersion' <> '4'::jsonb`;
}

/** UNION keeps both indexed admission paths and counts each run only once. */
export function sandboxCapacityPredicate(
  db: Pick<Db, "select">,
  orgId: string,
  staleThreshold: Date,
): SQL {
  const legacy = db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        sql`(${legacySandboxRunPredicate()})`,
        or(
          eq(agentRuns.status, "running"),
          and(
            eq(agentRuns.status, "pending"),
            activePendingRunPredicate(staleThreshold),
          ),
        ),
      ),
    );
  const leased = db
    .select({ id: agentRunSandboxLease.runId })
    .from(agentRunSandboxLease)
    .innerJoin(agentRuns, eq(agentRuns.id, agentRunSandboxLease.runId))
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        inArray(agentRunSandboxLease.state, [
          "reserved",
          "preparing",
          "ready",
          "claimed",
          "releasing",
        ]),
      ),
    );
  return inArray(agentRuns.id, legacy.union(leased));
}

async function selectPiInferenceLifecycle(
  db: Pick<Db, "select">,
  runId: string,
) {
  const sourceRun = alias(agentRuns, "pi_inference_source_run");
  const [row] = await db
    .select({
      inference: agentRunInference,
      intent: agentRunSandboxIntent,
      lease: agentRunSandboxLease,
      source: conversations,
      sourceOrgId: sourceRun.orgId,
      sourceUserId: sourceRun.userId,
      sourceSessionId: sourceRun.sessionId,
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
      sessionId: agentRuns.sessionId,
      continuedFromSessionId: agentRuns.continuedFromSessionId,
      apiStartedAt: agentRuns.apiStartedAt,
      selectedModel: agentRuns.selectedModel,
      runtimeProvider: agentRuns.modelRuntimeProvider,
      runtimeModel: agentRuns.modelRuntimeModel,
      status: agentRuns.status,
      modelProvider: agentRuns.modelProvider,
      modelProviderId: agentRuns.modelProviderId,
      builtInModelKeyId: agentRuns.builtInModelKeyId,
    })
    .from(agentRuns)
    .leftJoin(agentRunInference, eq(agentRunInference.runId, agentRuns.id))
    .leftJoin(
      agentRunSandboxIntent,
      eq(agentRunSandboxIntent.runId, agentRuns.id),
    )
    .leftJoin(
      agentRunSandboxLease,
      eq(agentRunSandboxLease.runId, agentRuns.id),
    )
    .leftJoin(
      conversations,
      eq(conversations.id, agentRunInference.sourceConversationId),
    )
    .leftJoin(sourceRun, eq(sourceRun.id, conversations.runId))
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return row;
}

type CandidateLifecycleRow = Awaited<
  ReturnType<typeof selectPiInferenceLifecycle>
>;
type LifecycleRow = NonNullable<CandidateLifecycleRow> & {
  inference: NonNullable<NonNullable<CandidateLifecycleRow>["inference"]>;
};

function assertRequiredInferenceState(
  row: CandidateLifecycleRow,
): asserts row is LifecycleRow {
  if (
    !row?.inference ||
    !row.apiStartedAt ||
    !row.selectedModel ||
    !row.runtimeProvider ||
    !row.runtimeModel ||
    !row.modelProvider ||
    (!row.modelProviderId && !row.builtInModelKeyId)
  ) {
    throw new Error("Pi inference lifecycle is missing required durable state");
  }
}

function assertInferenceInput(row: LifecycleRow) {
  const input = piInferenceInputSchema.parse(row.inference.input);
  if (
    (input.h0.kind === "history" ? input.h0.conversationId : null) !==
    row.inference.sourceConversationId
  ) {
    throw new Error("Pi H0 is missing its retained conversation reference");
  }
  if (
    input.h0.kind === "history" &&
    (row.source?.cliAgentType !== "pi" ||
      row.source.runId === row.inference.runId ||
      row.source.cliAgentSessionHistoryHash !== input.h0.historyHash ||
      row.sourceOrgId !== row.orgId ||
      row.sourceUserId !== row.userId ||
      (row.sourceSessionId !== row.sessionId &&
        row.sourceSessionId !== row.continuedFromSessionId))
  ) {
    throw new Error(
      "Pi H0 disagrees with its captured history or source identity",
    );
  }
}

function assertInferencePhase(row: LifecycleRow, terminalizing: boolean) {
  const phase = piInferencePhaseSchema.parse(row.inference.phase);
  const terminalStatus = [
    "completed",
    "failed",
    "cancelled",
    "timeout",
  ].includes(row.status);
  if (
    terminalizing
      ? !terminalStatus
      : phase === "terminal"
        ? !terminalStatus
        : row.status !== (phase === "sandbox_running" ? "running" : "pending")
  ) {
    throw new Error("Pi inference phase disagrees with its public run status");
  }
  if (
    (phase === "admitted" &&
      (row.inference.activationReady ||
        row.inference.providerAttemptState !== "not-started")) ||
    (phase === "ready" &&
      (!row.inference.activationReady ||
        row.inference.providerAttemptState !== "not-started"))
  ) {
    throw new Error(
      "Pi activation readiness disagrees with its provider attempt",
    );
  }
}

function assertInferenceContinuation(row: LifecycleRow) {
  const phase = row.inference.phase;
  if (
    ["admitted", "ready", "provider", "publishing"].includes(phase) &&
    (row.intent || row.lease)
  ) {
    throw new Error(
      "Pi API ownership cannot include a Sandbox intent or lease",
    );
  }
  if (row.inference.providerAttemptState === "settled") {
    piInferencePublicationSchema.parse(row.inference.publication);
  }
  if (row.intent) {
    piSandboxContinuationSchema.parse(row.intent.continuation);
    if (
      row.intent.continuation.mode !== "untouched-h0" &&
      (row.intent.continuation.h1Hash !== row.inference.publication?.h1Hash ||
        row.intent.continuation.manifestGeneration !==
          row.inference.publication.manifestGeneration ||
        row.intent.continuation.lastEventSequence !==
          row.inference.publication.lastEventSequence)
    ) {
      throw new Error(
        "Pi continuation disagrees with its durable publication receipt",
      );
    }
    if (
      row.intent.continuation.mode !== "untouched-h0" &&
      row.inference.providerAttemptState !== "settled"
    ) {
      throw new Error("Pi continuation requires a settled provider attempt");
    }
    if (
      row.intent.continuation.mode === "untouched-h0" &&
      row.inference.providerAttemptState !== "not-started"
    ) {
      throw new Error("Pi inference result cannot be replaced with H0");
    }
  }
}

function assertSandboxOwnership(row: LifecycleRow) {
  const phase = row.inference.phase;
  const expectedIntentState = {
    sandbox_waiting: "waiting",
    sandbox_preparing: "preparing",
    sandbox_ready: "ready",
    sandbox_running: "claimed",
  } as const;
  if (phase in expectedIntentState) {
    const expected =
      expectedIntentState[phase as keyof typeof expectedIntentState];
    if (
      !row.intent ||
      row.intent.state !== expected ||
      row.intent.ownerEpoch !== row.inference.ownerEpoch ||
      (phase !== "sandbox_waiting" && !row.lease)
    ) {
      throw new Error(
        "Pi Sandbox phase has inconsistent intent or lease ownership",
      );
    }
    if (
      row.lease &&
      (row.lease.ownerEpoch !== row.intent.ownerEpoch ||
        (phase === "sandbox_preparing" &&
          !["reserved", "preparing"].includes(row.lease.state)) ||
        (phase === "sandbox_ready" && row.lease.state !== "ready") ||
        (phase === "sandbox_running" && row.lease.state !== "claimed"))
    ) {
      throw new Error(
        "Pi Sandbox lease disagrees with its materialization owner",
      );
    }
  }
  if (
    phase === "sandbox_waiting" &&
    row.lease &&
    row.lease.state !== "released"
  ) {
    throw new Error("Pi waiting intent already owns Sandbox capacity");
  }
}

/** Caller holds the run row for mutations. Reading confers no execution authority. */
export async function readPiInferenceLifecycle(
  db: Pick<Db, "select">,
  runId: string,
  snapshot: AgentRunLaunchSnapshot | null,
  terminalizing = false,
) {
  if (!isPiInferenceRun(snapshot)) {
    return null;
  }
  const row = await selectPiInferenceLifecycle(db, runId);
  assertRequiredInferenceState(row);
  assertInferenceInput(row);
  assertInferencePhase(row, terminalizing);
  assertInferenceContinuation(row);
  assertSandboxOwnership(row);
  return row;
}

/** Separate API, queue, materializer, claim and actual Runner deadlines. */
export function piInferenceDeadline(
  lifecycle: NonNullable<Awaited<ReturnType<typeof readPiInferenceLifecycle>>>,
): Date {
  const { inference, intent, lease } = lifecycle;
  switch (inference.phase) {
    case "sandbox_waiting": {
      if (!intent) {
        throw new Error("Pi waiting phase is missing its queue deadline");
      }
      return intent.expiresAt;
    }
    case "sandbox_preparing": {
      if (!intent?.attemptDeadlineAt || !lease) {
        throw new Error("Pi materialization is missing its attempt deadline");
      }
      return new Date(
        Math.min(
          intent.expiresAt.getTime(),
          intent.attemptDeadlineAt.getTime(),
          lease.deadlineAt.getTime(),
        ),
      );
    }
    case "sandbox_ready":
    case "sandbox_running": {
      if (!lease) {
        throw new Error("Pi execution is missing its lease deadline");
      }
      return lease.deadlineAt;
    }
    default: {
      return inference.deadlineAt;
    }
  }
}

/** Fences local publication; an uncertain external attempt remains uncertain. */
export async function fencePiInferenceTerminal(
  tx: Tx,
  runId: string,
  snapshot: AgentRunLaunchSnapshot | null,
  at: Date,
) {
  const lifecycle = await readPiInferenceLifecycle(tx, runId, snapshot, true);
  if (!lifecycle) {
    return;
  }
  await tx
    .update(agentRunInference)
    .set({
      phase: "terminal",
      ownerEpoch: sql`${agentRunInference.ownerEpoch} + 1`,
      deadlineAt: at,
    })
    .where(eq(agentRunInference.runId, runId));
  const intentState =
    lifecycle.status === "cancelled"
      ? "cancelled"
      : lifecycle.status === "timeout"
        ? "expired"
        : "settled";
  await tx
    .update(agentRunSandboxIntent)
    .set({
      state: intentState,
      ownerEpoch: sql`${agentRunSandboxIntent.ownerEpoch} + 1`,
    })
    .where(
      and(
        eq(agentRunSandboxIntent.runId, runId),
        inArray(agentRunSandboxIntent.state, [
          "waiting",
          "preparing",
          "ready",
          "claimed",
        ]),
      ),
    );
  await tx
    .update(agentRunSandboxLease)
    .set({
      state: "releasing",
      ownerEpoch: sql`${agentRunSandboxLease.ownerEpoch} + 1`,
    })
    .where(
      and(
        eq(agentRunSandboxLease.runId, runId),
        ne(agentRunSandboxLease.state, "released"),
      ),
    );
}

/** Called under the target run locks, before any parent or H0 deletion. */
export async function assertPiInferenceErasureReady(
  tx: Tx,
  runIds: readonly string[],
) {
  if (runIds.length === 0) {
    return;
  }
  const [blocked] = await tx
    .select({ runId: agentRunInference.runId })
    .from(agentRunInference)
    .leftJoin(
      agentRunSandboxLease,
      eq(agentRunSandboxLease.runId, agentRunInference.runId),
    )
    .where(
      and(
        inArray(agentRunInference.runId, runIds),
        or(
          ne(agentRunSandboxLease.state, "released"),
          and(
            ne(agentRunInference.providerAttemptState, "not-started"),
            eq(agentRunInference.usageSettled, false),
          ),
        ),
      ),
    )
    .limit(1);
  if (blocked) {
    // Existing deletion owners treat this as a bounded, retryable conflict.
    throw new Error(
      "Pi inference erasure awaits usage or Sandbox release evidence",
      { cause: { code: "55P03" } },
    );
  }
}

/** CAS contract shared by future owners; expired/stale claims grant no authority. */
export function piInferenceOwnerPredicate(args: {
  readonly runId: string;
  readonly ownerEpoch: number;
  readonly at: Date;
}) {
  return and(
    eq(agentRunInference.runId, args.runId),
    eq(agentRunInference.ownerEpoch, args.ownerEpoch),
    gt(agentRunInference.deadlineAt, args.at),
    ne(agentRunInference.phase, "terminal"),
  );
}

/** Internal publication requires a fenced owner, even without a Runner job. */
export function assertPiInferencePublication(
  lifecycle: Awaited<ReturnType<typeof readPiInferenceLifecycle>>,
  ownerEpoch: number | undefined,
) {
  if (!lifecycle) {
    return;
  }
  if (
    ownerEpoch !== lifecycle.inference.ownerEpoch ||
    piInferenceDeadline(lifecycle) <= nowDate() ||
    !["publishing", "sandbox_running"].includes(lifecycle.inference.phase)
  ) {
    throw new Error(
      "Pi publication requires the current unexpired execution owner",
    );
  }
}

type InferenceErasureScope =
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "organization"; readonly orgId: string };

/** Match direct runs plus the actual Agent -> Session -> Run deletion cascade. */
export function piInferenceErasureScopePredicate(
  db: Pick<Db, "select">,
  scope: InferenceErasureScope,
): SQL {
  const predicate = or(
    scope.kind === "user"
      ? eq(agentRuns.userId, scope.userId)
      : eq(agentRuns.orgId, scope.orgId),
    inArray(
      agentRuns.sessionId,
      db
        .select({ id: agentSessions.id })
        .from(agentSessions)
        .innerJoin(agents, eq(agents.id, agentSessions.agentId))
        .where(
          scope.kind === "user"
            ? eq(agents.owner, scope.userId)
            : eq(agents.orgId, scope.orgId),
        ),
    ),
  );
  return sql`(${predicate})`;
}

/** Hard cancellation must precede this preflight; no erased external evidence first. */
export async function assertPiInferenceScopeErasureReady(
  db: Db,
  scope: InferenceErasureScope,
) {
  await db.transaction(async (tx) => {
    // Bound this preflight independently of any later external cleanup.
    await tx.execute(sql`SET LOCAL lock_timeout = '100ms'`);
    const rows = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          piInferenceErasureScopePredicate(tx, scope),
          sql`${agentRuns.launchSnapshot}->'schemaVersion' = '4'::jsonb`,
        ),
      )
      .orderBy(asc(agentRuns.id))
      .for("update");
    await assertPiInferenceErasureReady(
      tx,
      rows.map((r) => {
        return r.id;
      }),
    );
  });
}
