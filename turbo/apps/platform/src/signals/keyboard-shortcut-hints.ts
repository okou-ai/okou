import { command, computed, state } from "ccstate";
import { delay } from "signal-timers";
import { onDomEventFn, resetSignal } from "./utils.ts";

const internalKeyboardShortcutHintPhase$ = state<
  "idle" | "pending" | "visible"
>("idle");
const resetKeyboardShortcutHintHold$ = resetSignal();
const resetShortcutHintSignal$ = resetSignal();

export const keyboardShortcutHintsVisible$ = computed((get) => {
  return get(internalKeyboardShortcutHintPhase$) === "visible";
});

export const hideKeyboardShortcutHints$ = command(({ get, set }) => {
  if (get(internalKeyboardShortcutHintPhase$) === "idle") {
    return;
  }
  set(resetKeyboardShortcutHintHold$);
  set(internalKeyboardShortcutHintPhase$, "idle");
});

const showKeyboardShortcutHints$ = command(
  async ({ set }, signal: AbortSignal) => {
    await delay(500, { signal });
    set(internalKeyboardShortcutHintPhase$, "visible");
  },
);

function shortcutHintModifierHeld(event: KeyboardEvent): boolean {
  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
  return isMac ? event.metaKey : event.ctrlKey && !event.metaKey;
}

function shortcutHintEventEligible(event: KeyboardEvent): boolean {
  return (
    shortcutHintModifierHeld(event) &&
    !event.shiftKey &&
    !event.altKey &&
    !event.isComposing &&
    event.keyCode !== 229 &&
    (event.type !== "keydown" ||
      event.key === "Meta" ||
      event.key === "Control")
  );
}

const startKeyboardShortcutHintHold$ = command(
  ({ get, set }, signal: AbortSignal) => {
    if (get(internalKeyboardShortcutHintPhase$) !== "idle") {
      return;
    }
    const holdSignal = set(resetKeyboardShortcutHintHold$, signal);
    set(internalKeyboardShortcutHintPhase$, "pending");
    return set(showKeyboardShortcutHints$, holdSignal);
  },
);

const updateKeyboardShortcutHintModifiers$ = command(
  ({ set }, event: KeyboardEvent, hintSignal: AbortSignal) => {
    if (!shortcutHintModifierHeld(event)) {
      set(resetShortcutHintSignal$);
      return;
    }
    if (!shortcutHintEventEligible(event)) {
      set(hideKeyboardShortcutHints$);
      return;
    }
    if (event.repeat) {
      return;
    }
    return set(startKeyboardShortcutHintHold$, hintSignal);
  },
);

const startKeyboardShortcutHint$ = command(
  ({ get, set }, event: KeyboardEvent, signal: AbortSignal) => {
    if (
      get(internalKeyboardShortcutHintPhase$) !== "idle" ||
      !shortcutHintEventEligible(event) ||
      event.repeat
    ) {
      return;
    }

    signal.throwIfAborted();
    const hintSignal = set(resetShortcutHintSignal$, signal);
    hintSignal.addEventListener(
      "abort",
      () => {
        set(hideKeyboardShortcutHints$);
      },
      { once: true },
    );
    const updateModifiers = onDomEventFn((nextEvent: KeyboardEvent) => {
      return set(updateKeyboardShortcutHintModifiers$, nextEvent, hintSignal);
    });
    const resetHint = onDomEventFn(() => {
      set(resetShortcutHintSignal$);
    });
    document.addEventListener("keydown", updateModifiers, {
      capture: true,
      signal: hintSignal,
    });
    document.addEventListener("keyup", updateModifiers, {
      capture: true,
      signal: hintSignal,
    });
    window.addEventListener("blur", resetHint, { signal: hintSignal });
    return set(startKeyboardShortcutHintHold$, hintSignal);
  },
);

export const setupKeyboardShortcutHints$ = command(
  ({ set }, signal: AbortSignal) => {
    const startHint = onDomEventFn((event: KeyboardEvent) => {
      return set(startKeyboardShortcutHint$, event, signal);
    });
    document.addEventListener("keydown", startHint, {
      capture: true,
      signal,
    });
  },
);
