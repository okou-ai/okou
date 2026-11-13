import { command, computed, state, type Command, type Computed } from "ccstate";
import type { ComposerTask } from "./composer-task-chips.ts";
import type {
  WorkflowRecommendationActions,
  WorkflowRecommendationDraft,
} from "./composer-workflow-recommendations.ts";

export type HomeWorkflowKind = "scheduled" | "triggers" | "advanced";
export type HomeExploreKind = "search" | "research";
export type HomeCapability = HomeExploreKind | "create" | "workflow";

/** Discovery and its injected prompts are local to each composer. */
export function createComposerHomeSignals(
  selectedTask$: Computed<ComposerTask | null>,
  openTask$: Command<void, [ComposerTask]>,
  selectTask$: Command<void, [ComposerTask | null]>,
  actions: WorkflowRecommendationActions,
  closeWorkflow$: Command<void, []>,
) {
  const internalVisible$ = state(true);
  const internalMenuOpen$ = state(false);
  const internalExploreKind$ = state<HomeExploreKind | null>(null);
  const internalWorkflowKind$ = state<HomeWorkflowKind>("scheduled");
  const task$ = computed((get) => {
    return get(internalVisible$)
      ? (get(internalExploreKind$) ?? get(selectedTask$))
      : null;
  });
  // Sticky generation settings handed to another composer do not open discovery.
  const menuTask$ = computed((get) => {
    return get(internalMenuOpen$) ? get(task$) : null;
  });
  const workflowKind$ = computed((get) => {
    return get(internalWorkflowKind$);
  });
  const show$ = command(({ set }) => {
    set(internalVisible$, true);
    set(internalExploreKind$, null);
  });
  const dismissMenu$ = command(({ set }) => {
    set(internalMenuOpen$, false);
  });
  const close$ = command(async ({ set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(internalVisible$, false);
    set(internalMenuOpen$, false);
    set(closeWorkflow$);
    const cleared = set(actions.clearPrompt$);
    // The initiating capability control has unmounted; the composer remains.
    set(actions.focusEditor$);
    if (cleared) {
      await set(actions.saveDraft$, signal);
    }
  });
  const openWorkflow$ = command(({ set }, kind: HomeWorkflowKind) => {
    set(internalWorkflowKind$, kind);
    set(openTask$, "workflow");
  });
  const openExplore$ = command(({ set }, kind: HomeExploreKind) => {
    set(closeWorkflow$);
    set(internalVisible$, true);
    set(internalExploreKind$, kind);
  });
  const openCapability$ = command(
    ({ get, set }, capability: HomeCapability) => {
      set(internalMenuOpen$, true);
      switch (capability) {
        case "search":
        case "research": {
          set(openExplore$, capability);
          return;
        }
        case "create": {
          const task = get(selectedTask$);
          set(
            openTask$,
            task !== null && task !== "workflow" ? task : "presentation",
          );
          return;
        }
        case "workflow": {
          set(openWorkflow$, get(workflowKind$));
          return;
        }
      }
    },
  );
  const prepareWorkflow$ = command(
    async (
      { set },
      draft: WorkflowRecommendationDraft,
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted();
      if (draft.template) {
        set(
          actions.insertTemplate$,
          {
            type: "workflow",
            selection: { workflowTemplateId: draft.template.id },
          },
          {
            type: "workflow",
            title: draft.template.title,
            category: "workflow",
          },
        );
      }
      set(actions.insertPrompt$, draft.prompt);
      set(actions.focusEditor$);
      await set(actions.saveDraft$, signal);
    },
  );
  const prepareExplore$ = command(
    async ({ get, set }, prompt: string, signal: AbortSignal) => {
      signal.throwIfAborted();
      const kind = get(internalExploreKind$);
      set(selectTask$, null);
      set(internalExploreKind$, kind);
      set(actions.insertPrompt$, prompt);
      set(actions.focusEditor$);
      await set(actions.saveDraft$, signal);
    },
  );
  return {
    task$,
    menuTask$,
    workflowKind$,
    show$,
    close$,
    dismissMenu$,
    openWorkflow$,
    openExplore$,
    openCapability$,
    prepareWorkflow$,
    prepareExplore$,
  };
}
