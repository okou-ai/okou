import { command } from "ccstate";
import { GLOBAL_KEYBOARD_SHORTCUTS } from "../../lib/global-keyboard-shortcuts.ts";
import { setupGlobalShortcut } from "../../lib/setup-global-shortcut.ts";
import { shouldHandleShortcutPress } from "../okou-page/nav.ts";
import { pageSignal$ } from "../page-signal.ts";
import { selectedProjectId$ } from "./project-navigation.ts";
import { projects$, setProjectArchived$ } from "./projects.ts";

export const setupProjectArchiveShortcut$ = command(
  ({ get, set }, signal: AbortSignal) => {
    return setupGlobalShortcut(
      {
        [GLOBAL_KEYBOARD_SHORTCUTS.toggleArchive.binding]: {
          allowInEditableTarget: true,
          shouldHandle: (event) => {
            const projectId = get(selectedProjectId$);
            const menu = document.querySelector<HTMLElement>('[role="menu"]');
            return (
              projectId !== null &&
              shouldHandleShortcutPress(event) &&
              (!menu || menu.dataset.projectMenuContentId === projectId)
            );
          },
          run: async () => {
            const projectId = get(selectedProjectId$);
            const project = get(projects$).find((item) => {
              return item.id === projectId;
            });
            if (project) {
              await set(
                setProjectArchived$,
                project.id,
                !project.archived,
                get(pageSignal$),
              );
            }
          },
        },
      },
      signal,
    );
  },
);
