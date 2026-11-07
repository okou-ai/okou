import { command, computed, state, type Command, type Computed } from "ccstate";
import type { ComposerTask } from "./composer-task-chips.ts";
import type {
  WorkflowRecommendationActions,
  WorkflowRecommendationDraft,
} from "./composer-workflow-recommendations.ts";

export type HomeWorkflowKind = "scheduled" | "triggers" | "advanced";
export type HomeExploreKind = "search" | "research";

/** Discovery is local to each composer; dismissing it keeps the draft intact. */
export function createComposerHomeSignals(
  selectedTask$: Computed<ComposerTask | null>,
  openTask$: Command<void, [ComposerTask]>,
  selectTask$: Command<void, [ComposerTask | null]>,
  actions: WorkflowRecommendationActions,
  closeWorkflow$: Command<void, []>,
) {
  const internalVisible$ = state(true);
  const internalExploreKind$ = state<HomeExploreKind | null>(null);
  const internalWorkflowKind$ = state<HomeWorkflowKind>("scheduled");
  const task$ = computed((get) => {
    return get(internalVisible$)
      ? (get(internalExploreKind$) ?? get(selectedTask$))
      : null;
  });
  const workflowKind$ = computed((get) => {
    return get(internalWorkflowKind$);
  });
  const show$ = command(({ set }) => {
    set(internalVisible$, true);
    set(internalExploreKind$, null);
  });
  const close$ = command(({ set }) => {
    set(internalVisible$, false);
    set(closeWorkflow$);
    // The initiating capability control has unmounted; the composer remains.
    set(actions.focusEditor$);
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
    workflowKind$,
    show$,
    close$,
    openWorkflow$,
    openExplore$,
    prepareWorkflow$,
    prepareExplore$,
  };
}
