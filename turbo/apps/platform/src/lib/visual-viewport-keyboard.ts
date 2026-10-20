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
const KEYBOARD_VIEWPORT_HEIGHT_PROPERTY = "--okou-keyboard-viewport-height";
const KEYBOARD_VIEWPORT_TOP_PROPERTY = "--okou-keyboard-viewport-top";
const KEYBOARD_VIEWPORT_CHANGE_EVENT = "okou:keyboard-viewport-change";
const STANDALONE_DISPLAY_MODE_QUERY = "(display-mode: standalone)";
const COARSE_POINTER_QUERY = "(pointer: coarse)";
const FINE_POINTER_QUERY = "(any-pointer: fine)";

// Consumers restore their reading anchors after the shell has adopted the
// measured viewport, including the trailing sample after keyboard animation.
export const VIEWPORT_LAYOUT_EVENT = "okou:viewport-layout";

export function isPwaKeyboardViewportEnabled(): boolean {
  return (
    document.documentElement.dataset.pwaKeyboardViewport === "true" &&
    window.matchMedia(STANDALONE_DISPLAY_MODE_QUERY).matches
  );
}

/** The mounted shell projects its resolved feature switch onto the document. */
export function setPwaKeyboardViewportEnabled(enabled: boolean): void {
  const root = document.documentElement;
  if ((root.dataset.pwaKeyboardViewport === "true") === enabled) {
    return;
  }
  if (enabled) {
    root.dataset.pwaKeyboardViewport = "true";
  } else {
    delete root.dataset.pwaKeyboardViewport;
  }
  document.dispatchEvent(new Event(KEYBOARD_VIEWPORT_CHANGE_EVENT));
}

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

function setKeyboardOpen(
  viewport: VisualViewport,
  keyboardOcclusion: number,
  viewportLayoutEnabled: boolean,
): void {
  const root = document.documentElement;
  root.dataset.keyboardOpen = "true";
  if (!viewportLayoutEnabled) {
    root.style.setProperty(
      KEYBOARD_SCROLL_RESERVE_PROPERTY,
      `${keyboardOcclusion + COMPOSER_KEYBOARD_GAP_PX}px`,
    );
    return;
  }
  if (Math.abs(viewport.scale - 1) > 0.01) {
    // Pinch zoom changes the visible region without changing the layout.
    // Keep the last unzoomed keyboard geometry so magnification can pan it.
    return;
  }
  root.style.setProperty(
    KEYBOARD_VIEWPORT_HEIGHT_PROPERTY,
    `${viewport.height}px`,
  );
  root.style.setProperty(
    KEYBOARD_VIEWPORT_TOP_PROPERTY,
    // Match the absolute shell's document coordinate system directly.
    // WebKit can include visual panning in scrollY, so adding offsetTop
    // would count the keyboard's focus pan twice.
    `${Math.max(0, viewport.pageTop)}px`,
  );
}

function setKeyboardClosed(): void {
  const root = document.documentElement;
  delete root.dataset.keyboardOpen;
  root.style.removeProperty(KEYBOARD_SCROLL_RESERVE_PROPERTY);
  root.style.removeProperty(KEYBOARD_VIEWPORT_HEIGHT_PROPERTY);
  root.style.removeProperty(KEYBOARD_VIEWPORT_TOP_PROPERTY);
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
  // Retain the existing real-scroll caret workaround outside the rollout.
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
  revealFrameId: number | null;
};

function updateKeyboardViewportState(
  state: KeyboardViewportState,
  viewport: VisualViewport,
  commitOpening: boolean,
  viewportLayoutEnabled: boolean,
): void {
  if (state.resetBaselineOnSettle) {
    if (!commitOpening) {
      return;
    }
    state.baselineHeight = readLayoutViewportHeight(viewport);
    state.keyboardOpen = false;
    state.resetBaselineOnSettle = false;
  }

  if (commitOpening && viewportLayoutEnabled) {
    // The document retains its layout height while only the PWA shell is
    // resized. A changed layout viewport is a window/orientation resize (or a
    // browser already resizing content), not additional keyboard occlusion.
    state.baselineHeight = readLayoutViewportHeight(viewport);
  }

  if (!isTextEntryElement(document.activeElement)) {
    if (commitOpening) {
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
  setKeyboardOpen(
    viewport,
    readKeyboardOcclusion(state.baselineHeight, viewport),
    viewportLayoutEnabled,
  );
}

function updateKeyboardLayout(
  state: KeyboardViewportState,
  viewport: VisualViewport,
  commitOpening: boolean,
): void {
  const viewportLayoutEnabled = isPwaKeyboardViewportEnabled();
  const keyboardWasOpen = state.keyboardOpen;
  updateKeyboardViewportState(
    state,
    viewport,
    commitOpening,
    viewportLayoutEnabled,
  );
  if (viewportLayoutEnabled) {
    document.dispatchEvent(new Event(VIEWPORT_LAYOUT_EVENT));
  } else if (!keyboardWasOpen && state.keyboardOpen) {
    if (state.revealFrameId !== null) {
      window.cancelAnimationFrame(state.revealFrameId);
    }
    // Allow the legacy scroll reserve to participate in layout first.
    state.revealFrameId = window.requestAnimationFrame(() => {
      state.revealFrameId = null;
      if (state.keyboardOpen && !isPwaKeyboardViewportEnabled()) {
        revealFocusedComposer();
      }
    });
  }
  if (
    (!state.keyboardOpen || viewportLayoutEnabled) &&
    state.revealFrameId !== null
  ) {
    window.cancelAnimationFrame(state.revealFrameId);
    state.revealFrameId = null;
  }
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
    revealFrameId: null,
  };
  let scheduledFrameId: number | null = null;
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
    updateKeyboardLayout(state, viewport, true);
  };

  const scheduleWindowUpdate = () => {
    if (isPwaKeyboardViewportEnabled()) {
      scheduleUpdate();
    }
  };

  const updateViewportMode = () => {
    cancelSettledUpdate();
    state.keyboardOpen = false;
    setKeyboardClosed();
    updateKeyboardLayout(state, viewport, true);
    if (!isPwaKeyboardViewportEnabled()) {
      document.dispatchEvent(new Event(VIEWPORT_LAYOUT_EVENT));
    }
  };

  const scheduleUpdate = () => {
    // Keep committed keyboard geometry live during animation and caret-driven
    // viewport panning.
    if (scheduledFrameId === null) {
      scheduledFrameId = window.requestAnimationFrame(() => {
        scheduledFrameId = null;
        updateKeyboardLayout(state, viewport, false);
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
    if (isPwaKeyboardViewportEnabled()) {
      document.dispatchEvent(new Event(VIEWPORT_LAYOUT_EVENT));
    }

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
  window.addEventListener("scroll", scheduleWindowUpdate);
  window.addEventListener("resize", scheduleWindowUpdate);
  document.addEventListener(KEYBOARD_VIEWPORT_CHANGE_EVENT, updateViewportMode);
  window.addEventListener("orientationchange", scheduleBaselineReset);
  document.addEventListener("focusin", scheduleUpdate);
  document.addEventListener("focusout", scheduleUpdate);
  updateKeyboardLayout(state, viewport, false);

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    signal.removeEventListener("abort", cleanup);
    viewport.removeEventListener("resize", scheduleUpdate);
    viewport.removeEventListener("scroll", scheduleUpdate);
    window.removeEventListener("scroll", scheduleWindowUpdate);
    window.removeEventListener("resize", scheduleWindowUpdate);
    document.removeEventListener(
      KEYBOARD_VIEWPORT_CHANGE_EVENT,
      updateViewportMode,
    );
    window.removeEventListener("orientationchange", scheduleBaselineReset);
    document.removeEventListener("focusin", scheduleUpdate);
    document.removeEventListener("focusout", scheduleUpdate);
    if (scheduledFrameId !== null) {
      window.cancelAnimationFrame(scheduledFrameId);
    }
    if (state.revealFrameId !== null) {
      window.cancelAnimationFrame(state.revealFrameId);
    }
    cancelSettledUpdate();
    setKeyboardClosed();
  };
  signal.addEventListener("abort", cleanup, { once: true });
  return cleanup;
}
