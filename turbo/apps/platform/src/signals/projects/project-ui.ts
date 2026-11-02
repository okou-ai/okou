import { command, state } from "ccstate";
export type ProjectDialog =
  | {
      readonly kind: "editor";
      readonly projectId?: string;
      readonly fromThreadId?: string;
    }
  | { readonly kind: "membership"; readonly threadId: string }
  | { readonly kind: "delete"; readonly projectId: string };
export const projectDialog$ = state<ProjectDialog | null>(null);
export const projectEditorName$ = state("");
export const projectArchiveFilter$ = state(false);
export const openProjectEditor$ = command(
  (
    { set },
    options: {
      readonly projectId?: string;
      readonly fromThreadId?: string;
    } = {},
    name = "",
  ) => {
    set(projectEditorName$, name);
    set(projectDialog$, { kind: "editor", ...options });
  },
);
export const closeProjectDialog$ = command(
  ({ get, set }, expected: ProjectDialog) => {
    if (get(projectDialog$) === expected) {
      set(projectDialog$, null);
    }
  },
);
export const resetProjectUi$ = command(({ set }) => {
  set(projectDialog$, null);
  set(projectEditorName$, "");
  set(projectArchiveFilter$, false);
});
