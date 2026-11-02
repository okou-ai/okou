import { command, computed, state } from "ccstate";
export type ProjectDialog =
  | {
      readonly kind: "editor";
      readonly projectId?: string;
      readonly fromThreadId?: string;
    }
  | { readonly kind: "membership"; readonly threadId: string }
  | { readonly kind: "delete"; readonly projectId: string };
const internalDialog$ = state<ProjectDialog | null>(null);
export const projectDialog$ = computed((get) => {
  return get(internalDialog$);
});
export const setProjectDialog$ = command(
  ({ set }, value: ProjectDialog | null) => {
    set(internalDialog$, value);
  },
);
const internalName$ = state("");
export const projectEditorName$ = computed((get) => {
  return get(internalName$);
});
export const setProjectEditorName$ = command(({ set }, value: string) => {
  set(internalName$, value);
});
const internalArchive$ = state(false);
export const projectArchiveFilter$ = computed((get) => {
  return get(internalArchive$);
});
export const setProjectArchiveFilter$ = command(({ set }, value: boolean) => {
  set(internalArchive$, value);
});
export const openProjectEditor$ = command(
  (
    { set },
    options: {
      readonly projectId?: string;
      readonly fromThreadId?: string;
    } = {},
    name = "",
  ) => {
    set(internalName$, name);
    set(internalDialog$, { kind: "editor", ...options });
  },
);
export const closeProjectDialog$ = command(
  ({ get, set }, expected: ProjectDialog) => {
    if (get(projectDialog$) === expected) {
      set(internalDialog$, null);
    }
  },
);
export const resetProjectUi$ = command(({ set }) => {
  set(internalDialog$, null);
  set(internalName$, "");
  set(internalArchive$, false);
});
