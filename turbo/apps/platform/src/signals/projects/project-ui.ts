import { command, computed, state } from "ccstate";
export type ProjectDialog =
  | {
      readonly kind: "editor";
      readonly projectId?: string;
      readonly fromThreadId?: string;
      readonly open: boolean;
    }
  | {
      readonly kind: "membership";
      readonly threadId: string;
      readonly anchor: HTMLElement;
      readonly open: boolean;
    }
  | { readonly kind: "delete"; readonly projectId: string };
const internalDialog$ = state<ProjectDialog | null>(null);
export const projectDialog$ = computed((get) => {
  const dialog = get(internalDialog$);
  return dialog && dialog.kind !== "delete" && !dialog.open ? null : dialog;
});
// Let Base UI finish closing and restore focus after a moved row mounts.
export const projectDialogSession$ = computed((get) => {
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
const internalSearch$ = state("");
export const projectSearch$ = computed((get) => {
  return get(internalSearch$);
});
export const setProjectSearch$ = command(({ set }, value: string) => {
  return set(internalSearch$, value);
});
const activeThreadMenu$ = state<{
  readonly threadId: string;
  readonly anchor: HTMLElement;
} | null>(null);
export const projectThreadMenuOpenChanged$ = command(
  (
    { get, set },
    threadId: string,
    open: boolean,
    trigger: Element | undefined,
  ) => {
    if (open && trigger instanceof HTMLElement) {
      set(activeThreadMenu$, { threadId, anchor: trigger });
    } else if (
      !open &&
      get(activeThreadMenu$)?.threadId === threadId &&
      !get(internalDialog$)
    ) {
      set(activeThreadMenu$, null);
    }
  },
);
export const openProjectMembership$ = command(
  ({ get, set }, threadId: string) => {
    const menu = get(activeThreadMenu$);
    if (!menu || menu.threadId !== threadId) {
      throw new Error("Project membership requires its active Thread menu");
    }
    set(internalSearch$, "");
    set(internalDialog$, {
      kind: "membership",
      threadId,
      anchor: menu.anchor,
      open: true,
    });
  },
);
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
    set(internalDialog$, { kind: "editor", ...options, open: true });
  },
);
export const closeProjectDialog$ = command(
  ({ get, set }, expected: ProjectDialog) => {
    if (get(projectDialog$) === expected) {
      set(
        internalDialog$,
        expected.kind === "delete" ? null : { ...expected, open: false },
      );
      set(activeThreadMenu$, null);
    }
  },
);
export const completeProjectDialogClose$ = command(
  ({ get, set }, expected: Exclude<ProjectDialog, { kind: "delete" }>) => {
    if (get(internalDialog$) === expected && !expected.open) {
      set(internalDialog$, null);
    }
  },
);
export const resetProjectUi$ = command(({ set }) => {
  set(activeThreadMenu$, null);
  set(internalDialog$, null);
  set(internalName$, "");
  set(internalSearch$, "");
});

export const projectDialogHasSuccessor$ = command(
  ({ get }, expected: ProjectDialog) => {
    const current = get(projectDialog$);
    return current !== null && current !== expected;
  },
);
