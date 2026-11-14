import { runnerRealtimeTokenContract } from "@okouai/api-contracts/contracts/realtime";
import {
  CONNECTOR_RUNTIME_SYNC_RUN_TERMINAL_ERROR_CODE,
  runnersBuiltinFirewallsResolveContract,
  runnersConnectorRuntimeSyncContract,
  runnersHeartbeatContract,
  runnersSteerContract,
  STEERED_INPUT_ALREADY_CONSUMED_ERROR_CODE,
  STEERED_INPUT_RUN_NOT_RUNNING_ERROR_CODE,
  type HeldSandboxState,
  type HeldHomeState,
} from "@okouai/api-contracts/contracts/runners";
import {
  runStatusSchema,
  type RunStatus,
} from "@okouai/api-contracts/contracts/runs";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { runnerState } from "@okouai/db/runtime/runner-state";
import type {
  RunnerHeldSandboxState as PersistedRunnerHeldSandboxState,
  RunnerHeldHomeState as PersistedRunnerHeldHomeState,
} from "@okouai/db/jsonb-contracts/runner-state";
import { command } from "ccstate";
import { and, eq, lt, or, sql } from "drizzle-orm";
import { badRequestMessage, notFound } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { runnerAuth$, type RunnerAuthContext } from "../auth/runner-auth";
import { authorization$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import {
  createRunnerGroupRealtimeToken,
  publishChatThreadMessageCreatedSafely,
} from "../external/realtime";
import type { RouteEntry } from "../route-entry";
import {
  declareSteeredInput$,
  loadNextSteerableInput$,
} from "../services/active-input-delivery.service";
import { notifyRunningChatRunOfPendingInput$ } from "../services/chat-thread-queue-drain.service";
import { connectorRunnerFirewallCatalog$ } from "../services/connector-runner-firewall-catalog.service";
import { resolveConnectorRuntimeTargets$ } from "../services/connector-runtime-sync.service";

const STALE_RUNNER_THRESHOLD_MS = 5 * 60 * 1000;

const unauthorizedNotAuthenticated = Object.freeze({
  status: 401 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Not authenticated",
      code: "UNAUTHORIZED",
    }),
  }),
});

const unauthorizedAuthenticationRequired = Object.freeze({
  status: 401 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Authentication required",
      code: "UNAUTHORIZED",
    }),
  }),
});

function forbidden(message: string) {
  return {
    status: 403 as const,
    body: {
      error: { message, code: "FORBIDDEN" },
    },
  };
}

function isOfficialRunnerGroup(group: string): boolean {
  return group.split("/")[0] === "vm0";
}

function canonicalizeHeldSandboxStates(
  states: readonly HeldSandboxState[],
): PersistedRunnerHeldSandboxState[] {
  return states.map((state) => {
    return {
      reuseKey: state.reuseKey,
      lastCompletedAt: new Date(state.lastCompletedAt).toISOString(),
      reusableSandbox: {
        profile: state.reusableSandbox.profile,
        sourceRunId: state.reusableSandbox.sourceRunId,
      },
    };
  });
}

function canonicalizeHeldHomeStates(
  states: readonly HeldHomeState[],
): PersistedRunnerHeldHomeState[] {
  return states.map((state) => {
    const [first, ...remaining] = state.homeCaches;
    if (!first) {
      throw new Error("Held home state requires a home cache");
    }
    return {
      reuseKey: state.reuseKey,
      lastCompletedAt: new Date(state.lastCompletedAt).toISOString(),
      homeCaches: [
        {
          profile: first.profile,
          homeAffinityVersion: first.homeAffinityVersion,
          sourceRunId: first.sourceRunId,
        },
        ...remaining.map((cache) => {
          return {
            profile: cache.profile,
            homeAffinityVersion: cache.homeAffinityVersion,
            sourceRunId: cache.sourceRunId,
          };
        }),
      ],
    };
  });
}

const heartbeatBody$ = bodyResultOf(runnersHeartbeatContract.heartbeat);

const heartbeatInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = await set(runnerAuth$, get(authorization$), signal);
  signal.throwIfAborted();
  if (!auth) {
    return unauthorizedNotAuthenticated;
  }

  const body = await get(heartbeatBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  if (!isOfficialRunnerGroup(body.data.group)) {
    return badRequestMessage("Invalid runner group");
  }

  const heldSandboxStates = canonicalizeHeldSandboxStates(
    body.data.heldSandboxStates,
  );
  const heldHomeStates =
    auth.type === "official-runner"
      ? canonicalizeHeldHomeStates(body.data.heldHomeStates)
      : [];
  const admittableProfiles = body.data.admittableProfiles;
  // Every accepted writer replaces locality. An omitted or PAT hostname cannot
  // retain an earlier official observation; stale messages retain the whole row.
  const runnerHostname =
    auth.type === "official-runner" ? (body.data.runnerHostname ?? null) : null;
  const currentDate = nowDate();
  const ingressServiceActive =
    auth.type === "official-runner" && body.data.ingressServiceActive === true;
  const snapshotOrder = {
    generation: body.data.snapshotGeneration,
    sequence: body.data.snapshotSequence,
  };
  const db = set(writeDb$);
  await db
    .insert(runnerState)
    .values({
      runnerId: body.data.runnerId,
      runnerHostname,
      ingressServiceActive,
      runnerGroup: body.data.group,
      heartbeatGeneration: snapshotOrder.generation,
      heartbeatSequence: snapshotOrder.sequence,
      totalVcpu: body.data.totalVcpu,
      totalMemoryMb: body.data.totalMemoryMb,
      maxConcurrent: body.data.maxConcurrent,
      allocatedVcpu: body.data.allocatedVcpu,
      allocatedMemoryMb: body.data.allocatedMemoryMb,
      runningCount: body.data.runningCount,
      admittableProfiles,
      heldSandboxStates,
      heldHomeStates,
      activeReuseProducers: body.data.activeReuseProducers,
      mode: body.data.mode,
      lastSeenAt: currentDate,
    })
    .onConflictDoUpdate({
      target: runnerState.runnerId,
      set: {
        runnerHostname,
        ingressServiceActive,
        runnerGroup: body.data.group,
        heartbeatGeneration: snapshotOrder.generation,
        heartbeatSequence: snapshotOrder.sequence,
        totalVcpu: body.data.totalVcpu,
        totalMemoryMb: body.data.totalMemoryMb,
        maxConcurrent: body.data.maxConcurrent,
        allocatedVcpu: body.data.allocatedVcpu,
        allocatedMemoryMb: body.data.allocatedMemoryMb,
        runningCount: body.data.runningCount,
        // A fresh heartbeat still advances the ordered scalar state below.
        // Reuse stored TOAST values for unchanged JSONB snapshots instead of
        // rewriting them on every heartbeat.
        admittableProfiles: sql`CASE WHEN ${runnerState.admittableProfiles} IS DISTINCT FROM excluded.admittable_profiles THEN excluded.admittable_profiles ELSE ${runnerState.admittableProfiles} END`,
        heldSandboxStates: sql`CASE WHEN ${runnerState.heldSandboxStates} IS DISTINCT FROM excluded.held_sandbox_states THEN excluded.held_sandbox_states ELSE ${runnerState.heldSandboxStates} END`,
        heldHomeStates: sql`CASE WHEN ${runnerState.heldHomeStates} IS DISTINCT FROM excluded.held_home_states THEN excluded.held_home_states ELSE ${runnerState.heldHomeStates} END`,
        activeReuseProducers: sql`CASE WHEN ${runnerState.activeReuseProducers} IS DISTINCT FROM excluded.active_reuse_producers THEN excluded.active_reuse_producers ELSE ${runnerState.activeReuseProducers} END`,
        mode: body.data.mode,
        lastSeenAt: currentDate,
      },
      setWhere: or(
        lt(runnerState.heartbeatGeneration, snapshotOrder.generation),
        and(
          eq(runnerState.heartbeatGeneration, snapshotOrder.generation),
          lt(runnerState.heartbeatSequence, snapshotOrder.sequence),
        ),
      ),
    });
  signal.throwIfAborted();

  await db
    .delete(runnerState)
    .where(
      lt(
        runnerState.lastSeenAt,
        new Date(currentDate.getTime() - STALE_RUNNER_THRESHOLD_MS),
      ),
    );
  signal.throwIfAborted();

  return { status: 200 as const, body: { ok: true as const } };
});
const connectorRuntimeSyncBody$ = bodyResultOf(
  runnersConnectorRuntimeSyncContract.sync,
);
const builtinFirewallsResolveBody$ = bodyResultOf(
  runnersBuiltinFirewallsResolveContract.resolve,
);

interface RunNetworkPolicyScope {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly status: RunStatus;
}

const getRunNetworkPolicyScope$ = command(
  async (
    { get },
    runId: string,
    signal: AbortSignal,
  ): Promise<RunNetworkPolicyScope | undefined> => {
    const db = get(db$);
    const [row] = await db
      .select({
        runId: agentRuns.id,
        userId: agentRuns.userId,
        orgId: agentRuns.orgId,
        agentId: agents.id,
        status: agentRuns.status,
      })
      .from(agentRuns)

      .innerJoin(agents, eq(agents.id, agentRuns.agentId))
      .where(eq(agentRuns.id, runId))
      .limit(1);
    signal.throwIfAborted();
    return row
      ? {
          ...row,
          status: runStatusSchema.parse(row.status),
        }
      : undefined;
  },
);

function runnerRunAuthorizationError(
  auth: RunnerAuthContext,
  run: Pick<RunNetworkPolicyScope, "userId">,
) {
  if (auth.type === "official-runner") {
    return null;
  }
  return run.userId === auth.userId
    ? null
    : forbidden("Run does not belong to user");
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "timeout" ||
    status === "cancelled"
  );
}

const runnerRealtimeTokenBody$ = bodyResultOf(
  runnerRealtimeTokenContract.create,
);

const connectorRuntimeSyncInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = await set(runnerAuth$, get(authorization$), signal);
    signal.throwIfAborted();
    if (!auth) {
      return unauthorizedAuthenticationRequired;
    }

    const body = await get(connectorRuntimeSyncBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const runId = get(
      pathParamsOf(runnersConnectorRuntimeSyncContract.sync),
    ).runId;
    set(writeDb$);
    const run = await set(getRunNetworkPolicyScope$, runId, signal);
    if (!run) {
      return notFound("Run not found");
    }

    const authError = runnerRunAuthorizationError(auth, run);
    if (run.status !== "running") {
      if (authError || !isTerminalRunStatus(run.status)) {
        return notFound("Run not found");
      }
      return {
        status: 409 as const,
        body: {
          error: {
            code: CONNECTOR_RUNTIME_SYNC_RUN_TERMINAL_ERROR_CODE,
            message: "Run is terminal",
          },
        },
      };
    }
    if (authError) {
      return authError;
    }

    const results = await set(resolveConnectorRuntimeTargets$, {
      scope: {
        orgId: run.orgId,
        userId: run.userId,
        agentId: run.agentId,
        runId: run.runId,
      },
      targets: body.data.targets,
    });
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { results },
    };
  },
);

const runnerRealtimeTokenInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = await set(runnerAuth$, get(authorization$), signal);
    signal.throwIfAborted();
    if (!auth) {
      return unauthorizedAuthenticationRequired;
    }

    const body = await get(runnerRealtimeTokenBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const { group } = body.data;
    if (auth.type === "official-runner") {
      if (!isOfficialRunnerGroup(group)) {
        return forbidden("Official runners can only subscribe to vm0/* groups");
      }
    } else if (!isOfficialRunnerGroup(group)) {
      return forbidden("Only vm0/* runner groups are supported");
    }

    const tokenRequest = await createRunnerGroupRealtimeToken(group);
    signal.throwIfAborted();

    return { status: 200 as const, body: tokenRequest };
  },
);

const builtinFirewallsResolveInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = await set(runnerAuth$, get(authorization$), signal);
    signal.throwIfAborted();
    if (!auth) {
      return unauthorizedAuthenticationRequired;
    }

    const body = await get(builtinFirewallsResolveBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const catalog = await get(connectorRunnerFirewallCatalog$);
    signal.throwIfAborted();
    const names =
      body.data.names === undefined ? undefined : [...new Set(body.data.names)];
    const missingNames = (names ?? []).filter((name) => {
      return !catalog.has(name);
    });
    if (missingNames.length > 0) {
      return badRequestMessage(
        `Unknown builtin firewall: ${missingNames.join(", ")}`,
      );
    }
    const firewalls = await catalog.load(names);
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        catalogDigest: catalog.catalogDigest,
        catalogVersion: catalog.catalogVersion,
        firewalls,
      },
    };
  },
);

const steeredInputBody$ = bodyResultOf(runnersSteerContract.steered);

const nextSteerableInputInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const { runId } = get(pathParamsOf(runnersSteerContract.next));
    if (auth.tokenType !== "sandbox" || auth.runId !== runId) {
      return forbidden("Steering is not available");
    }
    set(writeDb$);
    const result = await set(
      loadNextSteerableInput$,
      { runId, userId: auth.userId, orgId: auth.orgId },
      signal,
    );
    if (result.outcome === "forbidden") {
      return forbidden("Steering is not available");
    }
    return { status: 200 as const, body: { input: result.input } };
  },
);

const declareSteeredInputInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const { runId, eventId } = get(pathParamsOf(runnersSteerContract.steered));
    if (auth.tokenType !== "sandbox" || auth.runId !== runId) {
      return forbidden("Steering is not available");
    }
    const body = await get(steeredInputBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const result = await set(
      declareSteeredInput$,
      { runId, eventId, userId: auth.userId, orgId: auth.orgId },
      signal,
    );
    switch (result.outcome) {
      case "forbidden": {
        return forbidden("Steering is not available");
      }
      case "not_found": {
        return notFound("Steerable input not found");
      }
      case "conflict": {
        return {
          status: 409 as const,
          body: {
            error:
              result.reason === "run_not_running"
                ? {
                    code: STEERED_INPUT_RUN_NOT_RUNNING_ERROR_CODE,
                    message: "Run is not running",
                  }
                : {
                    code: STEERED_INPUT_ALREADY_CONSUMED_ERROR_CODE,
                    message: "Input was already consumed",
                  },
          },
        };
      }
      case "steered": {
        break;
      }
    }
    if (result.replacementsAppended) {
      await publishChatThreadMessageCreatedSafely({
        userId: auth.userId,
        orgId: auth.orgId,
        threadId: result.chatThreadId,
      });
      signal.throwIfAborted();
      await set(
        notifyRunningChatRunOfPendingInput$,
        result.chatThreadId,
        signal,
      );
      signal.throwIfAborted();
    }
    return { status: 200 as const, body: { outcome: "steered" as const } };
  },
);

export const runnersRoutes: readonly RouteEntry[] = [
  {
    route: runnersHeartbeatContract.heartbeat,
    handler: heartbeatInner$,
  },
  {
    route: runnersSteerContract.next,
    handler: authRoute(
      { accept: ["sandbox"], acceptAnySandboxCapability: true },
      nextSteerableInputInner$,
    ),
  },
  {
    route: runnersSteerContract.steered,
    handler: authRoute(
      { accept: ["sandbox"], acceptAnySandboxCapability: true },
      declareSteeredInputInner$,
    ),
  },
  {
    route: runnersConnectorRuntimeSyncContract.sync,
    handler: connectorRuntimeSyncInner$,
  },
  {
    route: runnersBuiltinFirewallsResolveContract.resolve,
    handler: builtinFirewallsResolveInner$,
  },
  {
    route: runnerRealtimeTokenContract.create,
    handler: runnerRealtimeTokenInner$,
  },
];
