import {
  RUNNER_DISPATCH_MAX_BODY_BYTES,
  type runnerDispatchEnvelopeSchema,
} from "@okouai/api-contracts/contracts/runner-dispatch";
import { OFFICIAL_RUNNER_TOKEN_PREFIX } from "@okouai/api-contracts/contracts/runner-primitives";
import type {
  ExecutionContext,
  RunnerPreference,
} from "@okouai/api-contracts/contracts/runners";
import { command, type Command } from "ccstate";
import { delay } from "signal-timers";
import type { output } from "zod";
import { env } from "../../lib/env";
import { API_INVOCATION_MAX_DURATION_SECONDS } from "../../lib/invocation-budget";
import { monotonicNow, now, nowDate } from "../../lib/time";
import { apiStartTime$ } from "../context/hono";
import { postRunnerDispatch } from "../external/runner-ingress";
import { currentRunnerDispatchTransport } from "../external/runner-dispatch-transport";
import { failUnacceptedRun$ } from "./agent-run-terminal-transition.service";
import {
  prepareDirectRun$,
  type AdmittedRunLaunch,
  type DirectRunCachePublication,
} from "./direct-run-preparation.service";
import {
  selectDirectRunOwner$,
  readDirectRunState$,
  type DirectRunTarget,
} from "./direct-run-ownership.service";
import { readDirectRunCandidates$ } from "./runner-reuse-preference";
import { joinAll, safeSync, settleIncludingAbort } from "../utils";
import { recordRunContextSnapshot } from "./run-context-snapshot.service";

type PlacementPreference = Extract<RunnerPreference, { kind: "preference" }>;

type DirectRunCandidates = Awaited<
  ReturnType<(typeof readDirectRunCandidates$)["write"]>
>;
const MAX_HOME_DEFERRAL_MS = 1000;
const FINAL_HOME_DELIVERY_MARGIN_MS = 1000;
type UnacceptedRunResult =
  typeof failUnacceptedRun$ extends Command<Promise<infer Result>, infer _Args>
    ? Result
    : never;

export interface DirectRunDispatchResult {
  readonly kind: "accepted" | "uncertain" | "stopped" | "failed";
  readonly terminal: UnacceptedRunResult;
  readonly failure: Error | undefined;
}

type DirectRunDispatchPreparation =
  | {
      readonly kind: "prepared";
      readonly delivery: PreparedRunDelivery;
      readonly cachePublication: DirectRunCachePublication;
    }
  | { readonly kind: "failed"; readonly result: DirectRunDispatchResult };

/** Return prepared facts so the pick entry can own publication and delivery. */
export const prepareDirectRunDispatch$ = command(
  async (
    { set },
    input: AdmittedRunLaunch,
    signal: AbortSignal,
  ): Promise<DirectRunDispatchPreparation> => {
    signal.throwIfAborted();
    const prepared = await settleIncludingAbort(async () => {
      const [publication, placement] = await joinAll([
        set(prepareDirectRun$, input, signal),
        (async () => {
          const candidates = await set(readDirectRunCandidates$, input, signal);
          const candidatesReadyAt = monotonicNow();
          const dispatchTransport = currentRunnerDispatchTransport();
          const target = candidates[0];
          if (dispatchTransport && target) {
            safeSync(() => {
              dispatchTransport.reserve(
                input.run.id,
                `https://${target.hostname}`,
                signal,
              );
            });
          }
          return { candidates, candidatesReadyAt };
        })(),
      ]);
      signal.throwIfAborted();
      return { input, ...publication, ...placement };
    });
    signal.throwIfAborted();
    if (!prepared.ok) {
      const terminal = await set(
        failUnacceptedRun$,
        failureInput(input, null),
        signal,
      );
      return {
        kind: "failed",
        result: {
          kind: "failed",
          terminal,
          failure: new Error("Run execution preparation failed"),
        },
      };
    }
    const { cachePublication, ...delivery } = prepared.value;
    return { kind: "prepared", delivery, cachePublication };
  },
);

interface DeliveryWindow {
  readonly notAfter: number;
  readonly monotonicDeadline: number;
}
type DispatchEnvelope = output<typeof runnerDispatchEnvelopeSchema>;

interface SerializedDispatch {
  readonly body: string;
  readonly bodyBytes: number;
}

interface DispatchOffer extends SerializedDispatch {
  readonly busyRetry?: {
    readonly until: number;
    readonly retryAtExpiry: boolean;
  };
}

const mayHaveTakenCustody = {
  busy: false,
  "not-delivered": false,
  unknown: true,
} as const;

function remainingDelivery(window: DeliveryWindow): number {
  return Math.min(
    window.notAfter - now(),
    window.monotonicDeadline - performance.now(),
  );
}

function serializeDispatch(envelope: DispatchEnvelope): SerializedDispatch {
  const body = JSON.stringify(envelope);
  return { body, bodyBytes: Buffer.byteLength(body, "utf8") };
}

function createDispatchOffer(
  envelope: DispatchEnvelope,
  ordinaryBody: SerializedDispatch,
  preference: PlacementPreference | undefined,
  window: DeliveryWindow,
): DispatchOffer {
  if (!preference) {
    return ordinaryBody;
  }
  const expiresAt = Date.parse(preference.expiresAt);
  const ordinaryOffer = {
    ...ordinaryBody,
    busyRetry: { until: expiresAt, retryAtExpiry: false },
  };
  if (
    preference.tier !== "predecessorHome" ||
    preference.home.evidence !== "expected"
  ) {
    return ordinaryOffer;
  }
  const sentAt = now();
  const waitUntil = Math.floor(
    Math.min(
      sentAt + MAX_HOME_DEFERRAL_MS,
      sentAt + remainingDelivery(window) - FINAL_HOME_DELIVERY_MARGIN_MS,
      expiresAt,
      Date.parse(preference.home.homeWaitUntil),
    ),
  );
  if (waitUntil <= sentAt) {
    return ordinaryOffer;
  }
  const preferredBody = serializeDispatch({
    ...envelope,
    preferredHomeCheckout: {
      predecessorRunId: preference.predecessorRunId,
      waitUntil,
    },
  });
  return preferredBody.bodyBytes <= RUNNER_DISPATCH_MAX_BODY_BYTES
    ? { ...preferredBody, busyRetry: { until: waitUntil, retryAtExpiry: true } }
    : ordinaryOffer;
}

function isCurrentOwner(
  state: Awaited<ReturnType<(typeof readDirectRunState$)["write"]>>,
  target: DirectRunTarget,
): boolean {
  return (
    state?.status === "running" &&
    state.runnerId === target.runnerId &&
    state.heartbeatGeneration === target.heartbeatGeneration
  );
}
function failureInput(input: AdmittedRunLaunch, owner: DirectRunTarget | null) {
  return {
    runId: input.run.id,
    userId: input.run.userId,
    orgId: input.run.orgId,
    owner,
    failureReason: "unknown" as const,
  };
}

/** One process retains every ambiguous attempt until this original window ends. */
const offerToProcess$ = command(
  async (
    { set },
    args: {
      readonly target: DirectRunCandidates[number];
      readonly runId: string;
      readonly body: SerializedDispatch;
      readonly envelope: DispatchEnvelope;
      readonly token: string;
      readonly window: DeliveryWindow;
      readonly firstCandidateReadyAt: number | undefined;
    },
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    let uncertain = false;
    let retry = 0;
    let firstCandidateReadyAt = args.firstCandidateReadyAt;
    let offer: DispatchOffer | undefined;
    for (;;) {
      // Runner reconciles cancellation asynchronously after binding the supplied
      // input. Check ownership immediately before the first offer and after waits.
      const state = await set(readDirectRunState$, args.runId, signal);
      if (!isCurrentOwner(state, args.target)) {
        return uncertain ? ("uncertain" as const) : ("stopped" as const);
      }
      offer ??= createDispatchOffer(
        args.envelope,
        args.body,
        args.target.preference,
        args.window,
      );
      const remaining = remainingDelivery(args.window);
      if (remaining <= 0) {
        return uncertain ? ("uncertain" as const) : ("not-accepted" as const);
      }
      const { busyRetry } = offer;
      const finalAttempt =
        busyRetry?.retryAtExpiry === true && now() >= busyRetry.until;
      const observation = await postRunnerDispatch(
        {
          target: args.target,
          runId: args.runId,
          body: offer.body,
          bodyBytes: offer.bodyBytes,
          serviceToken: args.token,
          timeoutMs: Math.min(15_000, remaining),
          firstRankedTarget: args.firstCandidateReadyAt !== undefined,
          firstCandidateReadyAt,
        },
        signal,
      );
      firstCandidateReadyAt = undefined;
      if (observation === "accepted") {
        return "accepted" as const;
      }
      if (observation === "rejected") {
        return "not-accepted" as const;
      }
      uncertain ||= mayHaveTakenCustody[observation];
      let busyRemaining = Infinity;
      if (!uncertain) {
        if (observation !== "busy" || !busyRetry || finalAttempt) {
          return "not-accepted" as const;
        }
        busyRemaining = busyRetry.until - now();
        if (busyRemaining <= 0) {
          if (!busyRetry.retryAtExpiry) {
            return "not-accepted" as const;
          }
          // A busy response sent during deferral can arrive after it expires.
          continue;
        }
      }
      const wait = Math.min(
        remainingDelivery(args.window),
        busyRemaining,
        Math.min(2000, 100 * 2 ** Math.min(retry++, 5)) * (1 + Math.random()),
      );
      if (wait <= 0) {
        return uncertain ? ("uncertain" as const) : ("not-accepted" as const);
      }
      await delay(wait, { signal });
    }
  },
);

interface PreparedRunDelivery {
  readonly input: AdmittedRunLaunch;
  readonly executionContext: ExecutionContext;
  readonly candidates: DirectRunCandidates;
  readonly candidatesReadyAt: number;
  readonly contextSnapshot: Omit<
    Parameters<typeof recordRunContextSnapshot>[0],
    "recordedAt"
  >;
}

export const dispatchPreparedRun$ = command(
  async ({ get, set }, args: PreparedRunDelivery, signal: AbortSignal) => {
    signal.throwIfAborted();
    const input = args.input;
    let owner: DirectRunTarget | null = null;
    let uncertain = false;
    const outcome = await settleIncludingAbort(async () => {
      const { executionContext, candidates } = args;
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
      for (const target of candidates) {
        if (remainingDelivery(window) <= 0) {
          break;
        }
        const envelope = {
          runnerId: target.runnerId,
          heartbeatGeneration: target.heartbeatGeneration,
          profile: input.profile,
          notAfter,
          executionContext,
        };
        const body = serializeDispatch(envelope);
        if (body.bodyBytes > RUNNER_DISPATCH_MAX_BODY_BYTES) {
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
        const firstOwner = owner === null;
        owner = target;
        if (firstOwner) {
          recordRunContextSnapshot({
            ...args.contextSnapshot,
            recordedAt: nowDate(),
          });
        }
        // An exception after entering this command cannot prove non-acceptance.
        uncertain = true;
        const delivery = await set(
          offerToProcess$,
          {
            target,
            runId: input.run.id,
            body,
            envelope,
            token,
            window,
            firstCandidateReadyAt: firstOwner
              ? args.candidatesReadyAt
              : undefined,
          },
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
            failureInput(input, owner),
            signal,
          );
          return { kind: "stopped" as const, terminal, failure: undefined };
        }
      }
      const terminal = await set(
        failUnacceptedRun$,
        failureInput(input, owner),
        signal,
      );
      return { kind: "failed" as const, terminal, failure: undefined };
    });
    signal.throwIfAborted();
    if (outcome.ok) {
      return outcome.value;
    }
    if (uncertain) {
      throw new Error("Run delivery outcome is uncertain");
    }
    const terminal = await set(
      failUnacceptedRun$,
      failureInput(input, owner),
      signal,
    );
    return {
      kind: "failed" as const,
      terminal,
      failure: new Error("Run delivery failed"),
    };
  },
);
