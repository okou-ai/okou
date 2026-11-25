import { command } from "ccstate";
import { GLOBAL_KEYBOARD_SHORTCUTS } from "../../lib/global-keyboard-shortcuts.ts";
import { projectActionShortcutId } from "../../lib/list-shortcut-owner.ts";
import { setupGlobalShortcut } from "../../lib/setup-global-shortcut.ts";
import { shouldHandleShortcutPress } from "../okou-page/nav.ts";
import { pageSignal$ } from "../page-signal.ts";
import { selectedProjectId$ } from "./project-navigation.ts";
import { openProjectEditor$ } from "./project-ui.ts";
import { projects$, setProjectArchived$ } from "./projects.ts";

export const setupProjectActionShortcuts$ = command(
  ({ get, set }, archiveEnabled: boolean, signal: AbortSignal) => {
    const targetProject = (event: KeyboardEvent) => {
      const id = projectActionShortcutId(event.target, get(selectedProjectId$));
      return get(projects$).find((project) => {
        return project.id === id;
      });
    };
    const shouldHandle = (event: KeyboardEvent) => {
      return (
        shouldHandleShortcutPress(event) && targetProject(event) !== undefined
      );
    };
    return setupGlobalShortcut(
      {
        [GLOBAL_KEYBOARD_SHORTCUTS.rename.binding]: {
          allowInEditableTarget: true,
          shouldHandle,
          run: (event) => {
            const project = targetProject(event);
            if (project) {
              set(openProjectEditor$, { projectId: project.id }, project.name);
            }
          },
        },
        [GLOBAL_KEYBOARD_SHORTCUTS.toggleArchive.binding]: {
          allowInEditableTarget: true,
          shouldHandle: (event) => {
            return archiveEnabled && shouldHandle(event);
          },
          run: async (event) => {
            const project = targetProject(event);
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
