import type { GlobalShortcutBindings } from "./setup-global-shortcut.ts";

export const COLLAPSE_PROJECT_SHORTCUT = "mod+shift+arrowleft";
export const EXPAND_PROJECT_SHORTCUT = "mod+shift+arrowright";

/**
 * A text control keeps these keys for selecting to the line edge while it
 * holds text. An empty one has nothing to select, so the keys fold the
 * Project there, as the vertical list shortcuts work from the composer.
 */
function targetLeavesKeysToProject(event: KeyboardEvent): boolean {
  const target = event.target;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement
  ) {
    return target.value === "";
  }
  if (target instanceof HTMLElement && target.isContentEditable) {
    return target.textContent === "";
  }
  return true;
}

export function projectFoldShortcutBindings(
  setExpanded: (expanded: boolean) => void | Promise<void>,
): GlobalShortcutBindings {
  return {
    [COLLAPSE_PROJECT_SHORTCUT]: {
      allowInEditableTarget: true,
      shouldHandle: targetLeavesKeysToProject,
      run: () => {
        return setExpanded(false);
      },
    },
    [EXPAND_PROJECT_SHORTCUT]: {
      allowInEditableTarget: true,
      shouldHandle: targetLeavesKeysToProject,
      run: () => {
        return setExpanded(true);
      },
    },
  };
}
