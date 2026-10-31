import { command, computed, state, type Command, type Computed } from "ccstate";
import type { Protocol } from "devtools-protocol";
import { createDeferredPromise, type DeferredPromise } from "../../utils.ts";
import type { CdpClient } from "../cdp/client.ts";
import { CdpFault, requestDetails } from "../cdp/errors.ts";
import {
  constrainDisplay,
  nativePresentation,
  projectDisplay,
  windowPresentation,
  type DisplaySize,
} from "./geometry.ts";
import type {
  DisplayDecision,
  DisplayOutcome,
  DisplayStage,
} from "./policy.ts";
import type {
  NativeCapture,
  PresentationReceipt,
  WriteRollback,
} from "./viewport.ts";
import {
  createDisplayPreparation,
  type DisplaySnapshot,
  type DisplayTarget,
} from "./preparation.ts";
import { captureBoundary } from "./capture-boundary.ts";

export interface DisplayEffects {
  readonly windowId: number | null;
  readonly capturePending$: Computed<boolean>;
  readonly refresh$: Command<
    Promise<void>,
    [Command<Promise<void>, []>, AbortSignal]
  >;
}

export interface ExecutionPolicy {
  readonly decide$: Command<DisplayDecision | null, [number]>;
  readonly prepared$: Command<boolean, []>;
  readonly stage$: Command<
    boolean,
    [Exclude<DisplayStage, "preparing" | "prepared">]
  >;
}

export type DisplayResult =
  | Extract<DisplayOutcome, { readonly kind: "completed" }>
  | { readonly kind: "deferred" }
  | { readonly kind: "retired" }
  | { readonly kind: "failed"; readonly error: CdpFault };

export interface DisplayCompletion {
  readonly outcome: Extract<DisplayOutcome, { readonly kind: "completed" }>;
  readonly windowId: number;
  readonly size: DisplaySize;
  readonly decision: DisplayDecision;
  readonly presentation: PresentationReceipt;
}

export interface DisplayTransaction {
  readonly execute$: Command<
    Promise<DisplayResult>,
    [ExecutionPolicy, AbortSignal]
  >;
  readonly completed$: Computed<DisplayCompletion | null>;
}

type Mutation =
  | { readonly kind: "none" | "applied" }
  | { readonly kind: "pending"; readonly rollback: WriteRollback };

function projection(
  windowId: number,
  decision: DisplayDecision,
  remote: DisplaySize,
  layout: Protocol.Page.GetLayoutMetricsResponse,
) {
  const size = constrainDisplay(
    decision.kind === "fit"
      ? decision.size
      : {
          width: (remote.width * remote.dpr) / decision.dpr,
          height: (remote.height * remote.dpr) / decision.dpr,
          dpr: decision.dpr,
        },
  );
  return { size, projected: projectDisplay(windowId, size, layout) };
}

/** Native stop/prepare/start rendezvous; never a cached UI operation. */
interface CaptureHandoff {
  readonly begun: DeferredPromise<void>;
  readonly prepared: DeferredPromise<void>;
}

interface AppliedReceipt {
  readonly windowId: number;
  readonly prepared: ReturnType<typeof projection>;
  readonly decision: DisplayDecision;
  readonly presentation: PresentationReceipt;
}

interface TransactionHost {
  readonly client: CdpClient;
  readonly target: DisplayTarget;
  readonly host: DisplayEffects;
  readonly ownsTarget$: Computed<boolean>;
}

function createTransactionState(context: TransactionHost) {
  const { ownsTarget$, target } = context;
  const applied$ = state<AppliedReceipt | null>(null);
  const completion$ = state<DisplayCompletion | null>(null);
  const mutation$ = state<Mutation>({ kind: "none" });
  const executing$ = state(false);
  const captureHandoff$ = state<CaptureHandoff | null>(null);
  const nativeCapture$ = state<NativeCapture | null>(null);

  const completed$ = computed((get) => {
    return get(completion$);
  });
  const current$ = command(({ get }, signal: AbortSignal) => {
    return (
      !signal.aborted && get(executing$) && get(ownsTarget$) && target.current()
    );
  });
  return {
    applied$,
    completion$,
    mutation$,
    executing$,
    captureHandoff$,
    nativeCapture$,
    completed$,
    current$,
  };
}

type TransactionContext = TransactionHost &
  ReturnType<typeof createTransactionState>;

function createCapturePreparation(context: TransactionContext) {
  const { current$, client, target, nativeCapture$, captureHandoff$ } = context;
  const prepareFence$ = command(
    async (
      { set },
      kind: "native" | "presentation",
      signal: AbortSignal,
    ): Promise<void> => {
      if (!set(current$, signal)) {
        return;
      }
      const boundary = await captureBoundary(client, target.sessionId, () => {
        return !signal.aborted && target.current();
      });
      signal.throwIfAborted();
      if (boundary === null || !set(current$, signal)) {
        return;
      }
      if (kind === "native") {
        set(nativeCapture$, set(target.geometry.fenceNative$, boundary));
      } else {
        set(target.geometry.fence$, boundary);
      }
    },
  );
  // The host's fixed zero-argument callback announces its native preparation
  // boundary. The awaited command chain, not this callback, owns the signal.
  const prepareCapture$ = command(({ get }): Promise<void> => {
    const handoff = get(captureHandoff$);
    if (!handoff) {
      return Promise.reject(
        new CdpFault("display", "The capture preparation is no longer active."),
      );
    }
    if (!handoff.begun.settled()) {
      handoff.begun.resolve();
    }
    return handoff.prepared.promise;
  });
  const prepareBoundary$ = command(
    async (
      { set },
      handoff: CaptureHandoff,
      kind: "native" | "presentation",
      signal: AbortSignal,
    ): Promise<void> => {
      const [admission] = await Promise.allSettled([handoff.begun.promise]);
      if (signal.aborted) {
        signal.throwIfAborted();
      }
      if (admission.status === "rejected") {
        if (!handoff.prepared.settled()) {
          handoff.prepared.reject(admission.reason);
        }
        throw admission.reason;
      }
      const [result] = await Promise.allSettled([
        set(prepareFence$, kind, signal),
      ]);
      if (signal.aborted) {
        signal.throwIfAborted();
      }
      if (result.status === "rejected") {
        if (!handoff.prepared.settled()) {
          handoff.prepared.reject(result.reason);
        }
        throw result.reason;
      }
      if (!handoff.prepared.settled()) {
        handoff.prepared.resolve();
      }
    },
  );
  return { prepareCapture$, prepareBoundary$ };
}

function createCaptureRefresh(
  context: TransactionContext & ReturnType<typeof createCapturePreparation>,
) {
  const {
    host,
    prepareCapture$,
    current$,
    nativeCapture$,
    target,
    captureHandoff$,
    prepareBoundary$,
  } = context;
  const invokeRefresh$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      await set(host.refresh$, prepareCapture$, signal);
    },
  );
  const refreshCapture$ = command(
    async (
      { set },
      handoff: CaptureHandoff,
      signal: AbortSignal,
    ): Promise<void> => {
      const [result] = await Promise.allSettled([set(invokeRefresh$, signal)]);
      if (signal.aborted) {
        signal.throwIfAborted();
      }
      if (!handoff.begun.settled()) {
        const error =
          result.status === "rejected"
            ? result.reason
            : new CdpFault(
                "display",
                "The capture stream did not prepare its display boundary.",
              );
        handoff.begun.reject(error);
        throw error;
      }
      if (result.status === "rejected") {
        throw result.reason;
      }
    },
  );
  const fenceCapture$ = command(
    async (
      { get, set },
      kind: "native" | "presentation",
      signal: AbortSignal,
    ): Promise<NativeCapture | null> => {
      if (!set(current$, signal)) {
        return null;
      }
      if (kind === "native") {
        set(nativeCapture$, null);
        set(target.geometry.fenceNative$, Infinity);
      }
      const handoff: CaptureHandoff = {
        begun: createDeferredPromise<void>(signal),
        prepared: createDeferredPromise<void>(signal),
      };
      set(captureHandoff$, handoff);
      const results = await Promise.allSettled([
        set(refreshCapture$, handoff, signal),
        set(prepareBoundary$, handoff, kind, signal),
      ]);
      if (signal.aborted) {
        if (get(captureHandoff$) === handoff) {
          set(captureHandoff$, null);
        }
        signal.throwIfAborted();
      }
      if (get(captureHandoff$) === handoff) {
        set(captureHandoff$, null);
      }
      for (const result of results) {
        if (result.status === "rejected") {
          throw result.reason;
        }
      }
      return set(current$, signal) ? get(nativeCapture$) : null;
    },
  );
  const refreshNative$ = command(
    ({ set }, signal: AbortSignal): Promise<NativeCapture | null> => {
      return set(fenceCapture$, "native", signal);
    },
  );
  return { fenceCapture$, refreshNative$ };
}

type CaptureContext = TransactionContext &
  ReturnType<typeof createCaptureRefresh>;

function createTransactionCompletion(context: CaptureContext) {
  const { current$, target, applied$, completion$, fenceCapture$ } = context;
  const complete$ = command(
    (
      { set },
      receipt: AppliedReceipt,
      proof: "painted" | "reused",
      signal: AbortSignal,
    ): DisplayResult => {
      if (!set(current$, signal)) {
        return { kind: "retired" };
      }
      // Awaiting a frame is not sufficient: the exact projection must still be
      // the one painted when publishing the completion receipt.
      if (
        !set(
          target.geometry.matches$,
          receipt.presentation.expected,
          receipt.prepared.projected.input,
        )
      ) {
        throw new CdpFault(
          "display",
          "The synchronized image is no longer current.",
        );
      }
      const outcome = {
        kind: "completed",
        proof,
        windowId: receipt.windowId,
        dpr: receipt.prepared.size.dpr,
      } as const;
      set(applied$, receipt);
      set(completion$, {
        outcome,
        windowId: receipt.windowId,
        size: receipt.prepared.size,
        decision: receipt.decision,
        presentation: receipt.presentation,
      });
      return outcome;
    },
  );

  const present$ = command(
    async (
      { set },
      receipt: AppliedReceipt,
      freshCapture: boolean,
      signal: AbortSignal,
    ): Promise<DisplayResult> => {
      if (freshCapture) {
        await set(fenceCapture$, "presentation", signal);
      }
      if (!set(current$, signal)) {
        return { kind: "retired" };
      }
      const outcome = await set(
        target.geometry.waitForPresentation$,
        !freshCapture,
        signal,
      );
      if (!set(current$, signal)) {
        return { kind: "retired" };
      }
      if (
        outcome === "inconsistent" &&
        !set(
          target.geometry.matches$,
          receipt.presentation.expected,
          receipt.prepared.projected.input,
        )
      ) {
        // A clipped static image can be the last stream frame. Refresh once on
        // evidence, retiring queued decodes before the stream is restarted.
        set(target.geometry.apply$, receipt.presentation, true);
        await set(fenceCapture$, "presentation", signal);
        if (!set(current$, signal)) {
          return { kind: "retired" };
        }
        await set(target.geometry.waitForPresentation$, false, signal);
      }
      return set(complete$, receipt, "painted", signal);
    },
  );
  return { complete$, present$ };
}

type ProjectionContext = CaptureContext &
  ReturnType<typeof createTransactionCompletion> & {
    readonly preparation: ReturnType<typeof createDisplayPreparation>;
  };

interface ProjectionRequest {
  readonly policy: ExecutionPolicy;
  readonly snapshot: DisplaySnapshot;
  readonly prepared: ReturnType<typeof projection>;
  readonly decision: DisplayDecision;
}

function createProjectionWrite(context: ProjectionContext) {
  const { current$, target, preparation, mutation$, client, host, present$ } =
    context;
  const applyProjection$ = command(
    async (
      { get, set },
      request: ProjectionRequest,
      signal: AbortSignal,
    ): Promise<DisplayResult> => {
      const { policy, snapshot, prepared, decision } = request;
      const { window, layout } = snapshot;
      const { projected, size } = prepared;
      if (!set(current$, signal) || !set(policy.prepared$)) {
        return { kind: set(current$, signal) ? "deferred" : "retired" };
      }
      const needsCaptureFence = set(
        target.geometry.captureFence$,
        layout,
        projected.input,
      );
      if (!set(preparation.currentSnapshot$, snapshot)) {
        return { kind: set(current$, signal) ? "deferred" : "retired" };
      }
      const rollback = set(target.geometry.beginWrite$);
      if (!set(policy.stage$, "writing")) {
        set(target.geometry.rejectWrite$, rollback);
        return { kind: set(current$, signal) ? "deferred" : "retired" };
      }
      if (!set(current$, signal)) {
        return { kind: "retired" };
      }
      set(mutation$, { kind: "pending", rollback });
      await client.request(
        "Emulation.setDeviceMetricsOverride",
        projected.metrics,
        target.sessionId,
      );
      signal.throwIfAborted();
      if (!set(current$, signal)) {
        return { kind: "retired" };
      }
      set(mutation$, { kind: "applied" });
      let acknowledged = await set(
        preparation.confirm$,
        window.windowId,
        signal,
      );
      if (!set(current$, signal)) {
        return { kind: "retired" };
      }
      if (decision.kind === "fit" || size.constrained) {
        await client.request("Browser.setContentsSize", projected.contents);
        signal.throwIfAborted();
        if (!set(current$, signal)) {
          return { kind: "retired" };
        }
        acknowledged = await set(preparation.confirm$, window.windowId, signal);
        if (!set(current$, signal)) {
          return { kind: "retired" };
        }
      }
      const presentation = windowPresentation(
        snapshot.native,
        acknowledged.bounds,
        projected.presentation.nativeDpr,
      );
      const freshCapture =
        needsCaptureFence(presentation) || get(host.capturePending$);
      const receipt: AppliedReceipt = {
        windowId: window.windowId,
        prepared,
        decision,
        presentation: { transform: projected.input, expected: presentation },
      };
      set(target.geometry.apply$, receipt.presentation, freshCapture);
      if (!set(policy.stage$, "presenting")) {
        throw new CdpFault("display", "The display projection was superseded.");
      }
      return set(present$, receipt, freshCapture, signal);
    },
  );
  return { applyProjection$ };
}

function createTransactionPerform(
  context: ProjectionContext & ReturnType<typeof createProjectionWrite>,
) {
  const {
    preparation,
    current$,
    target,
    applied$,
    complete$,
    applyProjection$,
  } = context;
  const perform$ = command(
    async (
      { get, set },
      policy: ExecutionPolicy,
      signal: AbortSignal,
    ): Promise<DisplayResult> => {
      const snapshot = await set(preparation.acquire$, signal);
      if (!snapshot || !set(current$, signal)) {
        return { kind: set(current$, signal) ? "deferred" : "retired" };
      }
      const decision = set(preparation.currentSnapshot$, snapshot)
        ? set(policy.decide$, snapshot.window.windowId)
        : null;
      if (!decision) {
        return { kind: set(current$, signal) ? "deferred" : "retired" };
      }
      // Lock the original decision, not just its constrained projection. Manual
      // completion must distinguish exact local sizes sharing a projection.
      const locked: DisplayDecision =
        decision.kind === "fit"
          ? { kind: "fit", size: { ...decision.size } }
          : { ...decision };
      const prepared = projection(
        snapshot.window.windowId,
        locked,
        snapshot.remote,
        snapshot.layout,
      );
      const existing = windowPresentation(
        snapshot.native,
        snapshot.window.bounds,
        prepared.projected.presentation.nativeDpr,
      );
      const applied = get(applied$);
      if (
        applied?.prepared.projected.key === prepared.projected.key &&
        set(target.geometry.matches$, existing, prepared.projected.input)
      ) {
        if (!set(policy.prepared$)) {
          return { kind: set(current$, signal) ? "deferred" : "retired" };
        }
        return set(
          complete$,
          {
            windowId: snapshot.window.windowId,
            prepared,
            decision: locked,
            presentation: {
              transform: prepared.projected.input,
              expected: existing,
            },
          },
          "reused",
          signal,
        );
      }
      return set(
        applyProjection$,
        { policy, snapshot, prepared, decision: locked },
        signal,
      );
    },
  );
  return { perform$ };
}

function createTransactionRestore(context: CaptureContext) {
  const { current$, client, target, fenceCapture$ } = context;
  const restore$ = command(
    async ({ set }, signal: AbortSignal): Promise<boolean> => {
      if (!set(current$, signal)) {
        return false;
      }
      const [cleared] = await Promise.allSettled([
        client.request(
          "Emulation.clearDeviceMetricsOverride",
          undefined,
          target.sessionId,
        ),
      ]);
      signal.throwIfAborted();
      if (cleared.status === "rejected" || !set(current$, signal)) {
        return false;
      }
      const layout = await client.request(
        "Page.getLayoutMetrics",
        undefined,
        target.sessionId,
      );
      signal.throwIfAborted();
      if (!set(current$, signal)) {
        return false;
      }
      set(
        target.geometry.apply$,
        { transform: null, expected: nativePresentation(layout) },
        true,
      );
      await set(fenceCapture$, "presentation", signal);
      if (!set(current$, signal)) {
        return false;
      }
      await set(target.geometry.waitForPresentation$, false, signal);
      return set(current$, signal);
    },
  );
  return { restore$ };
}

function createTransactionRecovery(
  context: TransactionContext & ReturnType<typeof createTransactionRestore>,
) {
  const { current$, mutation$, target, applied$, completion$, restore$ } =
    context;
  const recover$ = command(
    async (
      { get, set },
      policy: ExecutionPolicy,
      error: unknown,
      signal: AbortSignal,
    ): Promise<DisplayResult> => {
      if (!set(current$, signal)) {
        return { kind: "retired" };
      }
      const mutation = get(mutation$);
      const uncertain =
        mutation.kind === "pending" &&
        !(error instanceof CdpFault && error.code !== undefined);
      if (mutation.kind === "pending" && !uncertain) {
        set(target.geometry.rejectWrite$, mutation.rollback);
      }
      let restored = true;
      if (mutation.kind === "applied" || uncertain) {
        set(target.geometry.uncertain$);
        set(applied$, null);
        set(completion$, null);
        set(policy.stage$, "recovering");
        const [recovery] = await Promise.allSettled([set(restore$, signal)]);
        signal.throwIfAborted();
        if (!set(current$, signal)) {
          return { kind: "retired" };
        }
        restored = recovery.status === "fulfilled" && recovery.value;
        if (!restored) {
          set(target.geometry.uncertain$);
        }
      }
      return {
        kind: "failed",
        error: !restored
          ? new CdpFault(
              "display",
              "Display recovery could not be confirmed. Try synchronizing again.",
              undefined,
              requestDetails(error),
            )
          : error instanceof CdpFault &&
              ["scope", "display"].includes(error.kind)
            ? error
            : new CdpFault(
                error instanceof CdpFault && error.code === -32_601
                  ? "unsupported-capability"
                  : "display",
                "The browser display could not be synchronized. Check window support and try again.",
                undefined,
                requestDetails(error),
              ),
      };
    },
  );
  return { recover$ };
}

function createTransactionExecution(
  context: TransactionContext &
    ReturnType<typeof createTransactionPerform> &
    ReturnType<typeof createTransactionRecovery>,
) {
  const {
    executing$,
    mutation$,
    perform$,
    ownsTarget$,
    target,
    applied$,
    completion$,
    recover$,
  } = context;
  const execute$ = command(
    async (
      { get, set },
      policy: ExecutionPolicy,
      signal: AbortSignal,
    ): Promise<DisplayResult> => {
      signal.throwIfAborted();
      if (get(executing$)) {
        throw new CdpFault(
          "display",
          "A display transaction is already executing.",
        );
      }
      set(executing$, true);
      set(mutation$, { kind: "none" });
      const [operation] = await Promise.allSettled([
        set(perform$, policy, signal),
      ]);
      if (signal.aborted) {
        // Cancellation never starts unowned recovery. Invalidate uncertain
        // native writes only while this exact selection still owns geometry.
        if (
          get(ownsTarget$) &&
          target.current() &&
          get(mutation$).kind !== "none"
        ) {
          set(target.geometry.uncertain$);
          set(applied$, null);
          set(completion$, null);
        }
        set(executing$, false);
        signal.throwIfAborted();
      }
      const [result] = await Promise.allSettled([
        operation.status === "fulfilled"
          ? Promise.resolve(operation.value)
          : set(recover$, policy, operation.reason, signal),
      ]);
      if (signal.aborted) {
        set(executing$, false);
        signal.throwIfAborted();
      }
      // This executor is serialized; no old execution can clear a successor.
      set(executing$, false);
      if (result.status === "rejected") {
        throw result.reason;
      }
      return result.value;
    },
  );
  return { execute$ };
}

/** A selected session's native effects and painted proof, never window policy. */
export function createDisplayTransaction(
  client: CdpClient,
  target: DisplayTarget,
  host: DisplayEffects,
  ownsTarget$: Computed<boolean>,
): DisplayTransaction {
  const native = { client, target, host, ownsTarget$ };
  const context = { ...native, ...createTransactionState(native) };
  const capture = createCaptureRefresh({
    ...context,
    ...createCapturePreparation(context),
  });
  const captureContext = { ...context, ...capture };
  const preparation = createDisplayPreparation(
    client,
    target,
    host.windowId,
    target.current,
    capture.refreshNative$,
    ownsTarget$,
  );
  const projectionContext = {
    ...captureContext,
    ...createTransactionCompletion(captureContext),
    preparation,
  };
  const perform = createTransactionPerform({
    ...projectionContext,
    ...createProjectionWrite(projectionContext),
  });
  const recovery = createTransactionRecovery({
    ...context,
    ...createTransactionRestore(captureContext),
  });
  const execution = createTransactionExecution({
    ...context,
    ...perform,
    ...recovery,
  });
  return { execute$: execution.execute$, completed$: context.completed$ };
}
