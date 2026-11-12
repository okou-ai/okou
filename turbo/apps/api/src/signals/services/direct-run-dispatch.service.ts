import {
  DEFAULT_RUNNER_PROFILE,
  DEFAULT_RUNNER_PROFILE_VCPU,
  DEFAULT_RUNNER_PROFILE_MEMORY_MB,
  RUNNER_DISPATCH_MAX_BODY_BYTES,
  isCanonicalRunnerHostname,
} from "@okouai/api-contracts/contracts/runner-dispatch";
import { OFFICIAL_RUNNER_TOKEN_PREFIX } from "@okouai/api-contracts/contracts/runner-primitives";
import { runnerState } from "@okouai/db/runtime/runner-state";
import { command, computed, type Computed } from "ccstate";
import { and, arrayContains, eq, gt } from "drizzle-orm";
import { delay } from "signal-timers";
import { env } from "../../lib/env";
import { API_INVOCATION_MAX_DURATION_SECONDS } from "../../lib/invocation-budget";
import { now } from "../../lib/time";
import { db$ } from "../external/db";
import { apiStartTime$ } from "../context/hono";
import { postRunnerDispatch } from "../external/runner-ingress";
import { failUnacceptedRun$ } from "./agent-run-terminal-transition.service";
import {
  createDirectRunPreparation,
  prepareDirectRun$,
  type AdmittedRunLaunch,
} from "./direct-run-preparation.service";
import {
  selectDirectRunOwner$,
  readDirectRunState$,
  type DirectRunTarget,
} from "./direct-run-ownership.service";
import { preparedRunnerReusePreference } from "./runner-reuse-preference";
import { joinAll, settleIncludingAbort } from "../utils";

export function createDirectRunDispatch(
  input$: Computed<Promise<AdmittedRunLaunch>>,
) {
  const preparation$ = createDirectRunPreparation(input$);
  const fleet$ = computed(async (get) => {
    const input = await get(input$);
    if (input.profile !== DEFAULT_RUNNER_PROFILE) {
      throw new Error("Unsupported direct Run profile");
    }
    const rows = await get(db$)
      .select()
      .from(runnerState)
      .where(
        and(
          eq(runnerState.runnerGroup, input.runnerGroup),
          eq(runnerState.mode, "running"),
          eq(runnerState.ingressServiceActive, true),
          gt(runnerState.heartbeatGeneration, 0),
          gt(runnerState.lastSeenAt, new Date(now() - 180_000)),
          arrayContains(runnerState.admittableProfiles, [input.profile]),
        ),
      );
    const candidates = rows.flatMap((row) => {
      if (
        row.runnerHostname === null ||
        !isCanonicalRunnerHostname(row.runnerHostname) ||
        row.totalVcpu < DEFAULT_RUNNER_PROFILE_VCPU ||
        row.totalMemoryMb < DEFAULT_RUNNER_PROFILE_MEMORY_MB
      ) {
        return [];
      }
      return [
        {
          runnerId: row.runnerId,
          heartbeatGeneration: row.heartbeatGeneration,
          hostname: row.runnerHostname,
          score: Math.max(
            0,
            Math.min(
              (row.totalVcpu - row.allocatedVcpu) / DEFAULT_RUNNER_PROFILE_VCPU,
              (row.totalMemoryMb - row.allocatedMemoryMb) /
                DEFAULT_RUNNER_PROFILE_MEMORY_MB,
              row.maxConcurrent === 0
                ? Infinity
                : row.maxConcurrent - row.runningCount,
            ),
          ),
        },
      ];
    });
    // Shuffle first; stable sorting randomizes only candidates with equal headroom.
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const a = candidates[i],
        b = candidates[j];
      if (a && b) {
        candidates[i] = b;
        candidates[j] = a;
      }
    }
    candidates.sort((a, b) => {
      return b.score - a.score;
    });
    const preference = preparedRunnerReusePreference(
      input.reusePreparation,
      input.createdAt,
    );
    if (preference.kind === "preference") {
      const index = candidates.findIndex((c) => {
        return (
          c.runnerId === preference.runnerIdentity.runnerId &&
          c.heartbeatGeneration ===
            preference.runnerIdentity.heartbeatGeneration
        );
      });
      if (index > 0) {
        const [preferred] = candidates.splice(index, 1);
        if (preferred) {
          candidates.unshift(preferred);
        }
      }
    }
    return { candidates, preference };
  });
  return { preparation$, fleet$ };
}

interface DeliveryWindow {
  readonly notAfter: number;
  readonly monotonicDeadline: number;
}
function remainingDelivery(window: DeliveryWindow): number {
  return Math.min(
    window.notAfter - now(),
    window.monotonicDeadline - performance.now(),
  );
}
function failureInput(
  input: AdmittedRunLaunch,
  owner: DirectRunTarget | null,
  error: string,
) {
  return {
    runId: input.run.id,
    userId: input.run.userId,
    orgId: input.run.orgId,
    owner,
    error,
  };
}

/** One process retains every ambiguous attempt until this original window ends. */
const offerToProcess$ = command(
  async (
    { set },
    args: {
      readonly target: DirectRunTarget;
      readonly runId: string;
      readonly body: string;
      readonly token: string;
      readonly window: DeliveryWindow;
      readonly preferredUntil: number;
    },
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    let uncertain = false;
    let retry = 0;
    for (;;) {
      const state = await set(readDirectRunState$, args.runId, signal);
      if (
        !state ||
        state.status !== "running" ||
        state.runnerId !== args.target.runnerId ||
        state.heartbeatGeneration !== args.target.heartbeatGeneration
      ) {
        return uncertain ? ("uncertain" as const) : ("stopped" as const);
      }
      const remaining = remainingDelivery(args.window);
      if (remaining <= 0) {
        return uncertain ? ("uncertain" as const) : ("not-accepted" as const);
      }
      const earlierUncertainty: boolean = uncertain;
      uncertain = true;
      const observation = await postRunnerDispatch(
        {
          target: args.target,
          runId: args.runId,
          body: args.body,
          serviceToken: args.token,
          timeoutMs: Math.min(15_000, remaining),
        },
        signal,
      );
      if (observation === "accepted") {
        return "accepted" as const;
      }
      if (observation === "rejected") {
        return "not-accepted" as const;
      }
      if (observation === "busy" || observation === "not-delivered") {
        uncertain = earlierUncertainty;
      }
      const preferredRemaining = args.preferredUntil - now();
      if (!uncertain && (observation !== "busy" || preferredRemaining <= 0)) {
        return "not-accepted" as const;
      }
      const wait = Math.min(
        remainingDelivery(args.window),
        uncertain ? Infinity : preferredRemaining,
        Math.min(2000, 100 * 2 ** Math.min(retry++, 5)) * (1 + Math.random()),
      );
      if (wait <= 0) {
        return uncertain ? ("uncertain" as const) : ("not-accepted" as const);
      }
      await delay(wait, { signal });
    }
  },
);

export const dispatchDirectRun$ = command(
  async (
    { get, set },
    args: {
      readonly input: AdmittedRunLaunch;
      readonly graph: ReturnType<typeof createDirectRunDispatch>;
    },
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const input = args.input;
    let owner: DirectRunTarget | null = null;
    let uncertain = false;
    let reason = "Run execution preparation failed";
    const outcome = await settleIncludingAbort(async () => {
      const [executionContext, fleet] = await joinAll([
        (async () => {
          const prepared = await get(args.graph.preparation$);
          signal.throwIfAborted();
          return await set(prepareDirectRun$, prepared, signal);
        })(),
        get(args.graph.fleet$),
      ]);
      signal.throwIfAborted();
      // A queued input's latency marker can originate in an earlier invocation.
      const notAfter = Math.min(
        now() + 30_000,
        get(apiStartTime$) +
          API_INVOCATION_MAX_DURATION_SECONDS * 1000 -
          10_000,
      );
      const window = {
        notAfter,
        monotonicDeadline: performance.now() + Math.max(0, notAfter - now()),
      };
      const token = `${OFFICIAL_RUNNER_TOKEN_PREFIX}${env("OFFICIAL_RUNNER_SECRET")}`;
      reason =
        fleet.candidates.length === 0
          ? "No eligible serving Runner is available"
          : "Every eligible Runner refused this Run";
      for (const target of fleet.candidates) {
        if (remainingDelivery(window) <= 0) {
          reason = "Run delivery window expired before acceptance";
          break;
        }
        const body = JSON.stringify({
          runnerId: target.runnerId,
          heartbeatGeneration: target.heartbeatGeneration,
          profile: input.profile,
          notAfter,
          executionContext,
        });
        if (Buffer.byteLength(body, "utf8") > RUNNER_DISPATCH_MAX_BODY_BYTES) {
          reason = "Run execution input exceeds the 4 MiB Runner intake limit";
          break;
        }
        const selected = await set(
          selectDirectRunOwner$,
          {
            runId: input.run.id,
            userId: input.run.userId,
            orgId: input.run.orgId,
            target,
            previous: owner,
          },
          signal,
        );
        if (!selected) {
          break;
        }
        owner = target;
        const preference = fleet.preference;
        const preferredUntil =
          preference.kind === "preference" &&
          preference.runnerIdentity.runnerId === target.runnerId &&
          preference.runnerIdentity.heartbeatGeneration ===
            target.heartbeatGeneration
            ? Date.parse(preference.expiresAt)
            : 0;
        // An exception after entering this command cannot prove non-acceptance.
        uncertain = true;
        const delivery = await set(
          offerToProcess$,
          { target, runId: input.run.id, body, token, window, preferredUntil },
          signal,
        );
        uncertain = delivery === "uncertain";
        if (delivery === "accepted") {
          return {
            kind: "accepted" as const,
            terminal: null,
            failure: undefined,
          };
        }
        if (uncertain) {
          return {
            kind: "uncertain" as const,
            terminal: null,
            failure: undefined,
          };
        }
        if (delivery === "stopped") {
          const terminal = await set(
            failUnacceptedRun$,
            failureInput(input, owner, reason),
            signal,
          );
          return { kind: "stopped" as const, terminal, failure: undefined };
        }
      }
      const terminal = await set(
        failUnacceptedRun$,
        failureInput(input, owner, reason),
        signal,
      );
      return { kind: "failed" as const, terminal, failure: undefined };
    });
    signal.throwIfAborted();
    if (outcome.ok) {
      return outcome.value;
    }
    if (uncertain) {
      throw outcome.error;
    }
    const terminal = await set(
      failUnacceptedRun$,
      failureInput(input, owner, reason),
      signal,
    );
    return { kind: "failed" as const, terminal, failure: outcome.error };
  },
);
