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
import {
  gzipRunnerDispatchBody,
  postRunnerDispatch,
  reserveRunnerDispatch,
  runnerDispatchEncoding,
  type RunnerDispatchPreparationTiming,
} from "../external/runner-ingress";
import { failUnacceptedRun$ } from "./agent-run-terminal-transition.service";
import {
  completeDirectRunPreparation,
  prepareDirectRunContext$,
  type AdmittedRunLaunch,
  type DirectRunInput,
  type DirectRunCachePublication,
  type ExecutionBundleUrlsRead,
} from "./direct-run-preparation.service";
import type { ExecutionRuntimeResources } from "./execution-runtime-context";
import {
  selectDirectRunOwner$,
  readDirectRunState$,
  type DirectRunTarget,
} from "./direct-run-ownership.service";
import {
  rankDirectRunCandidates,
  readDirectRunCandidateSnapshot$,
} from "./runner-reuse-preference";
import { joinAll, safeSync, settleIncludingAbort } from "../utils";
import { recordRunContextSnapshot } from "./run-context-snapshot.service";

type PlacementPreference = Extract<RunnerPreference, { kind: "preference" }>;

type DirectRunCandidates = ReturnType<typeof rankDirectRunCandidates>;
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

async function timedPreparation<T>(operation: () => Promise<T>) {
  const startedAt = monotonicNow();
  const value = await operation();
  return { value, startedAt, readyAt: monotonicNow() };
}

interface DirectRunPreparationResources {
  readonly bundleUrls: ExecutionBundleUrlsRead;
  readonly resources: ExecutionRuntimeResources;
}

/** Begin preparation without a durable Run or any delivery side effects. */
export const prepareDirectRunInputs$ = command(
  (
    { set },
    input: DirectRunInput,
    createdAt: Date | null,
    { bundleUrls, resources }: DirectRunPreparationResources,
    signal: AbortSignal,
  ) => {
    return settleIncludingAbort(
      joinAll([
        timedPreparation(() => {
          return set(readDirectRunCandidateSnapshot$, input, createdAt, signal);
        }),
        timedPreparation(() => {
          return set(
            prepareDirectRunContext$,
            input,
            bundleUrls,
            resources,
            signal,
          );
        }),
      ]),
    );
  },
);

export type DirectRunInputsRead = ReturnType<
  (typeof prepareDirectRunInputs$)["write"]
>;

/** Return prepared facts so the pick entry can own publication and delivery. */
export const prepareDirectRunDispatch$ = command(
  async (
    { set },
    input: AdmittedRunLaunch,
    preparationResources: DirectRunPreparationResources,
    early: DirectRunInputsRead | undefined,
    signal: AbortSignal,
  ): Promise<DirectRunDispatchPreparation> => {
    signal.throwIfAborted();
    const prepared = await settleIncludingAbort(async () => {
      const preparation = await (early ??
        set(
          prepareDirectRunInputs$,
          input,
          input.createdAt,
          preparationResources,
          signal,
        ));
      signal.throwIfAborted();
      if (!preparation.ok) {
        throw preparation.error;
      }
      const [snapshot, context] = preparation.value;
      let placement = snapshot;
      let candidates = rankDirectRunCandidates(
        placement.value,
        input,
        early ? nowDate() : placement.value.observedAt,
      );
      // An empty early observation can miss a Runner becoming ready during commit.
      if (early && candidates.length === 0) {
        placement = await timedPreparation(() => {
          return set(
            readDirectRunCandidateSnapshot$,
            input,
            input.createdAt,
            signal,
          );
        });
        signal.throwIfAborted();
        candidates = rankDirectRunCandidates(
          placement.value,
          input,
          placement.value.observedAt,
        );
      }
      return {
        input,
        ...completeDirectRunPreparation(input, context.value),
        candidates,
        preparationTiming: {
          candidateStartedAt: placement.startedAt,
          candidateReadyAt: placement.readyAt,
          contextStartedAt: context.startedAt,
          contextReadyAt: context.readyAt,
          early: early !== undefined,
          candidateRefreshed: placement !== snapshot,
        },
      };
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

interface WireDispatchOffer extends Omit<DispatchOffer, "body"> {
  readonly body: string | Uint8Array<ArrayBuffer>;
  readonly gzipEncodeMs?: number;
}

const mayHaveTakenCustody = {
  busy: false,
  "not-delivered": false,
  unknown: true,
} as const;

function createDeliveryWindow(apiStartTime: number): DeliveryWindow {
  // A queued input's latency marker can originate in an earlier invocation.
  const notAfter = Math.min(
    now() + 30_000,
    apiStartTime + API_INVOCATION_MAX_DURATION_SECONDS * 1000 - 10_000,
  );
  return {
    notAfter,
    monotonicDeadline: performance.now() + Math.max(0, notAfter - now()),
  };
}

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
    !("homeWaitUntil" in preference.home) ||
    preference.home.homeWaitUntil === undefined
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

async function encodeDispatchOffer(
  offer: DispatchOffer,
  window: DeliveryWindow,
): Promise<WireDispatchOffer> {
  if (
    runnerDispatchEncoding(offer.bodyBytes) === "identity" ||
    remainingDelivery(window) <= 0
  ) {
    return offer;
  }
  const gzip = await gzipRunnerDispatchBody(offer.body, offer.bodyBytes);
  return {
    ...offer,
    body: gzip.bytes ?? offer.body,
    gzipEncodeMs: gzip.elapsedMs,
  };
}

function reserveFirstOffer(
  target: DirectRunTarget,
  runId: string,
  bodyBytes: number,
  signal: AbortSignal,
) {
  safeSync(() => {
    reserveRunnerDispatch(
      target,
      runId,
      signal,
      runnerDispatchEncoding(bodyBytes),
    );
  });
}

function busyRetryRemaining(
  observation: keyof typeof mayHaveTakenCustody,
  busyRetry: DispatchOffer["busyRetry"],
  finalAttempt: boolean,
) {
  if (observation !== "busy" || !busyRetry || finalAttempt) {
    return undefined;
  }
  const remaining = busyRetry.until - now();
  // A busy response sent during deferral can arrive after it expires.
  return remaining > 0 ? remaining : busyRetry.retryAtExpiry ? 0 : undefined;
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
      readonly preparedFirstOffer: WireDispatchOffer | undefined;
      readonly token: string;
      readonly window: DeliveryWindow;
      readonly preparationTiming: RunnerDispatchPreparationTiming | undefined;
    },
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    let uncertain = false;
    let retry = 0;
    let preparationTiming = args.preparationTiming;
    const offer =
      args.preparedFirstOffer ??
      (await encodeDispatchOffer(
        createDispatchOffer(
          args.envelope,
          args.body,
          args.target.preference,
          args.window,
        ),
        args.window,
      ));
    signal.throwIfAborted();
    let gzipEncodeMs = offer.gzipEncodeMs;
    let checkOwner = args.preparedFirstOffer === undefined;
    for (;;) {
      if (checkOwner) {
        const state = await set(readDirectRunState$, args.runId, signal);
        if (!isCurrentOwner(state, args.target)) {
          return uncertain ? ("uncertain" as const) : ("stopped" as const);
        }
      }
      checkOwner = true;
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
          gzipEncodeMs,
          serviceToken: args.token,
          timeoutMs: Math.min(15_000, remaining),
          firstRankedTarget: args.preparationTiming !== undefined,
          preparationTiming,
        },
        signal,
      );
      gzipEncodeMs = undefined;
      preparationTiming = undefined;
      if (observation === "accepted") {
        return "accepted" as const;
      }
      if (observation === "rejected") {
        return "not-accepted" as const;
      }
      uncertain ||= mayHaveTakenCustody[observation];
      const busyRemaining = uncertain
        ? Infinity
        : busyRetryRemaining(observation, busyRetry, finalAttempt);
      if (busyRemaining === undefined) {
        return "not-accepted" as const;
      }
      if (busyRemaining === 0) {
        continue;
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
  readonly preparationTiming: Omit<
    RunnerDispatchPreparationTiming,
    "ownerWriteMs"
  >;
  readonly contextSnapshot: Omit<
    Parameters<typeof recordRunContextSnapshot>[0],
    "recordedAt"
  >;
}

const rejectRestrictedAntigravityRun$ = command(
  async (
    { set },
    input: AdmittedRunLaunch,
    signal: AbortSignal,
  ): Promise<DirectRunDispatchResult> => {
    const terminal = await set(
      failUnacceptedRun$,
      {
        ...failureInput(input, null),
        failureReason: "provider_model_restricted",
      },
      signal,
    );
    return { kind: "failed", terminal, failure: undefined };
  },
);

export const dispatchPreparedRun$ = command(
  async ({ get, set }, args: PreparedRunDelivery, signal: AbortSignal) => {
    signal.throwIfAborted();
    const input = args.input;
    let owner: DirectRunTarget | null = null;
    let uncertain = false;
    const outcome = await settleIncludingAbort(async () => {
      const { executionContext, candidates } = args;
      if (
        executionContext.cliAgentType === "antigravity" &&
        !input.antigravityEnabled
      ) {
        return await set(rejectRestrictedAntigravityRun$, input, signal);
      }
      const window = createDeliveryWindow(get(apiStartTime$));
      const token = `${OFFICIAL_RUNNER_TOKEN_PREFIX}${env("OFFICIAL_RUNNER_SECRET")}`;
      for (const target of candidates) {
        if (remainingDelivery(window) <= 0) {
          break;
        }
        const envelope = {
          runnerId: target.runnerId,
          heartbeatGeneration: target.heartbeatGeneration,
          profile: input.profile,
          notAfter: window.notAfter,
          executionContext,
        };
        const body = serializeDispatch(envelope);
        if (body.bodyBytes > RUNNER_DISPATCH_MAX_BODY_BYTES) {
          break;
        }
        if (owner === null) {
          reserveFirstOffer(target, input.run.id, body.bodyBytes, signal);
        }
        // Finish ordinary first-send preparation before the conditional write.
        // The Runner reconciles cancellations committed after that write.
        const preparedFirstOffer =
          owner === null && !target.preference
            ? await encodeDispatchOffer(body, window)
            : undefined;
        if (preparedFirstOffer && remainingDelivery(window) <= 0) {
          break;
        }
        const ownerWriteStartedAt = monotonicNow();
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
        const ownerWriteMs = monotonicNow() - ownerWriteStartedAt;
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
            preparedFirstOffer,
            token,
            window,
            preparationTiming: firstOwner
              ? { ...args.preparationTiming, ownerWriteMs }
              : undefined,
          },
          signal,
        );
        uncertain = delivery === "uncertain";
        if (delivery === "accepted" || delivery === "uncertain") {
          return {
            kind: delivery,
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
