import { delay } from "signal-timers";
import { detach, Reason } from "../signals/utils.ts";

const KEYBOARD_SHRINK_RATIO = 0.15;
const MIN_KEYBOARD_SHRINK_PX = 120;
const LAYOUT_VIEWPORT_CHANGE_TOLERANCE_PX = 8;
const VIEWPORT_SETTLE_DELAY_MS = 50;
const CONTENTEDITABLE_SELECTOR =
  "[contenteditable]:not([contenteditable='false'])";
const CHAT_COMPOSER_SELECTOR =
  "[data-chat-composer] [data-slot='chat-composer-card']";
const KEYBOARD_SCROLL_RESERVE_PROPERTY = "--okou-keyboard-scroll-reserve";
const COMPOSER_KEYBOARD_GAP_PX = 16;
const STANDALONE_DISPLAY_MODE_QUERY = "(display-mode: standalone)";
const COARSE_POINTER_QUERY = "(pointer: coarse)";
const FINE_POINTER_QUERY = "(any-pointer: fine)";

const TEXT_ENTRY_SELECTOR = `textarea, select, ${CONTENTEDITABLE_SELECTOR}`;

function isNonTextInputType(type: string): boolean {
  switch (type) {
    case "button":
    case "checkbox":
    case "color":
    case "file":
    case "hidden":
    case "image":
    case "radio":
    case "range":
    case "reset":
    case "submit": {
      return true;
    }
    default: {
      return false;
    }
  }
}

function isTextEntryElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  if (element instanceof HTMLInputElement) {
    return !isNonTextInputType(element.type);
  }

  return element.matches(TEXT_ENTRY_SELECTOR);
}

function readLayoutViewportHeight(viewport: VisualViewport): number {
  // offsetTop can briefly outlive the keyboard during standalone PWA close.
  // Never add it to the baseline or each open/close cycle can make the
  // keyboard appear taller than the previous one.
  return Math.max(
    window.innerHeight,
    document.documentElement.clientHeight,
    viewport.height * viewport.scale,
  );
}

function readKeyboardOcclusion(
  baselineHeight: number,
  viewport: VisualViewport,
): number {
  return Math.max(
    0,
    Math.round(baselineHeight - viewport.height * viewport.scale),
  );
}

function viewportHasKeyboardOcclusion(
  baselineHeight: number,
  viewport: VisualViewport,
): boolean {
  const occludedHeight = readKeyboardOcclusion(baselineHeight, viewport);
  const keyboardThreshold = Math.max(
    MIN_KEYBOARD_SHRINK_PX,
    baselineHeight * KEYBOARD_SHRINK_RATIO,
  );

  // Hiding the software keyboard can leave the focused input accessory bar
  // visible. Occlusion too small to open a keyboard session must also close
  // the previous session, otherwise the next software-keyboard reveal is
  // mistaken for the same session.
  return occludedHeight > keyboardThreshold;
}

/**
 * Reports whether a software keyboard currently occludes the visual viewport.
 *
 * WebKit reports `any-pointer: fine` and `any-hover: hover` on iPhones, so
 * pointer media queries cannot tell a trackpad-and-keyboard tablet apart from
 * a phone. A shrunk visual viewport over an unchanged layout viewport is the
 * device's own evidence that the on-screen keyboard produced the keystroke.
 */
function softwareKeyboardOccludesViewport(): boolean {
  const viewport = window.visualViewport;
  if (!viewport) {
    return false;
  }
  return viewportHasKeyboardOcclusion(
    readLayoutViewportHeight(viewport),
    viewport,
  );
}

function isIOSDevice(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

/**
 * Reports whether text entry should use mobile-safe interaction behavior.
 *
 * A fine pointer normally means a hardware keyboard is available, while the
 * visual viewport detects an active software keyboard. WebKit reports a fine
 * pointer on iOS even without one, so iOS also needs an explicit fallback.
 */
export function isMobileTextInputDevice(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return (
    window.matchMedia(COARSE_POINTER_QUERY).matches &&
    (!window.matchMedia(FINE_POINTER_QUERY).matches ||
      isIOSDevice() ||
      softwareKeyboardOccludesViewport())
  );
}

function setKeyboardOpen(keyboardOcclusion: number): void {
  const root = document.documentElement;
  root.dataset.keyboardOpen = "true";
  root.style.setProperty(
    KEYBOARD_SCROLL_RESERVE_PROPERTY,
    `${keyboardOcclusion + COMPOSER_KEYBOARD_GAP_PX}px`,
  );
}

function setKeyboardClosed(): void {
  const root = document.documentElement;
  delete root.dataset.keyboardOpen;
  root.style.removeProperty(KEYBOARD_SCROLL_RESERVE_PROPERTY);
}

function revealFocusedComposer(): void {
  if (!window.matchMedia(STANDALONE_DISPLAY_MODE_QUERY).matches) {
    return;
  }

  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) {
    return;
  }

  const target = activeElement.closest(CHAT_COMPOSER_SELECTOR);
  if (!(target instanceof HTMLElement)) {
    return;
  }

  // Keep the editor's document geometry stable and reveal the whole composer
  // through a real scroll. WebKit synchronizes its native caret layer on the
  // scrolling path, unlike CSS reflow of a focused fixed-position descendant.
  target.scrollIntoView({
    behavior: "auto",
    block: "end",
    inline: "nearest",
  });
}

type KeyboardViewportState = {
  baselineHeight: number;
  keyboardOpen: boolean;
  resetBaselineOnSettle: boolean;
};

function updateKeyboardViewportState(
  state: KeyboardViewportState,
  viewport: VisualViewport,
  commitOpening: boolean,
): void {
  if (state.resetBaselineOnSettle) {
    if (!commitOpening) {
      return;
    }
    state.baselineHeight = readLayoutViewportHeight(viewport);
    state.keyboardOpen = false;
    state.resetBaselineOnSettle = false;
  }

  if (!isTextEntryElement(document.activeElement)) {
    if (commitOpening) {
      // A trailing unfocused sample is a stable layout viewport, including
      // window and stage resizes that are unrelated to the keyboard.
      state.baselineHeight = readLayoutViewportHeight(viewport);
    }
    state.keyboardOpen = false;
    setKeyboardClosed();
    return;
  }

  const hasKeyboardOcclusion = viewportHasKeyboardOcclusion(
    state.baselineHeight,
    viewport,
  );
  if (!hasKeyboardOcclusion) {
    state.keyboardOpen = false;
    setKeyboardClosed();
    return;
  }

  if (!state.keyboardOpen && !commitOpening) {
    return;
  }

  state.keyboardOpen = true;
  setKeyboardOpen(readKeyboardOcclusion(state.baselineHeight, viewport));
}

export function setupVisualViewportKeyboardState(
  signal: AbortSignal,
  resetSettledSignal: () => AbortSignal,
  waitForSettle: (signal: AbortSignal) => Promise<void> = (settledSignal) => {
    return delay(VIEWPORT_SETTLE_DELAY_MS, { signal: settledSignal });
  },
): () => void {
  signal.throwIfAborted();
  const viewport = window.visualViewport;

  if (!viewport) {
    return () => {
      setKeyboardClosed();
    };
  }

  const state: KeyboardViewportState = {
    baselineHeight: readLayoutViewportHeight(viewport),
    keyboardOpen: false,
    resetBaselineOnSettle: false,
  };
  let scheduledFrameId: number | null = null;
  let revealFrameId: number | null = null;
  let settledTimerSignal: AbortSignal | null = null;

  const cancelSettledUpdate = () => {
    if (settledTimerSignal) {
      resetSettledSignal();
      settledTimerSignal = null;
    }
  };

  const commitSettledUpdate = async (settledSignal: AbortSignal) => {
    await waitForSettle(settledSignal);
    settledSignal.throwIfAborted();
    if (settledTimerSignal !== settledSignal) {
      return;
    }
    settledTimerSignal = null;
    update(true);
  };

  const update = (commitOpening: boolean) => {
    const keyboardWasOpen = state.keyboardOpen;
    updateKeyboardViewportState(state, viewport, commitOpening);
    if (!keyboardWasOpen && state.keyboardOpen) {
      if (revealFrameId !== null) {
        window.cancelAnimationFrame(revealFrameId);
      }
      // The scroll reserve is a pseudo-element driven by the keyboard-open
      // style. Give WebKit one layout frame to publish the new scrollHeight
      // before asking it to reveal the composer.
      revealFrameId = window.requestAnimationFrame(() => {
        revealFrameId = null;
        if (state.keyboardOpen) {
          revealFocusedComposer();
        }
      });
    } else if (!state.keyboardOpen && revealFrameId !== null) {
      window.cancelAnimationFrame(revealFrameId);
      revealFrameId = null;
    }
  };

  const scheduleUpdate = () => {
    // Keep committed keyboard geometry live during animation and caret-driven
    // viewport panning.
    if (scheduledFrameId === null) {
      scheduledFrameId = window.requestAnimationFrame(() => {
        scheduledFrameId = null;
        update(false);
      });
    }

    // Standalone WebKit can publish its final offsetTop without another event.
    // The short trailing read also prevents the first stale resize sample from
    // moving the page before the native focus pan has settled.
    cancelSettledUpdate();
    const settledSignal = resetSettledSignal();
    settledTimerSignal = settledSignal;
    detach(
      commitSettledUpdate(settledSignal),
      Reason.DomCallback,
      "visual viewport settle",
    );
  };

  const scheduleBaselineReset = () => {
    state.resetBaselineOnSettle = true;
    state.keyboardOpen = false;
    cancelSettledUpdate();
    setKeyboardClosed();

    // Some WebKit versions emit orientationchange before the new viewport
    // metrics and others emit it afterwards. Commit immediately only for the
    // latter; otherwise the following VisualViewport resize starts settling.
    if (
      Math.abs(readLayoutViewportHeight(viewport) - state.baselineHeight) >
      LAYOUT_VIEWPORT_CHANGE_TOLERANCE_PX
    ) {
      scheduleUpdate();
    }
  };

  viewport.addEventListener("resize", scheduleUpdate);
  viewport.addEventListener("scroll", scheduleUpdate);
  window.addEventListener("orientationchange", scheduleBaselineReset);
  document.addEventListener("focusin", scheduleUpdate);
  document.addEventListener("focusout", scheduleUpdate);
  update(false);

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    signal.removeEventListener("abort", cleanup);
    viewport.removeEventListener("resize", scheduleUpdate);
    viewport.removeEventListener("scroll", scheduleUpdate);
    window.removeEventListener("orientationchange", scheduleBaselineReset);
    document.removeEventListener("focusin", scheduleUpdate);
    document.removeEventListener("focusout", scheduleUpdate);
    if (scheduledFrameId !== null) {
      window.cancelAnimationFrame(scheduledFrameId);
    }
    if (revealFrameId !== null) {
      window.cancelAnimationFrame(revealFrameId);
    }
    cancelSettledUpdate();
    setKeyboardClosed();
  };
  signal.addEventListener("abort", cleanup, { once: true });
  return cleanup;
}
