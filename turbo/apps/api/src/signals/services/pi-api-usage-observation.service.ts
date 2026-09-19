import {
  runnerApiUsageResponseSchema,
  type RunnerApiUsageCoverageReason,
  type RunnerApiUsageRequest,
  type RunnerApiUsageResponse,
} from "@okouai/api-contracts/contracts/runner-api-usage";
import {
  agentRunApiUsageAttemptSchema,
  agentRunApiUsageProjectionSchema,
  type AgentRunApiUsageAttempt,
  type AgentRunApiUsageProjection,
} from "@okouai/db/jsonb-contracts/agent-run-api-usage";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunApiUsage } from "@okouai/db/schema/agent-run-api-usage";
import type { PiApiUsageObservation } from "@okouai/pi-agent-runtime/api";
import { and, eq, sql } from "drizzle-orm";

import { now, nowDate } from "../../lib/time";
import type { Db, ReadonlyDb } from "../external/db";

const MAX_ATTEMPTS = 8;
const tokenFields = ["input", "cacheRead", "cacheCreation", "output"] as const;

function emptyTokens(): AgentRunApiUsageAttempt["tokens"] {
  return { input: null, cacheRead: null, cacheCreation: null, output: null };
}

function registeredAttempt(
  attemptId: string,
  observedAtMs: number,
): AgentRunApiUsageAttempt {
  return agentRunApiUsageAttemptSchema.parse({
    id: attemptId,
    registeredAtMs: observedAtMs,
    observedAtMs: null,
    terminal: false,
    coverage: "unavailable",
    tokens: emptyTokens(),
    evidenceLost: false,
    ambiguous: [],
  });
}

function sameProjection(
  left: AgentRunApiUsageProjection,
  right: AgentRunApiUsageProjection,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function updateProjection(
  db: Db,
  runId: string,
  update: (
    projection: AgentRunApiUsageProjection,
    observedAtMs: number,
  ) => AgentRunApiUsageProjection,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        revision: agentRunApiUsage.revision,
        projection: agentRunApiUsage.projection,
      })
      .from(agentRunApiUsage)
      .where(eq(agentRunApiUsage.runId, runId))
      .for("update");
    if (!row) {
      return;
    }
    const current = agentRunApiUsageProjectionSchema.parse(row.projection);
    const next = agentRunApiUsageProjectionSchema.parse(update(current, now()));
    if (sameProjection(current, next)) {
      return;
    }
    const [updated] = await tx
      .update(agentRunApiUsage)
      .set({
        revision: sql`${agentRunApiUsage.revision} + 1`,
        projection: next,
        updatedAt: nowDate(),
      })
      .where(eq(agentRunApiUsage.runId, runId))
      .returning({ revision: agentRunApiUsage.revision });
    if (!updated || updated.revision <= row.revision) {
      throw new Error("API usage projection revision did not advance");
    }
  });
}

function ensureAttempt(
  projection: AgentRunApiUsageProjection,
  attemptId: string,
  observedAtMs: number,
): AgentRunApiUsageProjection {
  if (
    projection.attempts.some((attempt) => {
      return attempt.id === attemptId;
    })
  ) {
    return projection.phase === "attempted"
      ? projection
      : { ...projection, phase: "attempted" };
  }
  if (projection.attempts.length >= MAX_ATTEMPTS) {
    return projection.overflow ? projection : { ...projection, overflow: true };
  }
  return {
    ...projection,
    phase: "attempted",
    attempts: [
      ...projection.attempts,
      registeredAttempt(attemptId, observedAtMs),
    ],
  };
}

export async function registerPiApiUsageAttempt(
  db: Db,
  input: { readonly runId: string; readonly attemptId: string },
): Promise<void> {
  await updateProjection(db, input.runId, (projection, observedAtMs) => {
    return ensureAttempt(projection, input.attemptId, observedAtMs);
  });
}

function mergeAttempt(
  attempt: AgentRunApiUsageAttempt,
  observation: PiApiUsageObservation | undefined,
  observedAtMs: number,
): AgentRunApiUsageAttempt {
  const ambiguous = new Set(attempt.ambiguous);
  const tokens = { ...attempt.tokens };
  for (const field of tokenFields) {
    if (ambiguous.has(field)) {
      continue;
    }
    const incoming = observation?.tokens[field] ?? null;
    const current = tokens[field];
    if (current === null) {
      tokens[field] = incoming;
    } else if (incoming !== null && current !== incoming) {
      tokens[field] = null;
      ambiguous.add(field);
    }
  }
  const coverageRank = { unavailable: 0, partial: 1, complete: 2 } as const;
  const incomingCoverage = observation?.coverage ?? "unavailable";
  const coverage =
    coverageRank[incomingCoverage] > coverageRank[attempt.coverage]
      ? incomingCoverage
      : attempt.coverage;
  return agentRunApiUsageAttemptSchema.parse({
    ...attempt,
    observedAtMs: attempt.observedAtMs ?? observedAtMs,
    terminal: true,
    coverage,
    tokens,
    evidenceLost:
      attempt.evidenceLost ||
      (!attempt.terminal &&
        (observation === undefined || observation.coverage === "unavailable")),
    ambiguous: tokenFields.filter((field) => {
      return ambiguous.has(field);
    }),
  });
}

export async function recordPiApiUsageObservation(
  db: Db,
  input: {
    readonly runId: string;
    readonly attemptId: string;
    readonly observation: PiApiUsageObservation | undefined;
  },
): Promise<void> {
  await updateProjection(db, input.runId, (projection, observedAtMs) => {
    const registered = ensureAttempt(projection, input.attemptId, observedAtMs);
    const index = registered.attempts.findIndex((attempt) => {
      return attempt.id === input.attemptId;
    });
    if (index === -1) {
      return registered;
    }
    const attempts = [...registered.attempts];
    attempts[index] = mergeAttempt(
      attempts[index] as AgentRunApiUsageAttempt,
      input.observation,
      observedAtMs,
    );
    return { ...registered, attempts };
  });
}

export async function closePiApiUsageAsNoInference(
  db: Db,
  runId: string,
): Promise<void> {
  await updateProjection(db, runId, (projection) => {
    return projection.phase === "pending" && projection.attempts.length === 0
      ? { ...projection, phase: "no-inference" }
      : projection;
  });
}

const reasonOrder: readonly RunnerApiUsageCoverageReason[] = [
  "pending_inference",
  "in_flight",
  "missing_usage",
  "missing_categories",
  "ambiguous_attempt",
  "overflow",
];

function availableResponse(input: {
  readonly runId: string;
  readonly revision: number;
  readonly updatedAt: Date;
  readonly projection: AgentRunApiUsageProjection;
}): RunnerApiUsageResponse {
  const reasons = new Set<RunnerApiUsageCoverageReason>();
  const totals = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 };
  let overflow = input.projection.overflow;
  for (const attempt of input.projection.attempts) {
    if (!attempt.terminal) {
      reasons.add("in_flight");
    }
    if (attempt.ambiguous.length > 0) {
      reasons.add("ambiguous_attempt");
    }
    if (
      attempt.terminal &&
      (attempt.evidenceLost || attempt.coverage === "unavailable")
    ) {
      reasons.add("missing_usage");
    }
    if (
      attempt.terminal &&
      attempt.coverage !== "unavailable" &&
      (attempt.coverage === "partial" ||
        tokenFields.some((field) => {
          return (
            attempt.tokens[field] === null && !attempt.ambiguous.includes(field)
          );
        }))
    ) {
      reasons.add("missing_categories");
    }
    for (const field of tokenFields) {
      const value = attempt.tokens[field];
      if (value === null || attempt.ambiguous.includes(field)) {
        continue;
      }
      const sum = totals[field] + value;
      if (!Number.isSafeInteger(sum)) {
        overflow = true;
      } else {
        totals[field] = sum;
      }
    }
  }
  if (input.projection.phase === "pending") {
    reasons.add("pending_inference");
  }
  if (overflow) {
    reasons.add("overflow");
  }
  const total =
    totals.input + totals.cacheRead + totals.cacheCreation + totals.output;
  if (!Number.isSafeInteger(total)) {
    reasons.add("overflow");
    totals.input = 0;
    totals.cacheRead = 0;
    totals.cacheCreation = 0;
    totals.output = 0;
  }
  const orderedReasons = reasonOrder.filter((reason) => {
    return reasons.has(reason);
  });
  // Persisted corruption must fail the request instead of reaching a Runner.
  return runnerApiUsageResponseSchema.parse({
    state: "available",
    runId: input.runId,
    revision: input.revision,
    sampledAtMs: now(),
    updatedAtMs: input.updatedAt.getTime(),
    inferenceState: input.projection.phase.replace("-", "_") as
      | "no_inference"
      | "pending"
      | "attempted",
    observedAttempts: input.projection.attempts.filter((attempt) => {
      return attempt.observedAtMs !== null;
    }).length,
    outstandingAttempts: input.projection.attempts.filter((attempt) => {
      return !attempt.terminal;
    }).length,
    complete: orderedReasons.length === 0,
    reasons: orderedReasons,
    totals: {
      ...totals,
      total:
        totals.input + totals.cacheRead + totals.cacheCreation + totals.output,
    },
  });
}

export async function readRunnerApiUsage(
  db: ReadonlyDb,
  input: RunnerApiUsageRequest & { readonly runId: string },
  signal: AbortSignal,
): Promise<RunnerApiUsageResponse> {
  // A preceding API can admit a Run without the additive source row while it
  // remains a rollout or rollback target. Keep that old-writer miss
  // indistinguishable from every unauthorized claim until the API rollback
  // window and two-hour Runner drain close; #35385 owns strictification.
  const [row] = await db
    .select({
      revision: agentRunApiUsage.revision,
      projection: agentRunApiUsage.projection,
      updatedAt: agentRunApiUsage.updatedAt,
    })
    .from(agentRuns)
    .innerJoin(agentRunApiUsage, eq(agentRunApiUsage.runId, agentRuns.id))
    .where(
      and(
        eq(agentRuns.id, input.runId),
        eq(agentRuns.status, "running"),
        eq(agentRuns.runnerId, input.runnerIdentity.runnerId),
        eq(
          agentRuns.runnerHeartbeatGeneration,
          input.runnerIdentity.heartbeatGeneration,
        ),
      ),
    );
  signal.throwIfAborted();
  if (!row) {
    return { state: "unavailable", runId: input.runId };
  }
  return availableResponse({
    runId: input.runId,
    revision: row.revision,
    updatedAt: row.updatedAt,
    projection: agentRunApiUsageProjectionSchema.parse(row.projection),
  });
}
