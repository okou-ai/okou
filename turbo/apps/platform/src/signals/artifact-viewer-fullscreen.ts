import { command, computed, state, type Command, type State } from "ccstate";
import { animationFrame } from "signal-timers";
import { pageSignal$ } from "./page-signal.ts";
import {
  createDeferredPromise,
  onDomEventFn,
  onRef,
  resetSignal,
  settle,
  withCleanup,
} from "./utils.ts";

type FullscreenMode = "windowed" | "native" | "immersive";

// A cancelled browser request can outlive its route. Keep the document's native
// lease until it settles and is released, before another viewer can acquire it.
const nativeOwner$ = state<symbol | null>(null);
const nativeExit$ = state<Promise<void> | null>(null);

// Cleanup belongs to the native lease, which can outlive the page while a
// nested fullscreen surface is on top. Release only our own target.
const releaseNative$ = command(
  (
    { get, set },
    target: HTMLElement,
    owner: symbol,
    signal: AbortSignal,
  ): void | Promise<void> => {
    if (get(nativeOwner$) !== owner) {
      return;
    }
    const exiting = get(nativeExit$);
    if (exiting) {
      return exiting;
    }
    const ownerDocument = target.ownerDocument;
    if (
      ownerDocument.fullscreenElement !== target &&
      target.matches(":fullscreen")
    ) {
      const changed = onDomEventFn(() => {
        ownerDocument.removeEventListener("fullscreenchange", changed);
        return set(releaseNative$, target, owner, signal);
      });
      ownerDocument.addEventListener("fullscreenchange", changed);
      return;
    }
    const exit = withCleanup(
      ownerDocument.fullscreenElement === target
        ? ownerDocument.exitFullscreen()
        : Promise.resolve(),
      () => {
        set(nativeOwner$, null);
        set(nativeExit$, null);
      },
    );
    set(nativeExit$, exit);
    return exit;
  },
);

const focusExitButtonRef$ = onRef(
  command((_context, element: HTMLElement, _signal: AbortSignal) => {
    element.focus({ preventScroll: true });
  }),
);

function restoreTriggerFocus(container: HTMLElement, trigger: HTMLElement) {
  const ownerDocument = container.ownerDocument;
  const active = ownerDocument.activeElement;
  // An open dialog retains its own focus and return-focus lifecycle.
  if (
    !trigger.closest('[inert], [aria-hidden="true"]') &&
    (active === ownerDocument.body ||
      active === ownerDocument.documentElement ||
      (active && container.contains(active)))
  ) {
    trigger.focus({ preventScroll: true });
  }
}

function isNativeFullscreen(target: HTMLElement) {
  return (
    target.ownerDocument.fullscreenElement === target ||
    target.matches(":fullscreen")
  );
}

const enterNative$ = command(
  async (
    { set },
    target: HTMLElement,
    mode$: State<FullscreenMode>,
    close$: Command<void, [AbortSignal]>,
    signal: AbortSignal,
  ) => {
    // requestFullscreen cannot be cancelled. Observe its result even after
    // abort so the caller's cleanup can release a late successful request.
    const result = await settle(target.requestFullscreen());
    signal.throwIfAborted();
    if (!result.ok) {
      set(mode$, "immersive");
      return;
    }
    const ownerDocument = target.ownerDocument;
    if (!isNativeFullscreen(target)) {
      return;
    }
    set(mode$, "native");
    const finished = createDeferredPromise<void>(signal);
    const changed = () => {
      if (!isNativeFullscreen(target) && !finished.settled()) {
        set(close$, signal);
        finished.resolve();
      }
    };
    ownerDocument.addEventListener("fullscreenchange", changed);
    await withCleanup(finished.promise, () => {
      ownerDocument.removeEventListener("fullscreenchange", changed);
    });
  },
);

export function createArtifactViewerFullscreenSignals() {
  // A new page lifetime can reuse the same main element while an earlier
  // uncancellable native request still owns the document.
  const owner = Symbol("artifact-viewer-fullscreen");
  const internalMode$ = state<FullscreenMode>("windowed");
  const internalContainer$ = state<HTMLElement | null>(null);
  const internalTrigger$ = state<HTMLElement | null>(null);
  const resetEnter$ = resetSignal();

  const enterButtonRef$ = onRef(
    command(({ set }, element: HTMLElement, signal: AbortSignal) => {
      set(internalTrigger$, element);
      signal.addEventListener("abort", () => {
        set(internalTrigger$, null);
      });
    }),
  );

  const close$ = command(({ get, set }, signal: AbortSignal) => {
    set(internalMode$, "windowed");
    animationFrame(
      () => {
        const container = get(internalContainer$);
        const trigger = get(internalTrigger$);
        if (get(internalMode$) === "windowed" && container && trigger) {
          restoreTriggerFocus(container, trigger);
        }
      },
      { signal },
    );
  });

  const containerRef$ = onRef(
    command(({ get, set }, element: HTMLElement, refSignal: AbortSignal) => {
      const signal = AbortSignal.any([refSignal, get(pageSignal$)]);
      set(internalContainer$, element);
      element.ownerDocument.addEventListener(
        "keydown",
        (event) => {
          if (
            event.key === "Escape" &&
            !event.defaultPrevented &&
            !element.closest('[inert], [aria-hidden="true"]') &&
            event.target instanceof Node &&
            (element.contains(event.target) ||
              event.target === element.ownerDocument.body) &&
            get(internalMode$) === "immersive"
          ) {
            event.preventDefault();
            set(close$, signal);
          }
        },
        { signal },
      );
      signal.addEventListener("abort", () => {
        set(resetEnter$);
        set(internalContainer$, null);
        set(internalTrigger$, null);
        set(internalMode$, "windowed");
      });
    }),
  );

  const enter$ = command(async ({ get, set }, parentSignal: AbortSignal) => {
    parentSignal.throwIfAborted();
    const container = get(internalContainer$);
    if (!container) {
      return;
    }
    if (get(internalMode$) !== "windowed" || get(nativeOwner$) === owner) {
      return;
    }
    const ownerDocument = container.ownerDocument;
    // Include the app and body-level portals in the browser's top layer, while
    // keeping the preview's layout node (and its iframe) in place.
    const target = ownerDocument.documentElement;
    if (
      !ownerDocument.fullscreenEnabled ||
      typeof target.requestFullscreen !== "function" ||
      ownerDocument.fullscreenElement ||
      get(nativeOwner$)
    ) {
      set(internalMode$, "immersive");
      return;
    }
    const signal = set(resetEnter$, parentSignal);
    set(nativeOwner$, owner);
    await withCleanup(
      set(enterNative$, target, internalMode$, close$, signal),
      () => {
        return set(releaseNative$, target, owner, signal);
      },
    );
  });

  const exit$ = command(async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(resetEnter$);
    const container = get(internalContainer$);
    if (container) {
      await set(
        releaseNative$,
        container.ownerDocument.documentElement,
        owner,
        signal,
      );
      signal.throwIfAborted();
    }
    set(close$, signal);
  });

  return {
    containerRef$,
    enterButtonRef$,
    enter$,
    entering$: computed((get) => {
      return get(nativeOwner$) === owner && get(internalMode$) === "windowed";
    }),
    exit$,
    exitButtonRef$: focusExitButtonRef$,
    fullscreen$: computed((get) => {
      return get(internalMode$) !== "windowed";
    }),
  };
}
