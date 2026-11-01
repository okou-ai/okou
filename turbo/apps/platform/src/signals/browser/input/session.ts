import { command, computed, state, type Command, type Computed } from "ccstate";
import type { Protocol } from "devtools-protocol";
import { detach, Reason, resetSignal } from "../../utils.ts";
import type { CdpClient, CdpEvent } from "../cdp/client.ts";
import { CdpFault, isRecord, requestDetails } from "../cdp/errors.ts";
import type { NavigationAction, NavigationReceipt } from "../viewer/types.ts";
import type { DisplayViewport } from "../display/viewport.ts";
import type { NavigationData } from "../navigation/data.ts";
import type { EditingObservation, NativeInputHost } from "./port.ts";
import { createEditingReader, type EditingTarget } from "./editing.ts";
import type { InputGeometry, Point } from "../display/geometry.ts";
import { navigationAddress } from "./address.ts";
import { createInputEffects } from "./effects.ts";
import {
  createInputLifecycle,
  type InputOwner,
  type InputStop,
  type InputTransition,
} from "./lifecycle.ts";
import { createInputQueue, type InputJob } from "./queue.ts";
import { createSelectionReader, type SelectionResult } from "./selection.ts";

type Mouse = Protocol.Input.DispatchMouseEventRequest;
type Key = Protocol.Input.DispatchKeyEventRequest;
type PointerDetails = Pick<
  Mouse,
  "button" | "buttons" | "clickCount" | "modifiers" | "deltaX" | "deltaY"
>;
interface PointerJob {
  readonly type: Mouse["type"];
  readonly point: Point;
  readonly details: PointerDetails;
}

interface CompositionLease {
  readonly token: object;
  readonly owner: InputOwner;
}

interface SessionConnection {
  readonly client: CdpClient;
  readonly sessionId: string;
}

function createSessionState(
  connection: SessionConnection,
  isCurrent$: Computed<boolean>,
  geometry: DisplayViewport,
  nativeHost: NativeInputHost,
  navigation: NavigationData,
) {
  const { client, sessionId } = connection;
  const lifecycle = createInputLifecycle(sessionId);
  const effects = createInputEffects(client, sessionId);
  const lifetime$ = state<object | null>(null);
  const resetScope$ = resetSignal();
  const retiring$ = state(false);
  const navigationGate$ = state<object | null>(null);
  const internalError$ = state<CdpFault | null>(null);
  const internalCaret$ = state<Point | null>(null);
  const internalEditing$ = state<EditingObservation>({
    kind: "unknown",
    target: null,
  });
  const compositionLease$ = state<CompositionLease | null>(null);
  const compositionTargets$ = state<ReadonlyMap<object, EditingTarget | null>>(
    new Map(),
  );
  const internalTransition$ = state<{
    id: number;
    reason: InputTransition;
  } | null>(null);
  const clipboardVersion$ = state(0);
  const frameId$ = state<string | null>(null);
  const contextId$ = state<number | null>(null);
  const preeditSupported$ = state(true);
  const caretJob$ = state<InputJob | null>(null);
  const caretReading$ = state(false);
  const caretVersion$ = state(0);
  const available$ = computed((get) => {
    return get(lifecycle.available$);
  });
  const accepting$ = computed((get) => {
    return (
      get(available$) &&
      !get(retiring$) &&
      !get(navigationGate$) &&
      get(isCurrent$) &&
      get(lifetime$) !== null
    );
  });
  const owner$ = computed((get) => {
    return get(accepting$) ? get(lifecycle.owner$) : null;
  });
  const error$ = computed((get) => {
    return get(internalError$);
  });
  const caret$ = computed((get) => {
    return get(internalCaret$);
  });
  const editing$ = computed((get) => {
    return get(internalEditing$);
  });
  const transition$ = computed((get) => {
    return get(internalTransition$);
  });
  const clipboardEpoch$ = computed((get) => {
    return get(clipboardVersion$);
  });

  return {
    client,
    sessionId,
    isCurrent$,
    geometry,
    nativeHost,
    navigation,
    lifecycle,
    effects,
    lifetime$,
    resetScope$,
    retiring$,
    navigationGate$,
    internalError$,
    internalCaret$,
    internalEditing$,
    compositionLease$,
    compositionTargets$,
    internalTransition$,
    clipboardVersion$,
    frameId$,
    contextId$,
    preeditSupported$,
    caretJob$,
    caretReading$,
    caretVersion$,
    available$,
    accepting$,
    owner$,
    error$,
    caret$,
    editing$,
    transition$,
    clipboardEpoch$,
  };
}
type SessionBase = ReturnType<typeof createSessionState> & {
  queue: ReturnType<typeof createInputQueue>;
  selectionReader: ReturnType<typeof createSelectionReader>;
  editingReader: ReturnType<typeof createEditingReader>;
};
type SessionObservations = SessionBase &
  ReturnType<typeof createSessionInvalidation> &
  ReturnType<typeof createCaretObservation>;
type SessionActions = SessionObservations &
  ReturnType<typeof createSessionTransitions>;

function createSessionInvalidation(graph: SessionBase) {
  const {
    caretJob$,
    caretVersion$,
    clipboardVersion$,
    effects,
    internalCaret$,
    internalEditing$,
    nativeHost,
  } = graph;
  const invalidateClipboard$ = command(({ set }) => {
    set(clipboardVersion$, (value) => {
      return value + 1;
    });
    set(nativeHost.synchronize$);
  });
  const invalidateCaret$ = command(({ set }, notify = true) => {
    set(caretVersion$, (value) => {
      return value + 1;
    });
    set(caretJob$, null);
    set(internalCaret$, null);
    set(internalEditing$, { kind: "unknown", target: null });
    if (notify) {
      set(nativeHost.synchronize$);
    }
  });
  const cancelComposition$ = command(({ set }, target: EditingTarget) => {
    set(effects.notify$, {
      target,
      method: "Input.imeSetComposition",
      params: { text: "", selectionStart: 0, selectionEnd: 0 },
    });
  });
  return { invalidateClipboard$, invalidateCaret$, cancelComposition$ };
}

function createCaretObservation(
  graph: SessionBase & ReturnType<typeof createSessionInvalidation>,
) {
  const {
    available$,
    caretJob$,
    caretReading$,
    caretVersion$,
    internalCaret$,
    internalEditing$,
    lifecycle,
  } = graph;
  const readCaret$ = graph.editingReader.read$;
  const drainCaret$ = command(async ({ get, set }, signal: AbortSignal) => {
    if (get(caretReading$)) {
      return;
    }
    set(caretReading$, true);
    using _caret = {
      [Symbol.dispose]: () => {
        set(caretReading$, false);
      },
    };
    while (get(caretJob$) && get(available$)) {
      const job = get(caretJob$)!;
      const version = get(caretVersion$);
      set(caretJob$, null);
      const [result] = await Promise.allSettled([set(readCaret$, job, signal)]);
      signal.throwIfAborted();
      if (version === get(caretVersion$) && set(lifecycle.owns$, job.owner)) {
        const observation = result.status === "fulfilled" ? result.value : null;
        set(internalCaret$, observation?.caret ?? null);
        set(
          internalEditing$,
          observation?.editing ?? { kind: "unknown", target: null },
        );
        set(graph.nativeHost.synchronize$);
      }
    }
  });
  const refreshCaret$ = command(({ get, set }, job: InputJob) => {
    set(caretVersion$, (value) => {
      return value + 1;
    });
    set(caretJob$, job);
    if (!get(caretReading$)) {
      detach(
        set(drainCaret$, graph.client.signal),
        Reason.DomCallback,
        "browser caret observation",
      );
    }
  });

  return { refreshCaret$ };
}

function createSessionTransitions(graph: SessionObservations) {
  const {
    cancelComposition$,
    clipboardVersion$,
    effects,
    editingReader,
    geometry,
    nativeHost,
    internalError$,
    internalTransition$,
    invalidateCaret$,
    lifecycle,
    queue,
  } = graph;
  const transitionInput$: Command<InputOwner | null, [InputTransition]> =
    command(({ get, set }, reason: InputTransition) => {
      const original = get(lifecycle.owner$);
      const cleanup = set(lifecycle.transition$, reason);
      if (!cleanup) {
        return null;
      }
      const successor = get(lifecycle.owner$);
      // A blur invalidates in-flight copies but retains the already recovered text.
      set(clipboardVersion$, (value) => {
        return value + 1;
      });
      if (reason !== "blur" && reason !== "failed") {
        set(geometry.invalidate$);
      }
      set(invalidateCaret$, false);
      set(queue.clear$);
      if (cleanup.composition) {
        set(cancelComposition$, cleanup.composition.target);
      }
      set(graph.compositionLease$, null);
      set(graph.compositionTargets$, new Map());
      set(editingReader.stop$);
      if (
        successor.document !== original.document ||
        !get(lifecycle.available$)
      ) {
        set(editingReader.reset$);
      }
      for (const key of cleanup.keys) {
        set(effects.notify$, {
          method: "Input.dispatchKeyEvent",
          params: { ...key, type: "keyUp", modifiers: 0 },
        });
      }
      for (const button of cleanup.buttons) {
        set(effects.notify$, {
          method: "Input.dispatchMouseEvent",
          params: {
            type: "mouseReleased",
            ...cleanup.point,
            button,
            buttons: 0,
          },
        });
      }
      set(internalTransition$, {
        id: (get(internalTransition$)?.id ?? 0) + 1,
        reason,
      });
      set(nativeHost.synchronize$);
      return set(lifecycle.owns$, successor) ? successor : null;
    });

  const failed$: Command<void, [unknown?]> = command(
    ({ set }, error?: unknown) => {
      set(transitionInput$, "failed");
      set(
        internalError$,
        error instanceof CdpFault && error.kind === "input"
          ? error
          : new CdpFault(
              "input",
              "Remote input could not be completed. Unsent input was discarded; it will not be replayed.",
              undefined,
              requestDetails(error),
            ),
      );
    },
  );
  return { transitionInput$, failed$ };
}

function createSessionCleanup(graph: SessionActions) {
  const {
    available$,
    effects,
    navigation,
    nativeHost,
    lifetime$,
    navigationGate$,
    queue,
    resetScope$,
    retiring$,
    transitionInput$,
  } = graph;
  const revoke$ = command(({ get, set }) => {
    if (!get(available$)) {
      return;
    }
    // Authority may already be false. Cleanup belongs to the original session,
    // not to the currently admitted input capability or the CDP connection.
    set(navigationGate$, null);
    set(transitionInput$, "blur");
  });
  const settleInput$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      await set(queue.settle$);
      signal.throwIfAborted();
      await set(effects.completion$);
      signal.throwIfAborted();
    },
  );
  const suspend$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      if (!get(available$)) {
        throw new CdpFault("input", "Input cleanup is unavailable.");
      }
      set(revoke$);
      await set(settleInput$, graph.client.signal);
      signal.throwIfAborted();
    },
  );
  const dispose$ = command(({ get, set }, reason: InputStop = "disposed") => {
    if (!get(available$)) {
      return;
    }
    set(lifetime$, null);
    set(transitionInput$, reason);
    set(navigation.dispose$);
    set(navigationGate$, null);
    set(resetScope$);
    set(nativeHost.synchronize$);
  });
  const retireCleanup$ = command(
    async (
      { set },
      reason: Exclude<InputStop, "disconnected">,
      signal: AbortSignal,
    ): Promise<void> => {
      using _retirement = {
        [Symbol.dispose]: () => {
          set(dispose$, reason);
        },
      };
      const [drained] = await Promise.allSettled([set(queue.settle$)]);
      signal.throwIfAborted();
      set(dispose$, reason);
      await set(effects.completion$);
      signal.throwIfAborted();
      if (drained.status === "rejected") {
        throw drained.reason;
      }
    },
  );
  const retire$ = command(
    async (
      { get, set },
      reason: Exclude<InputStop, "disconnected">,
      signal: AbortSignal,
    ): Promise<void> => {
      // Admission closes before callbacks/native blur can reenter this graph.
      if (!get(retiring$)) {
        set(retiring$, true);
        set(transitionInput$, "blur");
      }
      await set(retireCleanup$, reason, graph.client.signal);
      signal.throwIfAborted();
    },
  );

  return { revoke$, suspend$, dispose$, retire$ };
}

function createSessionReadiness(
  graph: SessionActions & ReturnType<typeof createSessionCleanup>,
) {
  const {
    accepting$,
    available$,
    client,
    dispose$,
    frameId$,
    geometry,
    navigation,
    nativeHost,
    lifecycle,
    lifetime$,
    queue,
    refreshCaret$,
    resetScope$,
    retiring$,
    sessionId,
    transitionInput$,
  } = graph;
  const start$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      if (!get(available$) || get(retiring$)) {
        throw new CdpFault("input", "Input is unavailable.");
      }
      if (get(lifetime$)) {
        throw new CdpFault("input", "Input is already initialized.");
      }
      const scope = set(resetScope$, signal);
      const lifetime = Object.freeze({});
      set(lifetime$, lifetime);
      set(navigation.start$, scope);
      set(nativeHost.synchronize$);
      scope.addEventListener(
        "abort",
        () => {
          set(dispose$, "disposed");
        },
        { once: true },
      );
      const revision = get(geometry.revision$);
      const [tree, metrics] = await Promise.all([
        client.request(
          "Page.getFrameTree",
          undefined,
          sessionId,
          undefined,
          scope,
        ),
        client.request(
          "Page.getLayoutMetrics",
          undefined,
          sessionId,
          undefined,
          scope,
        ),
      ]);
      signal.throwIfAborted();
      scope.throwIfAborted();
      if (!get(available$)) {
        return;
      }
      set(frameId$, tree.frameTree.frame.id);
      set(navigation.observe$, tree.frameTree.frame);
      set(geometry.read$, metrics, revision);
      await client.request(
        "Runtime.enable",
        undefined,
        sessionId,
        undefined,
        scope,
      );
      signal.throwIfAborted();
      scope.throwIfAborted();
    },
  );
  const focus$ = command(
    ({ get, set }, owner: InputOwner = get(lifecycle.owner$)) => {
      if (get(accepting$) && set(lifecycle.owns$, owner)) {
        set(refreshCaret$, set(queue.capture$, owner));
      }
    },
  );
  const blur$ = command(
    (
      { get, set },
      owner: InputOwner = get(lifecycle.owner$),
    ): InputOwner | null => {
      return get(accepting$) && set(lifecycle.owns$, owner)
        ? set(transitionInput$, "blur")
        : null;
    },
  );
  const checkOwner$ = command(({ get, set }, owner: InputOwner) => {
    if (!get(accepting$) || !set(lifecycle.owns$, owner)) {
      throw new Error("Input cancelled");
    }
  });
  const awaitOwnerCompletion$ = command(
    async ({ set }, owner: InputOwner, signal: AbortSignal): Promise<void> => {
      set(checkOwner$, owner);
      await set(queue.completion$, owner);
      signal.throwIfAborted();
      set(checkOwner$, owner);
    },
  );
  const completion$ = command(({ set }, owner: InputOwner): Promise<void> => {
    return set(awaitOwnerCompletion$, owner, graph.client.signal);
  });
  return { start$, focus$, blur$, completion$ };
}

function createSessionFrameObservation(graph: SessionActions) {
  const { contextId$, frameId$ } = graph;
  return command(({ get, set }, event: CdpEvent): boolean => {
    const { method, params } = event;
    if (
      method === "Runtime.executionContextCreated" &&
      isRecord(params.context)
    ) {
      const context = params.context;
      if (
        typeof context.id === "number" &&
        isRecord(context.auxData) &&
        context.auxData.isDefault === true &&
        context.auxData.frameId === get(frameId$)
      ) {
        set(contextId$, context.id);
      }
    }
    const mainNavigation =
      method === "Page.frameNavigated" &&
      isRecord(params.frame) &&
      !params.frame.parentId;
    if (
      mainNavigation &&
      isRecord(params.frame) &&
      typeof params.frame.id === "string"
    ) {
      set(frameId$, params.frame.id);
    }
    return mainNavigation;
  });
}

function createSessionEvents(graph: SessionActions) {
  const observeFrame$ = createSessionFrameObservation(graph);
  const {
    available$,
    contextId$,
    frameId$,
    navigation,
    invalidateClipboard$,
    sessionId,
    transitionInput$,
  } = graph;
  const event$ = command(({ get, set }, event: CdpEvent) => {
    if (!get(available$) || event.sessionId !== sessionId) {
      return;
    }
    set(navigation.event$, event);
    set(graph.editingReader.event$, event);
    const { method, params } = event;
    if (
      [
        "Page.frameNavigated",
        "Page.frameStartedNavigating",
        "Page.frameDetached",
        "Page.navigatedWithinDocument",
        "Runtime.executionContextDestroyed",
        "Runtime.executionContextsCleared",
      ].includes(method)
    ) {
      set(invalidateClipboard$);
    }
    const mainNavigation = set(observeFrame$, event);
    const mainFrameEvent = params.frameId === get(frameId$);
    const mainNavigating =
      mainFrameEvent && method === "Page.frameStartedNavigating";
    const sameDocument =
      mainFrameEvent && method === "Page.navigatedWithinDocument";
    if (
      mainNavigation ||
      mainNavigating ||
      sameDocument ||
      method === "Runtime.executionContextsCleared" ||
      (method === "Runtime.executionContextDestroyed" &&
        params.executionContextId === get(contextId$))
    ) {
      set(
        transitionInput$,
        mainNavigating
          ? "navigation-started"
          : sameDocument
            ? "same-document"
            : "document-lost",
      );
    }
  });

  return { event$ };
}

function createPointerFallback(graph: SessionObservations) {
  const { lifecycle, queue } = graph;
  return command(({ set }, job: InputJob) => {
    const { type, details } = job.data as PointerJob;
    if (type === "mouseReleased" && details.button) {
      const pressed = set(lifecycle.pressedButton$, job.owner, details.button);
      if (pressed) {
        set(
          queue.dispatch$,
          job,
          {
            method: "Input.dispatchMouseEvent",
            params: {
              type,
              ...pressed,
              button: details.button,
              buttons: details.buttons ?? 0,
            },
          },
          { kind: "button", button: details.button, pressed },
        );
      }
    }
  });
}

function createSessionPointer(graph: SessionObservations) {
  const releaseFallback$ = createPointerFallback(graph);
  const {
    accepting$,
    geometry,
    internalError$,
    invalidateCaret$,
    invalidateClipboard$,
    lifecycle,
    queue,
    refreshCaret$,
  } = graph;
  const pointerRun$ = command(
    async ({ get, set }, job: InputJob, signal: AbortSignal) => {
      const { type, point, details } = job.data as PointerJob;
      let inputGeometry: InputGeometry | null = get(geometry.input$);
      if (!inputGeometry && get(geometry.available$)) {
        const revision = get(geometry.revision$);
        const metrics = await set(queue.layout$, job);
        signal.throwIfAborted();
        inputGeometry = set(geometry.read$, metrics, revision);
      }
      if (
        !inputGeometry ||
        inputGeometry.revision !== get(geometry.revision$)
      ) {
        set(releaseFallback$, job);
        return;
      }
      const position = inputGeometry.position(point);
      if (type === "mousePressed") {
        set(invalidateCaret$);
      }
      set(
        lifecycle.pointer$,
        job.owner,
        position,
        type === "mousePressed" ? details.button : undefined,
      );
      const button = type === "mouseReleased" ? details.button : undefined;
      const pressed = button
        ? set(lifecycle.pressedButton$, job.owner, button)
        : undefined;
      set(internalError$, null);
      set(
        queue.dispatch$,
        job,
        {
          method: "Input.dispatchMouseEvent",
          params: {
            type,
            ...position,
            ...details,
            ...(job.wheel
              ? inputGeometry.wheel(job.wheel.deltaX, job.wheel.deltaY)
              : {}),
          },
        },
        button ? { kind: "button", button, pressed } : undefined,
      );
      if (type === "mouseReleased" && details.button) {
        set(refreshCaret$, job);
      }
    },
  );
  const pointer$ = command(
    (
      { get, set },
      type: Mouse["type"],
      point: Point,
      details: PointerDetails,
      owner: InputOwner = get(lifecycle.owner$),
    ) => {
      if (
        !get(accepting$) ||
        !set(lifecycle.owns$, owner) ||
        (!get(geometry.available$) && type !== "mouseReleased")
      ) {
        return;
      }
      if (type === "mousePressed") {
        set(invalidateClipboard$);
      }
      const data: PointerJob = { type, point, details };
      if (type === "mouseWheel") {
        set(
          queue.wheel$,
          owner,
          {
            point,
            button: details.button ?? "none",
            buttons: details.buttons ?? 0,
            modifiers: details.modifiers ?? 0,
            deltaX: details.deltaX ?? 0,
            deltaY: details.deltaY ?? 0,
          },
          pointerRun$,
          undefined,
          data,
        );
      } else {
        set(
          queue.enqueue$,
          owner,
          pointerRun$,
          type === "mouseMoved" ? details : undefined,
          undefined,
          data,
        );
      }
    },
  );
  return { pointer$ };
}

function createCompositionBinding(graph: SessionObservations) {
  const {
    accepting$,
    compositionLease$,
    compositionTargets$,
    editingReader,
    lifecycle,
    queue,
    refreshCaret$,
  } = graph;
  const beginRun$ = command(
    async ({ get, set }, job: InputJob, signal: AbortSignal) => {
      const lease = job.data as CompositionLease;
      const result = await set(editingReader.begin$, job, signal);
      signal.throwIfAborted();
      if (
        !set(lifecycle.owns$, job.owner) ||
        !get(compositionTargets$).has(lease.token)
      ) {
        return;
      }
      const observed = result?.editing;
      const target =
        observed?.kind !== "inactive" ? (observed?.target ?? null) : null;
      set(
        compositionTargets$,
        new Map(get(compositionTargets$)).set(lease.token, target),
      );
      if (!target) {
        set(refreshCaret$, job);
      }
    },
  );
  const beginComposition$ = command(({ get, set }, owner: InputOwner) => {
    if (!get(accepting$) || !set(lifecycle.owns$, owner)) {
      return;
    }
    const lease: CompositionLease = {
      token: Object.freeze({}),
      owner,
    };
    const targets = new Map(get(compositionTargets$));
    const previous = get(compositionLease$);
    if (previous) {
      targets.delete(previous.token);
    }
    targets.set(lease.token, null);
    set(compositionLease$, lease);
    set(compositionTargets$, targets);
    // Capture focus after preceding native effects, independently of stale hints.
    set(queue.enqueue$, owner, beginRun$, undefined, undefined, lease, true);
  });
  const validComposition$ = command(({ get, set }, job: InputJob) => {
    const lease = job.data as CompositionLease;
    const target = get(compositionTargets$).get(lease.token);
    if (!target) {
      return null;
    }
    const valid = set(editingReader.valid$, target);
    if (valid) {
      return target;
    }
    set(
      compositionTargets$,
      new Map(get(compositionTargets$)).set(lease.token, null),
    );
    const token = set(lifecycle.composition$, job.owner);
    set(lifecycle.finishComposition$, job.owner, token);
    set(refreshCaret$, job);
    return null;
  });
  return { beginComposition$, validComposition$ };
}
type CompositionActions = SessionObservations &
  ReturnType<typeof createCompositionBinding>;

function createSessionText(graph: SessionObservations) {
  const {
    accepting$,
    internalError$,
    invalidateClipboard$,
    lifecycle,
    queue,
    refreshCaret$,
  } = graph;
  const textRun$ = command(({ set }, job: InputJob) => {
    set(internalError$, null);
    const token = set(lifecycle.composition$, job.owner);
    set(
      queue.dispatch$,
      job,
      { method: "Input.insertText", params: { text: job.text! } },
      { kind: "composition", token },
    );
    set(refreshCaret$, job);
  });
  const text$ = command(
    ({ get, set }, text: string, owner: InputOwner = get(lifecycle.owner$)) => {
      if (!get(accepting$) || !set(lifecycle.owns$, owner)) {
        return;
      }
      set(invalidateClipboard$);
      set(queue.text$, owner, text, textRun$);
    },
  );
  return { text$ };
}

function createSessionPreedit(graph: CompositionActions) {
  const {
    accepting$,
    compositionLease$,
    invalidateClipboard$,
    lifecycle,
    preeditSupported$,
    queue,
    refreshCaret$,
    validComposition$,
  } = graph;
  const preeditRun$ = command(
    async ({ get, set }, job: InputJob, signal: AbortSignal) => {
      if (!get(preeditSupported$)) {
        return;
      }
      const target = set(validComposition$, job);
      if (!target) {
        return;
      }
      const value = job.preedit!;
      const token = value.text
        ? set(lifecycle.compose$, job.owner, target)
        : set(lifecycle.composition$, job.owner);
      const [result] = await Promise.allSettled([
        set(queue.write$, job, {
          method: "Input.imeSetComposition",
          params: value,
        }),
      ]);
      signal.throwIfAborted();
      if (result.status === "fulfilled") {
        if (!value.text) {
          set(lifecycle.finishComposition$, job.owner, token);
        }
        set(refreshCaret$, job);
      } else if (
        result.reason instanceof CdpFault &&
        result.reason.code === -32_601
      ) {
        set(preeditSupported$, false);
        set(lifecycle.finishComposition$, job.owner, token);
      }
      if (
        result.status === "rejected" &&
        !(result.reason instanceof CdpFault && result.reason.code === -32_601)
      ) {
        throw result.reason;
      }
    },
  );
  const preedit$ = command(
    (
      { get, set },
      text: string,
      owner: InputOwner,
      selectionStart: number = text.length,
      selectionEnd: number = selectionStart,
    ) => {
      const lease = get(compositionLease$);
      if (
        !get(accepting$) ||
        !get(preeditSupported$) ||
        !set(lifecycle.owns$, owner) ||
        lease?.owner !== owner
      ) {
        return;
      }
      set(invalidateClipboard$);
      set(
        queue.preedit$,
        owner,
        { text, selectionStart, selectionEnd },
        preeditRun$,
        lease,
      );
    },
  );
  return { preedit$ };
}

function createSessionCompositionCommit(graph: CompositionActions) {
  const {
    accepting$,
    compositionLease$,
    compositionTargets$,
    internalError$,
    lifecycle,
    queue,
    refreshCaret$,
    validComposition$,
  } = graph;
  const commitRun$ = command(
    async ({ get, set }, job: InputJob, signal: AbortSignal) => {
      const lease = job.data as CompositionLease;
      using _lease = {
        [Symbol.dispose]: () => {
          const remaining = new Map(get(compositionTargets$));
          const target = remaining.get(lease.token);
          if (target) {
            set(graph.editingReader.stop$, target);
          }
          remaining.delete(lease.token);
          set(compositionTargets$, remaining);
        },
      };
      const target = set(validComposition$, job);
      if (!target) {
        return;
      }
      set(internalError$, null);
      const token = set(lifecycle.composition$, job.owner);
      if (job.text) {
        await set(queue.write$, job, {
          method: "Input.insertText",
          params: { text: job.text },
        });
      } else if (token) {
        await set(queue.write$, job, {
          method: "Input.imeSetComposition",
          params: { text: "", selectionStart: 0, selectionEnd: 0 },
        });
      }
      signal.throwIfAborted();
      set(lifecycle.finishComposition$, job.owner, token);
      set(refreshCaret$, job);
    },
  );
  const commitComposition$ = command(
    ({ get, set }, text: string, owner: InputOwner) => {
      const lease = get(compositionLease$);
      if (
        !get(accepting$) ||
        !set(lifecycle.owns$, owner) ||
        lease?.owner !== owner
      ) {
        return;
      }
      set(queue.discardPreedit$);
      set(compositionLease$, null);
      if (text) {
        set(queue.text$, owner, text, commitRun$, lease, true);
      } else {
        set(
          queue.enqueue$,
          owner,
          commitRun$,
          undefined,
          undefined,
          lease,
          true,
        );
      }
    },
  );
  return { commitComposition$ };
}

function createSessionComposition(graph: SessionObservations) {
  const binding = createCompositionBinding(graph);
  const actions = { ...graph, ...binding };
  return {
    beginComposition$: binding.beginComposition$,
    ...createSessionText(graph),
    ...createSessionPreedit(actions),
    ...createSessionCompositionCommit(actions),
  };
}

function createSessionKeyboard(graph: SessionObservations) {
  const {
    accepting$,
    clipboardVersion$,
    internalError$,
    invalidateClipboard$,
    lifecycle,
    queue,
    refreshCaret$,
    selectionReader,
  } = graph;
  const keyRun$ = command(({ set }, job: InputJob) => {
    const key = job.data as Key;
    if (key.type !== "keyUp") {
      set(internalError$, null);
    }
    const pressed = set(lifecycle.pressedKey$, job.owner, key);
    if (key.type !== "keyUp") {
      set(lifecycle.pressKey$, job.owner, key);
    }
    set(
      queue.dispatch$,
      job,
      { method: "Input.dispatchKeyEvent", params: key },
      key.type === "keyUp" ? { kind: "key", key, pressed } : undefined,
    );
    if (
      key.type !== "keyUp" &&
      !["Shift", "Control", "Alt", "Meta"].includes(key.key ?? "")
    ) {
      set(refreshCaret$, job);
    }
  });
  const key$ = command(
    ({ get, set }, key: Key, owner: InputOwner = get(lifecycle.owner$)) => {
      if (!get(accepting$) || !set(lifecycle.owns$, owner)) {
        return;
      }
      if (
        key.type !== "keyUp" &&
        !["Shift", "Control", "Alt", "Meta"].includes(key.key ?? "")
      ) {
        set(invalidateClipboard$);
      }
      set(queue.enqueue$, owner, keyRun$, undefined, undefined, key);
    },
  );
  const selection$ = command(
    ({ get, set }, owner: InputOwner): Promise<SelectionResult> => {
      if (!get(accepting$) || !set(lifecycle.owns$, owner)) {
        throw new Error("Selection cancelled");
      }
      set(clipboardVersion$, (value) => {
        return value + 1;
      });
      return set(selectionReader.read$, owner);
    },
  );
  const clipboardError$ = command(
    (
      { get, set },
      message: string,
      owner: InputOwner = get(lifecycle.owner$),
    ) => {
      if (get(accepting$) && set(lifecycle.owns$, owner)) {
        set(internalError$, new CdpFault("input", message));
      }
    },
  );
  return { key$, selection$, clipboardError$ };
}

function createNavigationAdmission(graph: SessionActions) {
  const {
    navigationGate$,
    isCurrent$,
    retiring$,
    available$,
    lifetime$,
    lifecycle,
  } = graph;
  return command(
    ({ get, set }, gate: object, lifetime: object, owner?: InputOwner) => {
      if (
        get(navigationGate$) !== gate ||
        !get(isCurrent$) ||
        get(retiring$) ||
        !get(available$) ||
        get(lifetime$) !== lifetime
      ) {
        throw new DOMException("Navigation cancelled", "AbortError");
      }
      if (owner && !set(lifecycle.owns$, owner)) {
        throw new DOMException("Navigation cancelled", "AbortError");
      }
    },
  );
}

function createSessionNavigation(graph: SessionActions) {
  const checkNavigation$ = createNavigationAdmission(graph);
  const {
    accepting$,
    effects,
    lifetime$,
    navigation,
    nativeHost,
    navigationGate$,
    queue,
    transitionInput$,
  } = graph;
  const navigate$ = command(
    async (
      { get, set },
      action: NavigationAction,
      signal: AbortSignal,
    ): Promise<NavigationReceipt> => {
      signal.throwIfAborted();
      if (!get(accepting$)) {
        throw new CdpFault("input", "Input is unavailable.");
      }
      const url =
        typeof action === "string" ? "" : navigationAddress(action.url);
      if (typeof action !== "string" && !url) {
        throw new CdpFault(
          "input",
          "Enter a page address, such as example.com or about:blank.",
        );
      }
      const lifetime = get(lifetime$);
      if (!lifetime) {
        throw new DOMException("Navigation cancelled", "AbortError");
      }
      const owner = set(transitionInput$, "navigation-started");
      if (!owner) {
        throw new DOMException("Navigation cancelled", "AbortError");
      }
      const gate = {};
      set(navigationGate$, gate);
      set(nativeHost.synchronize$);
      using _navigation = {
        [Symbol.dispose]: () => {
          if (get(navigationGate$) === gate) {
            set(navigationGate$, null);
            set(nativeHost.synchronize$);
          }
        },
      };
      // The fence joins preceding sends and their cleanup, but never owns the
      // document replacement caused by the navigation protocol request itself.
      await set(queue.completion$, owner);
      signal.throwIfAborted();
      set(checkNavigation$, gate, lifetime, owner);
      let operation: Promise<unknown>;
      if (action === "reload") {
        operation = set(effects.request$, {
          method: "Page.reload",
          params: undefined,
        });
      } else if (action === "back" || action === "forward") {
        const history = await set(navigation.readHistory$, signal);
        signal.throwIfAborted();
        set(checkNavigation$, gate, lifetime, owner);
        const entry =
          history.entries[history.currentIndex + (action === "back" ? -1 : 1)];
        if (!entry) {
          return { kind: "unavailable" };
        }
        operation = set(effects.request$, {
          method: "Page.navigateToHistoryEntry",
          params: { entryId: entry.id },
        });
      } else {
        operation = set(effects.request$, {
          method: "Page.navigate",
          params: { url: url! },
        });
      }
      const result = await operation;
      signal.throwIfAborted();
      // Document events caused by this navigation replace the input owner, not
      // this protocol receipt. Authority/scope revocation still cancels it.
      set(checkNavigation$, gate, lifetime);
      if (isRecord(result) && result.errorText) {
        throw new CdpFault("input", "The remote page could not be navigated.");
      }
      if (typeof action === "string") {
        return { kind: "ack" };
      }
      if (!isRecord(result) || typeof result.frameId !== "string") {
        throw new CdpFault("protocol", "The navigation receipt is invalid.");
      }
      const identity = {
        frameId: result.frameId,
        ...(typeof result.loaderId === "string"
          ? { loaderId: result.loaderId }
          : {}),
      };
      return result.isDownload === true
        ? { kind: "download", ...identity }
        : { kind: "ack", ...identity };
    },
  );

  return { navigate$ };
}

/** A stable, store-isolated input graph for one native CDP session. */
export function createInputSession(
  connection: SessionConnection,
  isCurrent$: Computed<boolean>,
  geometry: DisplayViewport,
  nativeHost: NativeInputHost,
  navigation: NavigationData,
) {
  const { client, sessionId } = connection;
  const values = createSessionState(
    connection,
    isCurrent$,
    geometry,
    nativeHost,
    navigation,
  );
  const failed$ = command(({ set }, error?: unknown) => {
    set(transitions.failed$, error);
  });
  const queue = createInputQueue(
    client,
    values.lifecycle,
    values.effects,
    isCurrent$,
    failed$,
  );
  const selectionReader = createSelectionReader(
    client,
    sessionId,
    queue,
    values.lifecycle,
    computed((get) => {
      return get(values.frameId$);
    }),
    values.clipboardEpoch$,
  );
  const editingReader = createEditingReader(
    client,
    sessionId,
    queue,
    values.lifecycle,
    computed((get) => {
      return get(values.frameId$);
    }),
  );
  const base = { ...values, queue, selectionReader, editingReader };
  const observations = {
    ...base,
    ...createSessionInvalidation(base),
  };
  const observed = {
    ...observations,
    ...createCaretObservation(observations),
  };
  const transitions = createSessionTransitions(observed);
  const actions = { ...observed, ...transitions };
  const cleanup = createSessionCleanup(actions);
  const readiness = createSessionReadiness({ ...actions, ...cleanup });
  return {
    sessionId,
    geometry,
    available$: values.available$,
    owner$: values.owner$,
    error$: values.error$,
    caret$: values.caret$,
    editing$: values.editing$,
    transition$: values.transition$,
    clipboardEpoch$: values.clipboardEpoch$,
    ...cleanup,
    ...readiness,
    ...createSessionEvents(actions),
    ...createSessionPointer(observed),
    ...createSessionComposition(observed),
    ...createSessionKeyboard(observed),
    ...createSessionNavigation(actions),
  };
}
