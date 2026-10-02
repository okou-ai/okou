import { isBuiltInModelProviderType } from "@okouai/api-contracts/contracts/model-providers";
import type { runnersModelProviderFailuresContract } from "@okouai/api-contracts/contracts/runners";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { builtInModelCandidateCooldown } from "@okouai/db/schema/built-in-model-cooldown";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import { writeDb$ } from "../external/db";

const DEFAULT_COOLDOWN_SECONDS = 5 * 60;
const INTERVENTION_COOLDOWN_SECONDS = 30 * 60;
const CONNECTION_OBSERVATION_MINIMUM_MS = 60 * 1000;
const CONNECTION_OBSERVATION_MAX_GAP_MS = 60 * 1000;
// A route resolver can capture its comparison time before this row is inserted.
// Keep provisional evidence expired for every in-flight resolver.
const INACTIVE_COOLDOWN_DEADLINE_MS = 0;

type BuiltInModelProviderFailureBody = z.infer<
  (typeof runnersModelProviderFailuresContract.report)["body"]
>;
type BuiltInModelProviderFailureKind =
  BuiltInModelProviderFailureBody["failureKind"];
type BuiltInModelProviderConnectionSource = Extract<
  BuiltInModelProviderFailureBody,
  { readonly failureKind: "connection" }
>["connectionSource"];

interface BuiltInModelRouteIdentity {
  readonly selectedModel: string;
  readonly modelRuntimeProvider: string;
  readonly modelRuntimeModel: string;
}

interface LockedBuiltInModelRoute extends BuiltInModelRouteIdentity {
  readonly unavailableUntil: Date;
  readonly connectionObservationStartedAt: Date | null;
  readonly connectionObservationUntil: Date | null;
}

interface CooldownMutation extends BuiltInModelRouteIdentity {
  readonly failureKind: BuiltInModelProviderFailureKind;
  readonly source: BuiltInModelProviderConnectionSource | "unspecified";
  readonly reason: BuiltInModelProviderFailureKind | "sustained_transport";
  readonly retryAfterSeconds: number;
  readonly unavailableUntil: Date;
}

type BuiltInModelProviderFailureTransition =
  | { readonly outcome: "ignored" }
  | { readonly outcome: "observed" }
  | {
      readonly outcome: "recorded";
      readonly cooldown: CooldownMutation | null;
    };

interface CooldownUpdateValues {
  readonly unavailableUntil?: Date;
  readonly connectionObservationStartedAt: Date | null;
  readonly connectionObservationUntil: Date | null;
}

interface CooldownDecision {
  readonly transition: BuiltInModelProviderFailureTransition;
  readonly updateValues: CooldownUpdateValues | undefined;
}

interface BuiltInModelProviderFailureMetadata {
  readonly runId: string;
  readonly receivedAt: Date;
}

type BuiltInModelProviderConnectionFailureReport =
  BuiltInModelProviderFailureMetadata &
    Extract<
      BuiltInModelProviderFailureBody,
      { readonly failureKind: "connection" }
    >;

type BuiltInModelProviderFailureReport = BuiltInModelProviderFailureMetadata &
  BuiltInModelProviderFailureBody;

function routeCondition(route: BuiltInModelRouteIdentity) {
  return and(
    eq(builtInModelCandidateCooldown.selectedModel, route.selectedModel),
    eq(
      builtInModelCandidateCooldown.modelRuntimeProvider,
      route.modelRuntimeProvider,
    ),
    eq(
      builtInModelCandidateCooldown.modelRuntimeModel,
      route.modelRuntimeModel,
    ),
  );
}

function observationInterval(route: LockedBuiltInModelRoute): {
  readonly startedAt: Date;
  readonly until: Date;
} | null {
  const { connectionObservationStartedAt, connectionObservationUntil } = route;
  if (!connectionObservationStartedAt && !connectionObservationUntil) {
    return null;
  }
  if (!connectionObservationStartedAt || !connectionObservationUntil) {
    throw new Error("Built-in model connection observation is incomplete");
  }
  return {
    startedAt: connectionObservationStartedAt,
    until: connectionObservationUntil,
  };
}

function activateCooldown(
  route: LockedBuiltInModelRoute,
  args: {
    readonly receivedAt: Date;
    readonly failureKind: BuiltInModelProviderFailureKind;
    readonly connectionSource?: BuiltInModelProviderConnectionSource;
    readonly retryAfterSeconds: number;
    readonly reason: BuiltInModelProviderFailureKind | "sustained_transport";
  },
): CooldownDecision {
  const requestedUntil = new Date(
    args.receivedAt.getTime() + args.retryAfterSeconds * 1000,
  );
  const deadlineChanged = requestedUntil > route.unavailableUntil;
  const interval = observationInterval(route);
  return {
    updateValues:
      deadlineChanged || interval
        ? {
            unavailableUntil: deadlineChanged
              ? requestedUntil
              : route.unavailableUntil,
            connectionObservationStartedAt: null,
            connectionObservationUntil: null,
          }
        : undefined,
    transition: {
      outcome: "recorded",
      cooldown: deadlineChanged
        ? {
            selectedModel: route.selectedModel,
            modelRuntimeProvider: route.modelRuntimeProvider,
            modelRuntimeModel: route.modelRuntimeModel,
            failureKind: args.failureKind,
            source: args.connectionSource ?? "unspecified",
            reason: args.reason,
            retryAfterSeconds: args.retryAfterSeconds,
            unavailableUntil: requestedUntil,
          }
        : null,
    },
  };
}

function observeTransportFailure(
  route: LockedBuiltInModelRoute,
  report: BuiltInModelProviderConnectionFailureReport,
): CooldownDecision {
  const interval = observationInterval(route);
  const receivedAtMs = report.receivedAt.getTime();
  if (
    interval &&
    receivedAtMs + CONNECTION_OBSERVATION_MAX_GAP_MS <
      interval.startedAt.getTime()
  ) {
    return { transition: { outcome: "observed" }, updateValues: undefined };
  }

  const connected =
    interval !== null &&
    receivedAtMs <= interval.until.getTime() &&
    receivedAtMs + CONNECTION_OBSERVATION_MAX_GAP_MS >=
      interval.startedAt.getTime();
  const startedAt = connected
    ? new Date(Math.min(interval.startedAt.getTime(), receivedAtMs))
    : report.receivedAt;
  const previousLatestAtMs = connected
    ? interval.until.getTime() - CONNECTION_OBSERVATION_MAX_GAP_MS
    : receivedAtMs;
  const latestAt = new Date(Math.max(previousLatestAtMs, receivedAtMs));

  if (
    connected &&
    latestAt.getTime() - startedAt.getTime() >=
      CONNECTION_OBSERVATION_MINIMUM_MS
  ) {
    return activateCooldown(route, {
      receivedAt: latestAt,
      failureKind: report.failureKind,
      connectionSource: report.connectionSource,
      retryAfterSeconds: DEFAULT_COOLDOWN_SECONDS,
      reason: "sustained_transport",
    });
  }

  return {
    updateValues: {
      connectionObservationStartedAt: startedAt,
      connectionObservationUntil: new Date(
        latestAt.getTime() + CONNECTION_OBSERVATION_MAX_GAP_MS,
      ),
    },
    transition: { outcome: "observed" },
  };
}

function immediateCooldownSeconds(
  report: BuiltInModelProviderFailureReport,
): number {
  if (
    report.failureKind === "authentication" ||
    report.failureKind === "billing"
  ) {
    return INTERVENTION_COOLDOWN_SECONDS;
  }
  return report.retryAfterSeconds ?? DEFAULT_COOLDOWN_SECONDS;
}

function decideBuiltInModelProviderFailure(
  route: LockedBuiltInModelRoute,
  report: BuiltInModelProviderFailureReport,
): CooldownDecision {
  if (report.failureKind === "connection") {
    if (report.connectionSource === "upstream_transport") {
      return observeTransportFailure(route, report);
    }
    return activateCooldown(route, {
      receivedAt: report.receivedAt,
      failureKind: report.failureKind,
      connectionSource: report.connectionSource,
      retryAfterSeconds: immediateCooldownSeconds(report),
      reason: report.failureKind,
    });
  }
  return activateCooldown(route, {
    receivedAt: report.receivedAt,
    failureKind: report.failureKind,
    retryAfterSeconds: immediateCooldownSeconds(report),
    reason: report.failureKind,
  });
}

// The exact candidate's observation/deadline remains locked through its write.
// Complete this semantic transition before the entry observes cancellation.
export const reportBuiltInModelProviderFailure$ = command(
  async (
    { set },
    report: BuiltInModelProviderFailureReport,
  ): Promise<BuiltInModelProviderFailureTransition> => {
    return await set(writeDb$).transaction(async (tx) => {
      const [run] = await tx
        .select({
          modelProvider: agentRuns.modelProvider,
          selectedModel: agentRuns.selectedModel,
          modelRuntimeProvider: agentRuns.modelRuntimeProvider,
          modelRuntimeModel: agentRuns.modelRuntimeModel,
          builtInModelKeyId: agentRuns.builtInModelKeyId,
        })
        .from(agentRuns)
        .where(eq(agentRuns.id, report.runId))
        .limit(1);
      if (
        !run ||
        !isBuiltInModelProviderType(run.modelProvider) ||
        !run.selectedModel ||
        !run.modelRuntimeProvider ||
        !run.modelRuntimeModel ||
        !run.builtInModelKeyId
      ) {
        return { outcome: "ignored" };
      }
      const route: BuiltInModelRouteIdentity = {
        selectedModel: run.selectedModel,
        modelRuntimeProvider: run.modelRuntimeProvider,
        modelRuntimeModel: run.modelRuntimeModel,
      };
      await tx
        .insert(builtInModelCandidateCooldown)
        .values({
          selectedModel: route.selectedModel,
          modelRuntimeProvider: route.modelRuntimeProvider,
          modelRuntimeModel: route.modelRuntimeModel,
          unavailableUntil: new Date(INACTIVE_COOLDOWN_DEADLINE_MS),
        })
        .onConflictDoNothing();

      const [lockedState] = await tx
        .select({
          unavailableUntil: builtInModelCandidateCooldown.unavailableUntil,
          connectionObservationStartedAt:
            builtInModelCandidateCooldown.connectionObservationStartedAt,
          connectionObservationUntil:
            builtInModelCandidateCooldown.connectionObservationUntil,
        })
        .from(builtInModelCandidateCooldown)
        .where(routeCondition(route))
        .for("update")
        .limit(1);
      if (!lockedState) {
        throw new Error("Expected built-in model candidate cooldown route");
      }
      const decision = decideBuiltInModelProviderFailure(
        { ...route, ...lockedState },
        report,
      );
      if (decision.updateValues) {
        await tx
          .update(builtInModelCandidateCooldown)
          .set(decision.updateValues)
          .where(routeCondition(route));
      }
      return decision.transition;
    });
  },
);
