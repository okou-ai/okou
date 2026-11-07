import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import {
  createDeferredPromise,
  isAbortError,
  Reason,
  resetSignal,
  setLoop,
  waitLoopUntil,
  type DeferredPromise,
} from "../utils.ts";
import { monotonicNow } from "../../lib/time.ts";
import { claimBrowserFailure, detachBrowser } from "./reporting.ts";
import {
  captureSentryLogError,
  sentryLogContext,
} from "../../lib/sentry-config.ts";
import type { BrowserConnection } from "./browser.ts";
import { CdpFault } from "./cdp/errors.ts";
import { diagnostic } from "./viewer/diagnostic.ts";
import type { ImageRecovery } from "./viewer/image-recovery.ts";
import type { ViewerError, ViewerSnapshot } from "./viewer/types.ts";

export type BrowserRecoveryResult =
  | { readonly status: "restored" }
  | {
      readonly status: "exhausted" | "terminal";
      readonly error: ViewerError;
    };

function reportFailure(
  result: Exclude<BrowserRecoveryResult, { status: "restored" }>,
) {
  const { error } = result;
  captureSentryLogError("Browser", [
    "Browser viewer recovery stopped",
    new CdpFault(
      error.kind,
      error.message,
      error.request?.code,
      error.request,
      {
        connection: error.connection,
        window: error.window,
      },
    ),
    sentryLogContext({
      tags: { browser_event: "recovery-stopped" },
      contexts: {
        browser_viewer: {
          kind: error.kind,
          transient: error.transient,
          ...(error.connection?.role ? { role: error.connection.role } : {}),
        },
        browser_recovery: { outcome: result.status },
        ...(error.connection
          ? { browser_connection: { ...error.connection } }
          : {}),
        ...(error.bridge ? { browser_bridge: { ...error.bridge } } : {}),
        ...(error.http ? { browser_http: { ...error.http } } : {}),
        ...(error.window ? { browser_window: { ...error.window } } : {}),
      },
    }),
  ]);
}

function finishRecovery(
  completion: DeferredPromise<BrowserRecoveryResult>,
  result: BrowserRecoveryResult,
): void {
  if (completion.settled()) {
    return;
  }
  completion.resolve(result);
  if (result.status !== "restored") {
    reportFailure(result);
  }
}

export interface RecoveryTarget {
  readonly owner: object;
  readonly binding: BrowserConnection;
  readonly targetId: string;
}

export interface RecoveryIntent {
  /** Retained image owner or lifecycle error superseded by this user intent. */
  readonly retiredFailure: object | null;
}

export interface RecoveryView {
  readonly enabled: boolean;
  readonly paused: boolean;
  /** The current descriptor request has not been confirmed by the runtime. */
  readonly pending: boolean;
  readonly nodes: object | null;
  readonly binding: BrowserConnection | null;
  readonly intent: RecoveryIntent;
  readonly targetId: string | null;
  readonly authorized: boolean;
  readonly connected: boolean;
  readonly usable: boolean;
  readonly snapshot: ViewerSnapshot;
  readonly image: ImageRecovery | null;
}

interface RecoveryPorts {
  readonly view$: Computed<RecoveryView>;
  readonly reset$: ReturnType<typeof resetSignal>;
  readonly notification$: State<(() => void) | null>;
  readonly notify$: Command<void, []>;
  readonly restoration$: State<RecoveryTarget | null>;
  /** Attempt completion is not current readiness or window-absence proof. */
  readonly reconnect$: Command<Promise<void>, [AbortSignal]>;
  readonly retryImage$: Command<Promise<void>, [AbortSignal]>;
}

type RecoveryMode = "connection" | "image";
interface Failure {
  readonly view: RecoveryView;
  readonly owner: object;
  readonly error: ViewerError;
  readonly mode: RecoveryMode | null;
}
type RecoveryFence = Pick<RecoveryView, "nodes" | "intent" | "binding">;
interface RecoveryOperation {
  readonly lifetime: object;
  readonly intent: RecoveryIntent;
  readonly nodes: object;
  readonly binding: BrowserConnection | null;
  readonly completion: DeferredPromise<BrowserRecoveryResult>;
}

function cancelled(): DOMException {
  return new DOMException("The browser recovery was cancelled.", "AbortError");
}

/** Legacy connections without order metadata have endpoint-only binding proof. */
export function sameRecoveryBinding(
  left: BrowserConnection,
  right: BrowserConnection,
): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.windowId === right.windowId &&
    (left.instanceId !== null && left.windowId !== null
      ? true
      : left.cdpUrl === right.cdpUrl)
  );
}

function compatibleBinding(
  left: BrowserConnection | null,
  right: BrowserConnection | null,
): boolean {
  // A failed descriptor read can temporarily clear the current connection.
  return !left || !right || sameRecoveryBinding(left, right);
}

function failure(view: RecoveryView): Failure | null {
  const image = view.image;
  if (
    !view.nodes ||
    view.pending ||
    (image &&
      image.phase !== "settling" &&
      image.phase !== "ready" &&
      image.phase !== "blocked")
  ) {
    return null;
  }
  const error = image?.error ?? view.snapshot.error;
  if (!error || view.usable) {
    return null;
  }
  return {
    view,
    owner: image?.owner ?? error,
    error,
    mode: !error.transient
      ? null
      : image
        ? image.phase !== "blocked" && view.authorized && view.connected
          ? "image"
          : null
        : "connection",
  };
}

type RecoveryProgress =
  | { readonly status: "ready" }
  | { readonly status: "pending" }
  | {
      readonly status: "failed";
      readonly error: ViewerError;
      readonly mode: RecoveryMode | null;
    };

function recoveryProgress(view: RecoveryView): RecoveryProgress {
  if (view.usable) {
    return { status: "ready" };
  }
  const current = failure(view);
  if (current) {
    return { status: "failed", error: current.error, mode: current.mode };
  }
  // Runtime confirms a resolved missing descriptor separately from a pending
  // revalidation. Native-attempt completion alone proves neither fact.
  if (!view.pending && view.binding === null) {
    return {
      status: "failed",
      error: diagnostic(
        new CdpFault("scope", "The assigned browser window is unavailable."),
      ),
      mode: null,
    };
  }
  return { status: "pending" };
}

function manualRecoveryMode(
  mode: RecoveryMode,
  automatic: boolean,
  index: number,
): RecoveryMode | null {
  return !automatic && index === 0 ? mode : null;
}

function recoveryMode(
  progress: RecoveryProgress,
  manualMode: RecoveryMode | null,
): RecoveryMode | null {
  return manualMode ?? (progress.status === "failed" ? progress.mode : null);
}

function attemptError(
  result: PromiseSettledResult<void>,
  current: Extract<RecoveryProgress, { status: "failed" }>,
  pending: boolean,
): ViewerError {
  return result.status === "fulfilled" ||
    pending ||
    isAbortError(result.reason) ||
    current.mode === null
    ? current.error
    : diagnostic(result.reason);
}

function sameFailureOwner(
  left: RecoveryFence | null,
  right: RecoveryView,
): boolean {
  return (
    left?.nodes === right.nodes &&
    left.intent === right.intent &&
    compatibleBinding(left.binding, right.binding)
  );
}

function createRecoveryState() {
  const lifetime$ = state<object | null>(null);
  const active$ = state<RecoveryOperation | null>(null);
  const stopped$ = state<RecoveryFence | null>(null);
  const result$ = state<Promise<BrowserRecoveryResult> | null>(null);
  const progress$ = state<DeferredPromise<void> | null>(null);
  return { lifetime$, active$, stopped$, result$, progress$ };
}
type RecoveryState = ReturnType<typeof createRecoveryState>;

function waitForRetry(interval: number, signal: AbortSignal): Promise<void> {
  const startAfter = monotonicNow() + interval;
  return waitLoopUntil(
    () => {
      return monotonicNow() >= startAfter;
    },
    1000,
    signal,
    { testIntervalMs: 10 },
  );
}

function createRecoveryAssertion(ports: RecoveryPorts, graph: RecoveryState) {
  return command(
    ({ get }, operation: RecoveryOperation, signal: AbortSignal) => {
      signal.throwIfAborted();
      const view = get(ports.view$);
      if (
        get(graph.active$) !== operation ||
        get(graph.lifetime$) !== operation.lifetime ||
        view.intent !== operation.intent ||
        view.nodes !== operation.nodes ||
        view.paused ||
        !view.enabled ||
        !compatibleBinding(operation.binding, view.binding)
      ) {
        throw cancelled();
      }
    },
  );
}

function createRecoveryProgressWait(
  ports: RecoveryPorts,
  graph: RecoveryState,
) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const notification = createDeferredPromise<void>(
      { rejection: "owner" },
      signal,
    );
    set(graph.progress$, notification);
    using _notification = {
      [Symbol.dispose]: () => {
        if (get(graph.progress$) === notification) {
          set(graph.progress$, null);
        }
      },
    };
    // Registration precedes the read; the caller rechecks after every wake.
    if (recoveryProgress(get(ports.view$)).status !== "pending") {
      notification.resolve();
    }
    await notification.promise;
    signal.throwIfAborted();
  });
}

function createRecoveryRelease(ports: RecoveryPorts, graph: RecoveryState) {
  return command(({ get, set }, operation: RecoveryOperation) => {
    if (!operation.completion.settled()) {
      operation.completion.reject(cancelled());
    }
    if (get(graph.active$) !== operation) {
      return;
    }
    set(graph.active$, null);
    if (get(ports.restoration$)?.owner === operation) {
      set(ports.restoration$, null);
    }
    const view = get(ports.view$);
    if (
      get(graph.lifetime$) === operation.lifetime &&
      view.intent === operation.intent &&
      view.nodes === operation.nodes &&
      compatibleBinding(operation.binding, view.binding)
    ) {
      // A pending descriptor or late timeout is still this spent owner.
      set(
        graph.stopped$,
        view.usable
          ? null
          : {
              nodes: operation.nodes,
              intent: operation.intent,
              binding: operation.binding ?? view.binding,
            },
      );
    }
    set(ports.notify$);
  });
}

function createRecoveryExecution(ports: RecoveryPorts, graph: RecoveryState) {
  const assertCurrent$ = createRecoveryAssertion(ports, graph);
  const waitForProgress$ = createRecoveryProgressWait(ports, graph);
  const release$ = createRecoveryRelease(ports, graph);
  return command(
    async (
      { get, set },
      operation: RecoveryOperation,
      initialMode: RecoveryMode,
      automatic: boolean,
      signal: AbortSignal,
    ): Promise<void> => {
      const { completion } = operation;
      let lastError =
        failure(get(ports.view$))?.error ??
        diagnostic(
          new CdpFault("connection", "The browser could not recover."),
        );
      using _operation = {
        [Symbol.dispose]: () => {
          set(release$, operation);
        },
      };
      const deadline = monotonicNow() + 180_000;
      setLoop(
        () => {
          if (completion.settled()) {
            return true;
          }
          if (monotonicNow() < deadline) {
            return false;
          }
          finishRecovery(completion, { status: "exhausted", error: lastError });
          set(ports.reset$, AbortSignal.abort(cancelled()));
          return true;
        },
        1000,
        signal,
        { testIntervalMs: 10 },
      );
      for (const [index, interval] of [1000, 2000, 4000].entries()) {
        set(assertCurrent$, operation, signal);
        if (automatic || index > 0) {
          await waitForRetry(interval, signal);
        }
        set(assertCurrent$, operation, signal);
        const manualMode = manualRecoveryMode(initialMode, automatic, index);
        let progress = recoveryProgress(get(ports.view$));
        while (progress.status === "pending" && manualMode === null) {
          await set(waitForProgress$, signal);
          set(assertCurrent$, operation, signal);
          progress = recoveryProgress(get(ports.view$));
        }
        if (progress.status === "ready") {
          finishRecovery(completion, { status: "restored" });
          return;
        }
        if (progress.status === "failed") {
          lastError = progress.error;
        }
        const mode = recoveryMode(progress, manualMode);
        if (!mode) {
          finishRecovery(completion, { status: "terminal", error: lastError });
          return;
        }
        const [result] = await Promise.allSettled([
          set(mode === "image" ? ports.retryImage$ : ports.reconnect$, signal),
        ]);
        signal.throwIfAborted();
        set(assertCurrent$, operation, signal);
        let afterAttempt = recoveryProgress(get(ports.view$));
        const pendingAfterAttempt = afterAttempt.status === "pending";
        // Success or cancellation ends one native attempt, not a still-current
        // logical episode whose compatible resources are becoming ready.
        while (afterAttempt.status === "pending") {
          await set(waitForProgress$, signal);
          set(assertCurrent$, operation, signal);
          afterAttempt = recoveryProgress(get(ports.view$));
        }
        if (afterAttempt.status === "ready") {
          finishRecovery(completion, { status: "restored" });
          return;
        }
        lastError = attemptError(result, afterAttempt, pendingAfterAttempt);
        if (!lastError.transient || afterAttempt.mode === null) {
          finishRecovery(completion, { status: "terminal", error: lastError });
          return;
        }
      }
      finishRecovery(completion, { status: "exhausted", error: lastError });
    },
  );
}

function createRecoveryStart(
  ports: RecoveryPorts,
  graph: RecoveryState,
  execute$: ReturnType<typeof createRecoveryExecution>,
) {
  return command(
    (
      { get, set },
      mode: RecoveryMode,
      automatic: boolean,
      signal: AbortSignal,
    ): RecoveryOperation => {
      signal.throwIfAborted();
      const active = get(graph.active$);
      if (active) {
        return active;
      }
      const view = get(ports.view$);
      const lifetime = get(graph.lifetime$);
      if (!lifetime || !view.nodes || view.paused) {
        throw cancelled();
      }
      const scope = set(ports.reset$, signal);
      const operation: RecoveryOperation = {
        lifetime,
        intent: view.intent,
        nodes: view.nodes,
        binding: view.binding,
        completion: createDeferredPromise<BrowserRecoveryResult>(
          { rejection: "owner" },
          scope,
        ),
      };
      set(graph.active$, operation);
      set(graph.result$, operation.completion.promise);
      if (view.binding && view.targetId) {
        set(ports.restoration$, {
          owner: operation,
          binding: view.binding,
          targetId: view.targetId,
        });
      }
      // The operation owns its result; native receipt cleanup may outlive cancellation.
      detachBrowser(
        set(execute$, operation, mode, automatic, scope),
        Reason.Daemon,
        "browser resource recovery",
      );
      return operation;
    },
  );
}

function createManualRecovery(
  ports: RecoveryPorts,
  graph: RecoveryState,
  start$: ReturnType<typeof createRecoveryStart>,
) {
  const join$ = command(
    async (_, operation: RecoveryOperation, signal: AbortSignal) => {
      signal.throwIfAborted();
      const interrupted = createDeferredPromise<never>(
        { rejection: "owner" },
        signal,
      );
      using _interrupted = {
        [Symbol.dispose]() {
          if (!interrupted.settled()) {
            interrupted.reject(cancelled());
          }
        },
      };
      const result = await Promise.race([
        operation.completion.promise,
        interrupted.promise,
      ]);
      signal.throwIfAborted();
      if (result.status !== "restored") {
        const fault = new CdpFault(result.error.kind, result.error.message);
        claimBrowserFailure(fault);
        throw fault;
      }
    },
  );
  const manual$ = command(
    async ({ get, set }, mode: RecoveryMode, signal: AbortSignal) => {
      signal.throwIfAborted();
      const active = get(graph.active$);
      if (active) {
        await set(join$, active, signal);
        return;
      }
      if (!get(ports.view$).enabled) {
        await set(
          mode === "image" ? ports.retryImage$ : ports.reconnect$,
          signal,
        );
        return;
      }
      const operation = set(start$, mode, false, signal);
      await set(join$, operation, signal);
    },
  );
  return {
    reconnect$: command(({ set }, signal: AbortSignal) => {
      return set(manual$, "connection", signal);
    }),
    retryImage$: command(({ set }, signal: AbortSignal) => {
      return set(manual$, "image", signal);
    }),
  };
}

function createRecoveryObservation(
  ports: RecoveryPorts,
  graph: RecoveryState,
  start$: ReturnType<typeof createRecoveryStart>,
) {
  return command(
    ({ get, set }, paused: boolean, signal: AbortSignal): boolean => {
      signal.throwIfAborted();
      const view = get(ports.view$);
      const active = get(graph.active$);
      if (
        active &&
        (view.paused ||
          !view.enabled ||
          active.intent !== view.intent ||
          active.nodes !== view.nodes ||
          !compatibleBinding(active.binding, view.binding))
      ) {
        set(ports.reset$, AbortSignal.abort(cancelled()));
      }
      if (paused && !view.paused) {
        set(graph.stopped$, null);
      }
      const current = failure(view);
      if (!active && view.usable && get(graph.stopped$)) {
        set(graph.stopped$, null);
        set(graph.result$, Promise.resolve({ status: "restored" }));
      }
      if (
        !active &&
        view.enabled &&
        !view.paused &&
        current &&
        current.owner !== view.intent.retiredFailure &&
        !sameFailureOwner(get(graph.stopped$), current.view)
      ) {
        if (current.mode) {
          set(start$, current.mode, true, signal);
        } else {
          set(graph.stopped$, current.view);
          set(
            graph.result$,
            Promise.resolve({ status: "terminal", error: current.error }),
          );
          reportFailure({ status: "terminal", error: current.error });
        }
      }
      return view.paused;
    },
  );
}

function createRecoveryWatch(
  ports: RecoveryPorts,
  graph: RecoveryState,
  start$: ReturnType<typeof createRecoveryStart>,
) {
  const observe$ = createRecoveryObservation(ports, graph, start$);
  return command(async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const lifetime = {};
    set(graph.lifetime$, lifetime);
    signal.addEventListener(
      "abort",
      () => {
        if (get(graph.lifetime$) === lifetime) {
          set(graph.lifetime$, null);
          set(ports.reset$, AbortSignal.abort(cancelled()));
          set(ports.restoration$, null);
        }
      },
      { once: true },
    );
    let paused = get(ports.view$).paused;
    while (!signal.aborted) {
      const notification = createDeferredPromise<void>(
        { rejection: "owner" },
        signal,
      );
      const changed = () => {
        if (signal.aborted) {
          return;
        }
        // Publish the operation in the failure's own event, before React can
        // show a final error. The existing watch still owns cancellation.
        paused = set(observe$, paused, signal);
        const progress = get(graph.progress$);
        if (progress && !progress.settled()) {
          progress.resolve();
        }
        if (!notification.settled()) {
          notification.resolve();
        }
      };
      set(ports.notification$, () => {
        return changed;
      });
      using _notification = {
        [Symbol.dispose]: () => {
          if (get(ports.notification$) === changed) {
            set(ports.notification$, null);
          }
        },
      };
      paused = set(observe$, paused, signal);
      await notification.promise;
      signal.throwIfAborted();
    }
  });
}

/** One mounted owner serializes resource recovery; UI reads its actual operation. */
export function createViewerRecovery(ports: RecoveryPorts) {
  const graph = createRecoveryState();
  const execute$ = createRecoveryExecution(ports, graph);
  const start$ = createRecoveryStart(ports, graph, execute$);
  return {
    ...createManualRecovery(ports, graph, start$),
    watch$: createRecoveryWatch(ports, graph, start$),
    operation$: computed((get) => {
      return get(ports.view$).enabled ? get(graph.result$) : null;
    }),
  };
}
