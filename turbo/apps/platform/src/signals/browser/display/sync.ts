import { command, computed, state, type Command, type Computed } from "ccstate";
import {
  createDeferredPromise,
  isAbortError,
  resetSignal,
  scheduleTimeout,
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
  readonly start$: Command<Promise<void>, [AbortSignal]>;
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

/** Native owner-abort event, not a cached UI operation or stored signal. */
interface Owner {
  readonly ended: DeferredPromise<never>;
}

interface ManualRequest {
  readonly selection: Selection;
  readonly size: DisplaySize;
  readonly revision: number;
}

type Worker =
  | { readonly kind: "idle" }
  | { readonly kind: "scheduled"; readonly selection: Selection }
  | {
      readonly kind: "executing";
      readonly selection: Selection;
      readonly intent: DisplayIntent;
    };

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

function createSyncState() {
  const policy$ = state(createDisplayPolicy());
  const selection$ = state<Selection | null>(null);
  const worker$ = state<Worker>({ kind: "idle" });
  const started$ = state(-Infinity);
  const owner$ = state<Owner | null>(null);
  const manual$ = state<ManualRequest | null>(null);
  const receipt$ = state<DisplayReceipt | null>(null);
  // Deferreds adapt policy notifications, not operation/loading Promise slots.
  const waiters$ = state<ReadonlySet<DeferredPromise<void>>>(new Set());
  const resetOwner$ = resetSignal();
  const resetManual$ = resetSignal();
  const resetWork$ = resetSignal();
  return {
    policy$,
    selection$,
    worker$,
    started$,
    owner$,
    manual$,
    receipt$,
    waiters$,
    resetOwner$,
    resetManual$,
    resetWork$,
  };
}

type SyncContext = ReturnType<typeof createSyncState> & {
  readonly client: CdpClient;
  readonly host: DisplaySyncHost;
};

function createSyncSelectors(context: SyncContext) {
  const { selection$, client, host, policy$, worker$, receipt$ } = context;
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
      pending:
        !!activeDisplayIntent(policy) ||
        (get(worker$).kind === "scheduled" && !!policy.pending) ||
        canBeginDisplay(policy),
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
  const { waiters$, policy$, resetManual$, worker$, resetWork$, manual$ } =
    context;
  const wake$ = command(({ get }) => {
    for (const waiter of get(waiters$)) {
      if (!waiter.settled()) {
        waiter.resolve();
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
    set(wake$);
    return true;
  });

  const waitForChange$ = command(
    async (
      { get, set },
      owner: Owner | null,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      const event = createDeferredPromise<void>(signal);
      set(waiters$, new Set([...get(waiters$), event]));
      const [result] = await Promise.allSettled([
        owner
          ? Promise.race([event.promise, owner.ended.promise])
          : event.promise,
      ]);
      if (signal.aborted) {
        const remaining = new Set(get(waiters$));
        remaining.delete(event);
        set(waiters$, remaining);
        signal.throwIfAborted();
      }
      const remaining = new Set(get(waiters$));
      remaining.delete(event);
      set(waiters$, remaining);
      if (!event.settled()) {
        event.resolve();
      }
      if (result.status === "rejected") {
        throw result.reason;
      }
    },
  );

  const cancelManual$ = command(({ get, set }) => {
    set(resetManual$);
    const worker = get(worker$);
    if (worker.kind === "executing" && worker.intent.source === "manual") {
      set(resetWork$);
    }
    set(manual$, null);
    if (
      get(policy$).pending?.source === "manual" ||
      activeDisplayIntent(get(policy$))?.source === "manual"
    ) {
      set(dispatch$, { type: "cancel-manual" });
    }
    set(wake$);
  });
  return { wake$, dispatch$, waitForChange$, cancelManual$ };
}

type SyncCommands = SyncContext & ReturnType<typeof createSyncNotifications>;

function createSyncDomainCommands(context: SyncCommands) {
  const {
    selection$,
    cancelManual$,
    resetWork$,
    dispatch$,
    wake$,
    policy$,
    resetOwner$,
    receipt$,
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
    set(wake$);
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
  });

  const close$ = command(({ get, set }) => {
    set(cancelManual$);
    set(resetOwner$);
    set(resetWork$);
    const selection = get(selection$);
    if (selection) {
      set(selection.target.geometry.suspendPresentation$);
      set(selection.target.geometry.invalidate$);
    }
    set(selection$, null);
    set(receipt$, null);
    set(dispatch$, { type: "close" });
    set(wake$);
  });
  return { setTarget$, setMode$, applyMode$, measure$, setSuspended$, close$ };
}

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
    ) => {
      if (result.kind === "deferred") {
        return;
      }
      set(receipt$, {
        selection,
        target: selection.target,
        intent,
        result,
        completion: result.kind === "completed" ? get(completed$) : null,
      });
      if (host.settled$) {
        set(host.settled$);
      }
    },
  );
  return { publishResult$ };
}

function createSyncWorker(
  context: SyncCommands &
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
    worker$,
    started$,
    wake$,
    publishResult$,
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
      set(worker$, { kind: "executing", selection, intent });
      set(started$, performance.now());
      set(wake$);
      const [operation] = await Promise.allSettled([
        set(transaction.execute$, executionPolicy, workSignal),
      ]);
      if (signal.aborted) {
        set(dispatch$, {
          type: "finished",
          intent,
          outcome: { kind: "retired" },
        });
        set(worker$, { kind: "idle" });
        set(wake$);
        signal.throwIfAborted();
      }
      const result = settledDisplayResult(operation, workSignal.aborted);
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
        set(publishResult$, selection, intent, result, transaction.completed$);
      }
      set(worker$, { kind: "idle" });
      set(wake$);
      signal.throwIfAborted();
    },
  );
  return { run$ };
}

function createSyncScheduler(
  context: SyncCommands & ReturnType<typeof createSyncWorker>,
) {
  const {
    started$,
    selection$,
    policy$,
    worker$,
    wake$,
    run$,
    waitForChange$,
  } = context;
  const waitForSchedule$ = command(
    async ({ get }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      const deadline = createDeferredPromise<void>(signal);
      const cancelDeadline = scheduleTimeout(
        () => {
          if (!deadline.settled()) {
            deadline.resolve();
          }
        },
        Math.max(
          0,
          minimumSyncIntervalMs - (performance.now() - get(started$)),
        ),
        signal,
      );
      const [result] = await Promise.allSettled([deadline.promise]);
      if (signal.aborted) {
        cancelDeadline();
        signal.throwIfAborted();
      }
      cancelDeadline();
      if (result.status === "rejected") {
        throw result.reason;
      }
    },
  );

  const daemon$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      // This loop waits for explicit domain events or a single admitted throttle
      // deadline; it does not poll. Only this owner daemon starts automatic work.
      while (!signal.aborted) {
        const selection = get(selection$);
        if (selection?.target.current() && canBeginDisplay(get(policy$))) {
          set(worker$, { kind: "scheduled", selection });
          set(wake$);
          await set(waitForSchedule$, signal);
          set(worker$, { kind: "idle" });
          await set(run$, signal);
        } else {
          await set(waitForChange$, null, signal);
        }
      }
      signal.throwIfAborted();
    },
  );
  return { daemon$ };
}

function createSyncOwner(
  context: SyncCommands &
    ReturnType<typeof createSyncDomainCommands> &
    ReturnType<typeof createSyncScheduler>,
) {
  const { owner$, close$, worker$, wake$, policy$, resetOwner$, daemon$ } =
    context;
  const finishOwner$ = command(({ get, set }, owner: Owner) => {
    if (get(owner$) === owner) {
      set(close$);
      set(owner$, null);
      set(worker$, { kind: "idle" });
      set(wake$);
    }
  });

  const start$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      if (get(policy$).execution.kind === "closed") {
        throw cancelled();
      }
      if (get(owner$)) {
        throw new Error(
          "The browser display policy owner is already installed.",
        );
      }
      const lifetime = set(resetOwner$, signal);
      const owner: Owner = { ended: createDeferredPromise<never>(lifetime) };
      set(owner$, owner);
      set(wake$);
      const [result] = await Promise.allSettled([set(daemon$, lifetime)]);
      if (signal.aborted) {
        set(finishOwner$, owner);
        signal.throwIfAborted();
      }
      const stopped = lifetime.aborted;
      const reason = lifetime.reason;
      set(finishOwner$, owner);
      if (stopped) {
        throw reason;
      }
      if (result.status === "rejected") {
        throw result.reason;
      }
    },
  );
  return { start$ };
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

function createManualCompletionWait(context: SyncCommands & PresentationProof) {
  const {
    manual$,
    owner$,
    selection$,
    receipt$,
    waitForChange$,
    matchPresentation$,
  } = context;
  const waitForManual$ = command(
    async (
      { get, set },
      request: ManualRequest,
      owner: Owner,
      signal: AbortSignal,
    ): Promise<void> => {
      while (!signal.aborted) {
        if (
          get(manual$) !== request ||
          get(owner$) !== owner ||
          owner.ended.settled() ||
          get(selection$) !== request.selection ||
          !request.selection.target.current()
        ) {
          throw cancelled();
        }
        const receipt = get(receipt$);
        if (
          receipt?.selection === request.selection &&
          receipt.intent.source === "manual" &&
          receipt.intent.revision === request.revision
        ) {
          if (receipt.result.kind === "failed") {
            throw receipt.result.error;
          }
          const completion = set(matchPresentation$, receipt);
          if (
            completion?.decision.kind === "fit" &&
            sameSize(completion.decision.size, request.size)
          ) {
            return;
          }
          throw cancelled();
        }
        await set(waitForChange$, owner, signal);
      }
      signal.throwIfAborted();
    },
  );
  return { waitForManual$ };
}

function createManualSync(
  context: SyncCommands & ReturnType<typeof createManualCompletionWait>,
) {
  const {
    owner$,
    selection$,
    policy$,
    cancelManual$,
    resetManual$,
    dispatch$,
    manual$,
    wake$,
    waitForManual$,
  } = context;
  const syncDisplay$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      const owner = get(owner$);
      const selection = get(selection$);
      const policy = get(policy$);
      if (
        !owner ||
        owner.ended.settled() ||
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
      };
      set(manual$, request);
      set(wake$);
      const [result] = await Promise.allSettled([
        set(waitForManual$, request, owner, lifetime),
      ]);
      if (signal.aborted) {
        if (get(manual$) === request) {
          set(cancelManual$);
        }
        signal.throwIfAborted();
      }
      // Record cancellation before retiring our own mutual-exclusion lifetime.
      const superseded = lifetime.aborted;
      const cancellation = lifetime.reason;
      if (get(manual$) === request) {
        set(cancelManual$);
      }
      if (owner.ended.settled() || get(owner$) !== owner) {
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

interface ModeRequest {
  readonly selection: Selection;
  readonly revision: number;
  readonly mode: WindowSizeSync;
}

function createModeCompletionWait(context: SyncCommands & PresentationProof) {
  const {
    owner$,
    selection$,
    policy$,
    receipt$,
    waitForChange$,
    matchPresentation$,
  } = context;
  const waitForMode$ = command(
    async (
      { get, set },
      request: ModeRequest,
      owner: Owner,
      signal: AbortSignal,
    ): Promise<DisplayCompletion> => {
      while (!signal.aborted) {
        const policy = get(policy$);
        if (
          get(owner$) !== owner ||
          owner.ended.settled() ||
          get(selection$) !== request.selection ||
          !request.selection.target.current() ||
          policy.revision !== request.revision ||
          policy.mode !== request.mode ||
          policy.suspended ||
          !policy.local ||
          policy.execution.kind === "closed"
        ) {
          throw cancelled();
        }
        const receipt = get(receipt$);
        if (
          receipt?.selection === request.selection &&
          receipt.intent.source === "mode" &&
          receipt.intent.revision === request.revision &&
          receipt.intent.mode === request.mode
        ) {
          if (receipt.result.kind === "failed") {
            throw receipt.result.error;
          }
          const completion = set(matchPresentation$, receipt);
          if (completion) {
            return completion;
          }
          throw cancelled();
        }
        await set(waitForChange$, owner, signal);
      }
      signal.throwIfAborted();
      throw cancelled();
    },
  );
  return { waitForMode$ };
}

function createModeChange(
  context: SyncCommands &
    ReturnType<typeof createSyncDomainCommands> &
    PresentationProof,
) {
  const { owner$, selection$, policy$, applyMode$ } = context;
  const { waitForMode$ } = createModeCompletionWait(context);
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
      const owner = get(owner$);
      const selection = get(selection$);
      const admitted =
        previous.mode !== mode &&
        mode !== "off" &&
        !!owner &&
        !owner.ended.settled() &&
        !!selection?.target.current() &&
        !previous.suspended &&
        !!previous.local;
      set(applyMode$, mode, admitted ? "request-mode" : "mode");
      // These are policy changes, not claims that an unadmitted native write ran.
      if (!admitted || !owner || !selection) {
        return { kind: "policy-updated", mode };
      }
      const policy = get(policy$);
      const completion = await set(
        waitForMode$,
        { selection, mode, revision: policy.revision },
        owner,
        signal,
      );
      signal.throwIfAborted();
      return { kind: "synchronized", mode, completion };
    },
  );
  return { changeMode$ };
}

function createIdleWait(context: SyncCommands) {
  const { owner$, policy$, worker$, selection$, waitForChange$ } = context;
  const waitForIdle$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      const owner = get(owner$);
      if (!owner || owner.ended.settled()) {
        if (get(policy$).execution.kind === "closed") {
          throw cancelled();
        }
        if (get(worker$).kind !== "idle" || canBeginDisplay(get(policy$))) {
          throw cancelled();
        }
        return;
      }
      while (!signal.aborted) {
        if (get(owner$) !== owner || owner.ended.settled()) {
          throw cancelled();
        }
        const selection = get(selection$);
        const scheduled =
          !!selection?.target.current() && canBeginDisplay(get(policy$));
        if (
          get(worker$).kind === "idle" &&
          !activeDisplayIntent(get(policy$)) &&
          !scheduled
        ) {
          return;
        }
        await set(waitForChange$, owner, signal);
      }
      signal.throwIfAborted();
    },
  );
  return { waitForIdle$ };
}

/** Pure policy plus one owner-awaited worker. Finite actions only await facts. */
export function createDisplaySync(
  client: CdpClient,
  host: DisplaySyncHost,
): DisplaySync {
  const context = { client, host, ...createSyncState() };
  const selectors = createSyncSelectors(context);
  const commands = { ...context, ...createSyncNotifications(context) };
  const proof = createPresentationProof(commands);
  const domain = createSyncDomainCommands(commands);
  const executionPolicy = createSyncExecutionPolicy(commands);
  const worker = createSyncWorker({
    ...commands,
    ...selectors,
    ...executionPolicy,
    ...createSyncPublication(commands),
  });
  const scheduler = createSyncScheduler({ ...commands, ...worker });
  const owner = createSyncOwner({ ...commands, ...domain, ...scheduler });
  const manual = createManualSync({
    ...commands,
    ...createManualCompletionWait({ ...commands, ...proof }),
  });
  return {
    state$: selectors.state$,
    recovery$: selectors.recovery$,
    ...createModeChange({ ...commands, ...domain, ...proof }),
    ...owner,
    ...domain,
    ...manual,
    ...createIdleWait(commands),
  };
}
