import { command } from "ccstate";
import { GLOBAL_KEYBOARD_SHORTCUTS } from "../../lib/global-keyboard-shortcuts.ts";
import { setupGlobalShortcut } from "../../lib/setup-global-shortcut.ts";
import { projectOrderShortcutOwner } from "../../lib/project-order-shortcut-owner.ts";
import { shouldHandleShortcutPress } from "../okou-page/nav.ts";
import { selectedProjectId$ } from "./project-navigation.ts";
import { stepProject$ } from "./project-order.ts";

export const setupProjectOrderShortcuts$ = command(
  (
    { get, set },
    projectIds: readonly string[],
    reorderEnabled: boolean,
    signal: AbortSignal,
  ) => {
    const targetProjectId = (event: KeyboardEvent) => {
      const owner = projectOrderShortcutOwner(event.target);
      return owner
        ? owner.kind === "project"
          ? owner.projectId
          : null
        : get(selectedProjectId$);
    };
    const shouldHandle = (event: KeyboardEvent) => {
      if (!shouldHandleShortcutPress(event) || !reorderEnabled) {
        return false;
      }
      // An unrelated menu retains its own keys, even on a Project page.
      if (
        document.querySelector('[role="menu"]') &&
        !(
          event.target instanceof Element &&
          event.target.closest("[data-project-menu-content-id]")
        )
      ) {
        return false;
      }
      const id = targetProjectId(event);
      return id !== null && projectIds.includes(id);
    };
    const move = async (event: KeyboardEvent, direction: -1 | 1) => {
      const id = targetProjectId(event);
      if (id) {
        await set(stepProject$, id, direction, signal);
      }
    };
    return setupGlobalShortcut(
      {
        [GLOBAL_KEYBOARD_SHORTCUTS.moveChatPinUp.binding]: {
          allowInEditableTarget: true,
          shouldHandle,
          run: (event) => {
            return move(event, -1);
          },
        },
        [GLOBAL_KEYBOARD_SHORTCUTS.moveChatPinDown.binding]: {
          allowInEditableTarget: true,
          shouldHandle,
          run: (event) => {
            return move(event, 1);
          },
        },
      },
      signal,
    );
  },
);
