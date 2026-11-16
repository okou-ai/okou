import { command } from "ccstate";
import { GLOBAL_KEYBOARD_SHORTCUTS } from "../../lib/global-keyboard-shortcuts.ts";
import { setupGlobalShortcut } from "../../lib/setup-global-shortcut.ts";
import { currentChatThreadId$ } from "../agent-chat.ts";
import { eventDrivenChatThreads$ } from "../chat-page/chat-thread-event-sourcing.ts";
import { projectRowKey } from "../chat-page/chat-thread-list-rows.ts";
import { scrollToChatListRow$ } from "../chat-page/sidebar-chat-thread-scroll.ts";
import { shouldHandleShortcutPress } from "../okou-page/nav.ts";
import { setProjectExpandedWithMotion$ } from "./project-fold.ts";
import { selectedProjectId$ } from "./project-navigation.ts";
import { projects$ } from "./projects.ts";

/**
 * A text control keeps these keys for selecting to the line edge while it
 * holds text. An empty one has nothing to select, so the keys fold the
 * Project there, as the vertical list shortcuts work from the composer.
 */
function targetLeavesKeysToProject(target: EventTarget | null): boolean {
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

function projectMenuOwns(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("[data-project-menu-content-id]") !== null
  );
}

/**
 * Mod+Shift+Left and Right fold the Project whose menu or list row holds
 * focus, otherwise the Project of the current Project page or chat.
 */
export const setupProjectFoldShortcuts$ = command(
  ({ get, set }, signal: AbortSignal) => {
    const threadProjectId = (threadId: string) => {
      return (
        get(eventDrivenChatThreads$).find((thread) => {
          return thread.id === threadId;
        })?.projectId ?? null
      );
    };
    const targetProjectId = (target: EventTarget | null): string | null => {
      const owner =
        target instanceof Element
          ? target.closest<HTMLElement>(
              "[data-project-menu-content-id], [data-project-row-id], [data-sidebar-chat-thread-row-id], [data-chat-thread-container-id]",
            )
          : null;
      if (owner) {
        const projectId =
          owner.dataset.projectMenuContentId ?? owner.dataset.projectRowId;
        const threadId =
          owner.dataset.sidebarChatThreadRowId ??
          owner.dataset.chatThreadContainerId;
        return projectId ?? (threadId ? threadProjectId(threadId) : null);
      }
      const currentThreadId = get(currentChatThreadId$);
      return (
        get(selectedProjectId$) ??
        (currentThreadId ? threadProjectId(currentThreadId) : null)
      );
    };
    const listedProjectId = (event: KeyboardEvent): string | null => {
      const projectId = targetProjectId(event.target);
      return projectId &&
        get(projects$).some((project) => {
          return project.id === projectId;
        })
        ? projectId
        : null;
    };
    const shouldHandle = (event: KeyboardEvent) => {
      return (
        shouldHandleShortcutPress(event) &&
        targetLeavesKeysToProject(event.target) &&
        // A different menu owns its keyboard.
        (document.querySelector('[role="menu"]') === null ||
          projectMenuOwns(event.target)) &&
        listedProjectId(event) !== null
      );
    };

    setupGlobalShortcut(
      {
        [GLOBAL_KEYBOARD_SHORTCUTS.collapseProject.binding]: {
          allowInEditableTarget: true,
          shouldHandle,
          run: async (event) => {
            const projectId = listedProjectId(event);
            if (!projectId) {
              return;
            }
            await set(setProjectExpandedWithMotion$, projectId, false, signal);
            // The Project's row replaces a hidden chat as the list's place.
            await set(
              scrollToChatListRow$,
              { key: projectRowKey(projectId), align: "top" },
              signal,
            );
          },
        },
        [GLOBAL_KEYBOARD_SHORTCUTS.expandProject.binding]: {
          allowInEditableTarget: true,
          shouldHandle,
          run: async (event) => {
            const projectId = listedProjectId(event);
            if (projectId) {
              await set(setProjectExpandedWithMotion$, projectId, true, signal);
            }
          },
        },
      },
      signal,
    );
  },
);
