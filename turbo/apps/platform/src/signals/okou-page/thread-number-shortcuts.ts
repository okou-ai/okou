import { command, computed, state } from "ccstate";
import { matchShortcut } from "@okouai/ui";
import {
  hideKeyboardShortcutHints$,
  keyboardShortcutHintsVisible$,
} from "../keyboard-shortcut-hints.ts";
import { onDomEventFn } from "../utils.ts";

const standaloneDisplayMode$ = state(false);

export const threadNumberShortcutModifier$ = computed(() => {
  // Safari's macOS web apps consume Command+1-9 before dispatching DOM events.
  // iPadOS can report a Macintosh user agent, but has multiple touch points.
  return /Macintosh.*Version\/[\d.]+.*Safari\//.test(navigator.userAgent) &&
    navigator.maxTouchPoints <= 1
    ? "ctrl+mod"
    : "mod";
});

export const threadNumberShortcutsEnabled$ = computed((get) => {
  return get(standaloneDisplayMode$);
});

export const threadNumberShortcutHintsVisible$ = computed((get) => {
  return (
    get(threadNumberShortcutsEnabled$) && get(keyboardShortcutHintsVisible$)
  );
});

export const setupThreadNumberShortcuts$ = command(
  ({ set }, signal: AbortSignal) => {
    const displayModes = [
      window.matchMedia("(display-mode: standalone)"),
      window.matchMedia("(display-mode: window-controls-overlay)"),
    ];
    const updateDisplayMode = onDomEventFn(() => {
      set(
        standaloneDisplayMode$,
        displayModes.some((mode) => {
          return mode.matches;
        }),
      );
      set(hideKeyboardShortcutHints$);
    });
    updateDisplayMode(undefined);
    for (const mode of displayModes) {
      mode.addEventListener("change", updateDisplayMode, { signal });
    }
  },
);

export const threadNumberShortcutIndex$ = command(
  ({ get }, event: KeyboardEvent): number | undefined => {
    if (
      !get(threadNumberShortcutsEnabled$) ||
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      event.keyCode === 229
    ) {
      return undefined;
    }
    const modifier = get(threadNumberShortcutModifier$);
    for (let index = 0; index < 9; index++) {
      if (matchShortcut(`${modifier}+${index + 1}`, event)) {
        return index;
      }
    }
    return undefined;
  },
);
