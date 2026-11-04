import { command, computed, state } from "ccstate";
import { authenticatedSessionKey$ } from "../auth.ts";
import { rootSignal$, rootVersion$ } from "../root-signal.ts";
import { detach, onRef, Reason } from "../utils.ts";
import { projects$, renameProject$ } from "./projects.ts";

export interface ProjectInlineRename {
  readonly projectId: string;
  readonly folderId: string;
}

const renameState$ = computed((get) => {
  get(authenticatedSessionKey$);
  get(rootVersion$);
  return state<ProjectInlineRename | null>(null);
});

export const projectInlineRename$ = computed((get) => {
  return get(get(renameState$));
});

export const startProjectInlineRename$ = command(
  ({ get, set }, projectId: string, folderId: string) => {
    set(get(renameState$), { projectId, folderId });
  },
);

export const cancelProjectInlineRename$ = command(
  ({ get, set }, edit: ProjectInlineRename) => {
    if (get(projectInlineRename$) === edit) {
      set(get(renameState$), null);
    }
  },
);

export const commitProjectInlineRename$ = command(
  async (
    { get, set },
    edit: ProjectInlineRename,
    value: string,
    signal: AbortSignal,
  ) => {
    // Escape clears the edit before blur, and unmount can follow blur. Only
    // the active edit owns the save, including when another folder is edited.
    if (get(projectInlineRename$) !== edit) {
      return;
    }
    set(get(renameState$), null);
    const name = value.trim();
    const project = get(projects$).find((item) => {
      return item.id === edit.projectId;
    });
    if (!project || !name || name === project.name.trim()) {
      return;
    }
    await set(renameProject$, edit.projectId, name, signal);
  },
);

export const projectInlineRenameInputRef$ = onRef(
  command(({ get, set }, input: HTMLInputElement, signal: AbortSignal) => {
    const edit = get(projectInlineRename$);
    if (!edit) {
      return;
    }
    input.focus();
    input.select();
    const rootSignal = get(rootSignal$);
    signal.addEventListener(
      "abort",
      () => {
        // An unmounted field does not blur. StrictMode ref replay keeps the
        // node connected, so it must not end the edit.
        queueMicrotask(() => {
          if (!input.isConnected) {
            detach(
              set(commitProjectInlineRename$, edit, input.value, rootSignal),
              Reason.DomCallback,
            );
          }
        });
      },
      { once: true },
    );
  }),
);
