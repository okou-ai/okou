import { command, computed, state, type Command, type Computed } from "ccstate";
import { throttleCommand } from "../../command-scheduling.ts";
import {
  createDeferredPromise,
  detach,
  isAbortError,
  Reason,
  resetSignal,
  type DeferredPromise,
} from "../../utils.ts";
import type { CdpClient } from "../cdp/client.ts";
import { CdpFault, requestDetails } from "../cdp/errors.ts";
import type { WindowSizeSync } from "../viewer/types.ts";
import type { DisplaySize } from "./geometry.ts";
import {
  activeDisplayIntent,
  canBeginDisplay,
  createDisplayPolicy,
  decideDisplay,
  transitionDisplay,
  type DisplayEvent,
  type DisplayIntent,
  type DisplayPolicy,
  type DisplayStage,
} from "./policy.ts";
import {
  createDisplayTransaction,
  type DisplayCompletion,
  type DisplayEffects,
  type DisplayResult,
  type ExecutionPolicy,
} from "./transaction.ts";
import type { DisplayTarget } from "./preparation.ts";

const minimumSyncIntervalMs = 150;

export interface DisplayState {
  readonly ready: boolean;
  readonly pending: boolean;
  readonly pointerBlocked: boolean;
}

export interface DisplaySyncHost extends DisplayEffects {
  readonly settled$?: Command<void, []>;
}

export type DisplayModeResult =
  | { readonly kind: "policy-updated"; readonly mode: WindowSizeSync }
  | {
      readonly kind: "synchronized";
      readonly mode: WindowSizeSync;
      readonly completion: DisplayCompletion;
    };

export interface DisplayExecutionOutcome {
  readonly target: DisplayTarget;
  readonly intent: DisplayIntent;
  readonly result: Exclude<DisplayResult, { readonly kind: "deferred" }>;
  readonly completion: DisplayCompletion | null;
}

export type DisplayRecovery = DisplayExecutionOutcome & {
  readonly result: Extract<DisplayResult, { readonly kind: "failed" }>;
};

export interface DisplaySync {
  readonly state$: Computed<DisplayState>;
  readonly recovery$: Computed<DisplayRecovery | null>;
  readonly changeMode$: Command<
    Promise<DisplayModeResult>,
    [WindowSizeSync, AbortSignal]
  >;
  readonly start$: Command<void, [AbortSignal]>;
  readonly setTarget$: Command<void, [DisplayTarget | null]>;
  readonly setMode$: Command<void, [WindowSizeSync]>;
  readonly measure$: Command<void, [DisplaySize | null]>;
  readonly setSuspended$: Command<void, [boolean]>;
  readonly close$: Command<void, []>;
  readonly syncDisplay$: Command<Promise<void>, [AbortSignal]>;
  readonly waitForIdle$: Command<Promise<void>, [AbortSignal]>;
}

interface Selection {
  readonly target: DisplayTarget;
}

/** A caller-awaited request settles when its own intent is published or retired. */
interface ManualRequest {
  readonly selection: Selection;
  readonly size: DisplaySize;
  readonly revision: number;
  readonly done: DeferredPromise<void>;
}

interface ModeRequest {
  readonly selection: Selection;
  readonly revision: number;
  readonly mode: WindowSizeSync;
  readonly done: DeferredPromise<DisplayCompletion>;
}

/** The native write currently in flight, kept so cleanup can await its end. */
interface Execution {
  readonly intent: DisplayIntent;
  readonly operation: Promise<unknown>;
}

/** One retained native outcome, not a copied request-error/notification model. */
interface DisplayReceipt extends DisplayExecutionOutcome {
  readonly selection: Selection;
}

function cancelled(): DOMException {
  return new DOMException(
    "Display synchronization was cancelled.",
    "AbortError",
  );
}

function sameSize(left: DisplaySize, right: DisplaySize): boolean {
  return (
    left.width === right.width &&
    left.height === right.height &&
    left.dpr === right.dpr
  );
}

function modeRequestCurrent(
  request: ModeRequest,
  selection: Selection | null,
  policy: DisplayPolicy,
): boolean {
  return (
    selection === request.selection &&
    request.selection.target.current() &&
    policy.revision === request.revision &&
    policy.mode === request.mode &&
    !policy.suspended &&
    !!policy.local &&
    policy.execution.kind !== "closed"
  );
}

function createSyncState() {
  const policy$ = state(createDisplayPolicy());
  const selection$ = state<Selection | null>(null);
  const execution$ = state<Execution | null>(null);
  const manual$ = state<ManualRequest | null>(null);
  const modeRequest$ = state<ModeRequest | null>(null);
  const receipt$ = state<DisplayReceipt | null>(null);
  const resetManual$ = resetSignal();
  const resetWork$ = resetSignal();
  return {
    policy$,
    selection$,
    execution$,
    manual$,
    modeRequest$,
    receipt$,
    resetManual$,
    resetWork$,
  };
}

type SyncContext = ReturnType<typeof createSyncState> & {
  readonly client: CdpClient;
  readonly host: DisplaySyncHost;
};

function createSyncSelectors(context: SyncContext) {
  const { selection$, client, host, policy$, receipt$ } = context;
  // Selection identity fences old replies even when the same target is reselected.
  const transaction$ = computed((get) => {
    const selection = get(selection$);
    if (!selection) {
      return null;
    }
    const ownsTarget$ = computed((read) => {
      return read(selection$) === selection;
    });
    return createDisplayTransaction(
      client,
      selection.target,
      host,
      ownsTarget$,
    );
  });

  const state$ = computed((get): DisplayState => {
    const policy = get(policy$);
    const selection = get(selection$);
    return {
      ready: !policy.suspended && !!policy.local && !!selection,
      pending: !!activeDisplayIntent(policy) || canBeginDisplay(policy),
      pointerBlocked: !!selection && !get(selection.target.geometry.available$),
    };
  });
  const recovery$ = computed((get): DisplayRecovery | null => {
    const receipt = get(receipt$);
    const selection = get(selection$);
    const policy = get(policy$);
    return receipt &&
      receipt.selection === selection &&
      !!selection?.target.current() &&
      receipt.intent.revision === policy.revision &&
      receipt.intent.source === "automatic" &&
      !policy.suspended &&
      policy.execution.kind !== "closed" &&
      receipt.result.kind === "failed"
      ? { ...receipt, result: receipt.result }
      : null;
  });
  return { transaction$, state$, recovery$ };
}

function createSyncNotifications(context: SyncContext) {
  const {
    policy$,
    selection$,
    manual$,
    modeRequest$,
    execution$,
    resetManual$,
    resetWork$,
  } = context;
  // A transition that invalidates a caller-awaited request rejects it there.
  const retireRequests$ = command(({ get, set }) => {
    const policy = get(policy$);
    const selection = get(selection$);
    const manual = get(manual$);
    if (
      manual &&
      !manual.done.settled() &&
      (selection !== manual.selection ||
        !manual.selection.target.current() ||
        policy.execution.kind === "closed")
    ) {
      manual.done.reject(cancelled());
    }
    const mode = get(modeRequest$);
    if (mode && !modeRequestCurrent(mode, selection, policy)) {
      set(modeRequest$, null);
      if (!mode.done.settled()) {
        mode.done.reject(cancelled());
      }
    }
  });
  const dispatch$ = command(({ get, set }, event: DisplayEvent): boolean => {
    const previous = get(policy$);
    const next = transitionDisplay(previous, event);
    if (previous === next) {
      return false;
    }
    set(policy$, next);
    set(retireRequests$);
    return true;
  });
  const cancelManual$ = command(({ get, set }) => {
    // Retiring the manual lifetime rejects its request completion.
    set(resetManual$);
    if (get(execution$)?.intent.source === "manual") {
      set(resetWork$);
    }
    set(manual$, null);
    const policy = get(policy$);
    if (
      policy.pending?.source === "manual" ||
      activeDisplayIntent(policy)?.source === "manual"
    ) {
      set(dispatch$, { type: "cancel-manual" });
    }
  });
  return { dispatch$, cancelManual$ };
}

type SyncCommands = SyncContext & ReturnType<typeof createSyncNotifications>;

function createSyncExecutionPolicy(context: SyncCommands) {
  const { policy$, manual$, selection$, dispatch$ } = context;
  // Intent-bound policy hooks are stable commands, never accessor facades.
  const executionPolicy$ = computed((get): ExecutionPolicy | null => {
    const intent = activeDisplayIntent(get(policy$));
    if (!intent) {
      return null;
    }
    const decide$ = command(({ get: read }, windowId: number) => {
      const request = read(manual$);
      const decision = decideDisplay(read(policy$), intent, windowId);
      if (intent.source !== "manual") {
        return decision;
      }
      return request &&
        request.selection === read(selection$) &&
        request.revision === intent.revision &&
        decision?.kind === "fit" &&
        sameSize(decision.size, request.size)
        ? { kind: "fit" as const, size: request.size }
        : null;
    });
    const prepared$ = command(({ set }) => {
      return set(dispatch$, { type: "prepared", intent });
    });
    const stage$ = command(
      ({ set }, stage: Exclude<DisplayStage, "preparing" | "prepared">) => {
        return set(dispatch$, { type: "stage", intent, stage });
      },
    );
    return { decide$, prepared$, stage$ };
  });
  return { executionPolicy$ };
}

function settledDisplayResult(
  operation: PromiseSettledResult<DisplayResult>,
  aborted: boolean,
): DisplayResult {
  return operation.status === "fulfilled"
    ? operation.value
    : aborted || isAbortError(operation.reason)
      ? { kind: "retired" }
      : {
          kind: "failed",
          error:
            operation.reason instanceof CdpFault
              ? operation.reason
              : new CdpFault(
                  "display",
                  "The browser display could not be synchronized. Try again.",
                  undefined,
                  requestDetails(operation.reason),
                ),
        };
}

function createSyncPublication(context: SyncCommands) {
  const { receipt$, host } = context;
  const publishResult$ = command(
    (
      { get, set },
      selection: Selection,
      intent: DisplayIntent,
      result: DisplayResult,
      completed$: Computed<DisplayCompletion | null>,
    ): DisplayReceipt | null => {
      if (result.kind === "deferred") {
        return null;
      }
      const receipt: DisplayReceipt = {
        selection,
        target: selection.target,
        intent,
        result,
        completion: result.kind === "completed" ? get(completed$) : null,
      };
      set(receipt$, receipt);
      if (host.settled$) {
        set(host.settled$);
      }
      return receipt;
    },
  );
  return { publishResult$ };
}

/** Only the published receipt of a request's own intent settles that request. */
function createRequestSettlement(context: SyncCommands & PresentationProof) {
  const { manual$, modeRequest$, matchPresentation$ } = context;
  const settleRequests$ = command(({ get, set }, receipt: DisplayReceipt) => {
    const manual = get(manual$);
    if (
      manual &&
      !manual.done.settled() &&
      receipt.selection === manual.selection &&
      receipt.intent.source === "manual" &&
      receipt.intent.revision === manual.revision
    ) {
      if (receipt.result.kind === "failed") {
        manual.done.reject(receipt.result.error);
      } else {
        const completion = set(matchPresentation$, receipt);
        if (
          completion?.decision.kind === "fit" &&
          sameSize(completion.decision.size, manual.size)
        ) {
          manual.done.resolve();
        } else {
          manual.done.reject(cancelled());
        }
      }
    }
    const mode = get(modeRequest$);
    if (
      mode &&
      !mode.done.settled() &&
      receipt.selection === mode.selection &&
      receipt.intent.source === "mode" &&
      receipt.intent.revision === mode.revision &&
      receipt.intent.mode === mode.mode
    ) {
      if (receipt.result.kind === "failed") {
        mode.done.reject(receipt.result.error);
      } else {
        const completion = set(matchPresentation$, receipt);
        if (completion) {
          mode.done.resolve(completion);
        } else {
          mode.done.reject(cancelled());
        }
      }
    }
  });
  return { settleRequests$ };
}

function createSyncWorker(
  context: SyncCommands &
    ReturnType<typeof createRequestSettlement> &
    ReturnType<typeof createSyncSelectors> &
    ReturnType<typeof createSyncExecutionPolicy> &
    ReturnType<typeof createSyncPublication>,
) {
  const {
    selection$,
    transaction$,
    policy$,
    dispatch$,
    executionPolicy$,
    resetWork$,
    execution$,
    publishResult$,
    settleRequests$,
  } = context;
  const run$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      const selection = get(selection$);
      const transaction = get(transaction$);
      if (
        !selection ||
        !transaction ||
        !selection.target.current() ||
        !canBeginDisplay(get(policy$))
      ) {
        return;
      }
      set(dispatch$, { type: "begin" });
      const intent = activeDisplayIntent(get(policy$));
      const executionPolicy = get(executionPolicy$);
      if (!intent || !executionPolicy) {
        return;
      }
      const workSignal = set(resetWork$, signal);
      const operation = set(transaction.execute$, executionPolicy, workSignal);
      const execution: Execution = { intent, operation };
      set(execution$, execution);
      const [settled] = await Promise.allSettled([operation]);
      if (signal.aborted) {
        if (get(execution$) === execution) {
          set(execution$, null);
        }
        set(dispatch$, {
          type: "finished",
          intent,
          outcome: { kind: "retired" },
        });
        signal.throwIfAborted();
      }
      if (get(execution$) === execution) {
        set(execution$, null);
      }
      const result = settledDisplayResult(settled, workSignal.aborted);
      const accepted = set(dispatch$, {
        type: "finished",
        intent,
        outcome: result,
      });
      const current =
        get(selection$) === selection &&
        selection.target.current() &&
        !signal.aborted &&
        !workSignal.aborted;
      if (current && accepted) {
        const receipt = set(
          publishResult$,
          selection,
          intent,
          result,
          transaction.completed$,
        );
        if (receipt) {
          set(settleRequests$, receipt);
        }
      }
      signal.throwIfAborted();
    },
  );
  return { run$ };
}

/** Automatic work belongs to this graph's CDP client, the resource it writes to. */
function createSyncScheduler(
  context: SyncCommands & ReturnType<typeof createSyncWorker>,
) {
  const { client, selection$, policy$, run$ } = context;
  // Idle requests start immediately; bursts keep 150ms between native writes.
  const throttledRun$ = throttleCommand(run$, minimumSyncIntervalMs);
  const schedule$: Command<void, []> = command(({ get, set }) => {
    const selection = get(selection$);
    if (
      client.signal.aborted ||
      !selection?.target.current() ||
      !canBeginDisplay(get(policy$))
    ) {
      return;
    }
    detach(
      (async () => {
        await set(throttledRun$, client.signal);
        // A deferred outcome keeps its intent pending without a new trigger.
        set(schedule$);
      })(),
      Reason.Daemon,
      "browser display synchronization",
    );
  });
  return { schedule$ };
}

type SyncScheduling = SyncCommands & ReturnType<typeof createSyncScheduler>;

function createSyncDomainCommands(context: SyncScheduling) {
  const {
    selection$,
    cancelManual$,
    resetWork$,
    dispatch$,
    policy$,
    receipt$,
    schedule$,
  } = context;
  const setTarget$ = command(({ get, set }, target: DisplayTarget | null) => {
    const previous = get(selection$);
    if (previous?.target === target || (!previous && !target)) {
      return;
    }
    set(cancelManual$);
    set(resetWork$);
    if (previous) {
      set(previous.target.geometry.suspendPresentation$);
      set(previous.target.geometry.invalidate$);
    }
    set(receipt$, null);
    set(selection$, target ? { target } : null);
    if (target) {
      set(target.geometry.resumePresentation$);
    }
    set(dispatch$, { type: "select", owner: target });
    set(schedule$);
  });

  const applyMode$ = command(
    ({ get, set }, mode: WindowSizeSync, type: "mode" | "request-mode") => {
      if (get(policy$).mode !== mode) {
        set(cancelManual$);
        set(dispatch$, { type, mode });
      }
    },
  );
  const setMode$ = command(({ set }, mode: WindowSizeSync) => {
    set(applyMode$, mode, "mode");
    set(schedule$);
  });

  const measure$ = command(({ get, set }, size: DisplaySize | null) => {
    const previous = get(policy$);
    const next = transitionDisplay(previous, { type: "measure", size });
    if (next === previous) {
      return;
    }
    set(cancelManual$);
    set(dispatch$, { type: "measure", size });
    if (!get(policy$).local) {
      set(resetWork$);
      const selection = get(selection$);
      if (selection) {
        set(selection.target.geometry.suspendPresentation$);
      }
    } else if (!get(policy$).suspended) {
      const selection = get(selection$);
      if (selection) {
        set(selection.target.geometry.resumePresentation$);
      }
    }
    set(schedule$);
  });

  const setSuspended$ = command(({ get, set }, value: boolean) => {
    if (get(policy$).suspended === value) {
      return;
    }
    if (value) {
      set(cancelManual$);
      set(resetWork$);
    }
    const selection = get(selection$);
    if (selection) {
      if (value) {
        set(selection.target.geometry.suspendPresentation$);
      } else if (get(policy$).local) {
        set(selection.target.geometry.resumePresentation$);
      }
    }
    set(dispatch$, { type: "suspend", value });
    set(schedule$);
  });

  const close$ = command(({ get, set }) => {
    set(cancelManual$);
    set(resetWork$);
    const selection = get(selection$);
    if (selection) {
      set(selection.target.geometry.suspendPresentation$);
      set(selection.target.geometry.invalidate$);
    }
    set(selection$, null);
    set(receipt$, null);
    set(dispatch$, { type: "close" });
  });

  // The client lifetime retires the policy; there is no owner loop to stop.
  const start$ = command(({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (get(policy$).execution.kind === "closed") {
      throw cancelled();
    }
    signal.addEventListener(
      "abort",
      () => {
        set(close$);
      },
      { once: true },
    );
    set(schedule$);
  });
  return {
    setTarget$,
    setMode$,
    applyMode$,
    measure$,
    setSuspended$,
    close$,
    start$,
  };
}

function createPresentationProof(context: SyncCommands) {
  const { host } = context;
  const matchPresentation$ = command(
    ({ set }, receipt: DisplayReceipt): DisplayCompletion | null => {
      const { result, completion } = receipt;
      if (
        result.kind !== "completed" ||
        completion?.outcome !== result ||
        completion.windowId !== result.windowId ||
        (host.windowId !== null && completion.windowId !== host.windowId) ||
        !completion.presentation.transform
      ) {
        return null;
      }
      return set(
        receipt.selection.target.geometry.matches$,
        completion.presentation.expected,
        completion.presentation.transform,
      )
        ? completion
        : null;
    },
  );
  return { matchPresentation$ };
}
type PresentationProof = ReturnType<typeof createPresentationProof>;

function createManualSync(context: SyncScheduling) {
  const {
    client,
    selection$,
    policy$,
    cancelManual$,
    resetManual$,
    dispatch$,
    manual$,
    schedule$,
  } = context;
  const syncDisplay$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      const selection = get(selection$);
      const policy = get(policy$);
      if (
        client.signal.aborted ||
        !selection?.target.current() ||
        policy.suspended ||
        !policy.local ||
        policy.execution.kind === "closed"
      ) {
        throw cancelled();
      }
      set(cancelManual$);
      const lifetime = set(resetManual$, signal);
      set(dispatch$, { type: "manual" });
      const request: ManualRequest = {
        selection,
        size: { ...policy.local },
        revision: get(policy$).revision,
        done: createDeferredPromise<void>(lifetime),
      };
      set(manual$, request);
      set(schedule$);
      const [result] = await Promise.allSettled([request.done.promise]);
      if (signal.aborted) {
        if (get(manual$) === request) {
          set(cancelManual$);
          set(schedule$);
        }
        signal.throwIfAborted();
      }
      // Record cancellation before retiring our own mutual-exclusion lifetime.
      const superseded = lifetime.aborted;
      const cancellation = lifetime.reason;
      if (get(manual$) === request) {
        set(cancelManual$);
        set(schedule$);
      }
      if (client.signal.aborted || get(policy$).execution.kind === "closed") {
        throw cancelled();
      }
      if (superseded) {
        throw cancellation;
      }
      if (result.status === "rejected") {
        throw result.reason;
      }
    },
  );
  return { syncDisplay$ };
}

function createModeChange(
  context: SyncScheduling & ReturnType<typeof createSyncDomainCommands>,
) {
  const { client, selection$, policy$, applyMode$, modeRequest$, schedule$ } =
    context;
  const changeMode$ = command(
    async (
      { get, set },
      mode: WindowSizeSync,
      signal: AbortSignal,
    ): Promise<DisplayModeResult> => {
      signal.throwIfAborted();
      const previous = get(policy$);
      if (previous.execution.kind === "closed") {
        throw cancelled();
      }
      const selection = get(selection$);
      const admitted =
        previous.mode !== mode &&
        mode !== "off" &&
        !client.signal.aborted &&
        !!selection?.target.current() &&
        !previous.suspended &&
        !!previous.local;
      set(applyMode$, mode, admitted ? "request-mode" : "mode");
      // These are policy changes, not claims that an unadmitted native write ran.
      if (!admitted || !selection) {
        set(schedule$);
        return { kind: "policy-updated", mode };
      }
      const request: ModeRequest = {
        selection,
        mode,
        revision: get(policy$).revision,
        done: createDeferredPromise<DisplayCompletion>(signal),
      };
      set(modeRequest$, request);
      set(schedule$);
      const [result] = await Promise.allSettled([request.done.promise]);
      if (signal.aborted) {
        if (get(modeRequest$) === request) {
          set(modeRequest$, null);
        }
        signal.throwIfAborted();
      }
      if (get(modeRequest$) === request) {
        set(modeRequest$, null);
      }
      if (result.status === "rejected") {
        throw result.reason;
      }
      return { kind: "synchronized", mode, completion: result.value };
    },
  );
  return { changeMode$ };
}

function createIdleWait(context: SyncCommands) {
  const { execution$, policy$ } = context;
  // Callers suspend first, so only the native write already in flight remains.
  const waitForIdle$ = command(
    async ({ get }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      const execution = get(execution$);
      if (execution) {
        const stopped = createDeferredPromise<void>(signal);
        await Promise.race([
          Promise.allSettled([execution.operation]),
          stopped.promise,
        ]);
        signal.throwIfAborted();
        stopped.resolve();
      }
      if (get(policy$).execution.kind === "closed") {
        throw cancelled();
      }
    },
  );
  return { waitForIdle$ };
}

/** Pure policy plus one throttled worker. Commands start and await their own work. */
export function createDisplaySync(
  client: CdpClient,
  host: DisplaySyncHost,
): DisplaySync {
  const context = { client, host, ...createSyncState() };
  const selectors = createSyncSelectors(context);
  const commands = { ...context, ...createSyncNotifications(context) };
  const proof = createPresentationProof(commands);
  const worker = createSyncWorker({
    ...commands,
    ...createRequestSettlement({ ...commands, ...proof }),
    ...selectors,
    ...createSyncExecutionPolicy(commands),
    ...createSyncPublication(commands),
  });
  const scheduling = {
    ...commands,
    ...createSyncScheduler({ ...commands, ...worker }),
  };
  const domain = createSyncDomainCommands(scheduling);
  return {
    state$: selectors.state$,
    recovery$: selectors.recovery$,
    ...createModeChange({ ...scheduling, ...domain }),
    ...domain,
    ...createManualSync(scheduling),
    ...createIdleWait(commands),
  };
}
