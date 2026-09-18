import { command, computed, state } from "ccstate";
import { animationFrame } from "signal-timers";
import { onRef, settle } from "./utils.ts";

type FullscreenMode = "windowed" | "native" | "immersive";

const focusExitButtonRef$ = onRef(
  command((_context, element: HTMLElement, _signal: AbortSignal) => {
    element.focus({ preventScroll: true });
  }),
);

export function createArtifactViewerFullscreenSignals() {
  const internalMode$ = state<FullscreenMode>("windowed");
  const internalContainer$ = state<HTMLElement | null>(null);
  const internalTrigger$ = state<HTMLElement | null>(null);

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
        get(internalTrigger$)?.focus({ preventScroll: true });
      },
      { signal },
    );
  });

  const containerRef$ = onRef(
    command(({ get, set }, element: HTMLElement, signal: AbortSignal) => {
      set(internalContainer$, element);
      const ownerDocument = element.ownerDocument;
      ownerDocument.addEventListener(
        "fullscreenchange",
        () => {
          if (ownerDocument.fullscreenElement === element) {
            set(internalMode$, "native");
          } else if (
            get(internalMode$) === "native" &&
            !element.contains(ownerDocument.fullscreenElement)
          ) {
            set(close$, signal);
          }
        },
        { signal },
      );
      ownerDocument.addEventListener(
        "keydown",
        (event) => {
          if (
            event.key === "Escape" &&
            !event.defaultPrevented &&
            get(internalMode$) === "immersive"
          ) {
            event.preventDefault();
            set(close$, signal);
          }
        },
        { signal },
      );
      signal.addEventListener("abort", () => {
        set(internalContainer$, null);
        set(internalTrigger$, null);
        set(internalMode$, "windowed");
      });
    }),
  );

  const enter$ = command(async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const container = get(internalContainer$);
    if (!container) {
      return;
    }
    if (
      container.ownerDocument.fullscreenEnabled &&
      typeof container.requestFullscreen === "function"
    ) {
      const result = await settle(container.requestFullscreen(), signal);
      if (!result.ok) {
        // Browsers may reject fullscreen even when the API is available.
        set(internalMode$, "immersive");
      } else if (container.ownerDocument.fullscreenElement === container) {
        set(internalMode$, "native");
      }
    } else {
      // Mobile browsers without Fullscreen API still get the full viewport.
      set(internalMode$, "immersive");
    }
  });

  const exit$ = command(async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const container = get(internalContainer$);
    if (container && container.ownerDocument.fullscreenElement === container) {
      await container.ownerDocument.exitFullscreen();
      signal.throwIfAborted();
    }
    set(close$, signal);
  });

  return {
    containerRef$,
    enterButtonRef$,
    enter$,
    exit$,
    exitButtonRef$: focusExitButtonRef$,
    fullscreen$: computed((get) => {
      return get(internalMode$) !== "windowed";
    }),
  };
}
