import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { restoreChatLayoutScroll$ } from "../chat-page/chat-layout.ts";
import { createDeferredPromise } from "../utils.ts";
import type { ComposerTask } from "./composer-task-chips.ts";
import type {
  WorkflowRecommendationActions,
  WorkflowRecommendationDraft,
} from "./composer-workflow-recommendations.ts";

export type HomeWorkflowKind = "scheduled" | "triggers" | "advanced";
export type HomeExploreKind = "search" | "research";
export type HomeCapability = HomeExploreKind | "create" | "workflow";

/** A source action waits for its own mounted composer before restoring reading intent. */
function createCapabilityLayoutSignals() {
  const root$ = state<{ readonly element: HTMLElement } | null>(null);
  const request$ = state<ReturnType<typeof createDeferredPromise<void>> | null>(
    null,
  );
  const mount$ = command(
    ({ get, set }, element: HTMLElement, signal: AbortSignal) => {
      const root = { element };
      set(root$, root);
      signal.addEventListener(
        "abort",
        () => {
          if (get(root$) === root) {
            set(root$, null);
            const request = get(request$);
            if (request && !request.settled()) {
              request.resolve();
            }
          }
        },
        { once: true },
      );
    },
  );
  const sync$ = command(async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const root = get(root$);
    if (!root?.element.isConnected) {
      return;
    }
    const request = createDeferredPromise<void>(signal);
    // A newer action supersedes an unpainted layout without stranding its caller.
    const previous = get(request$);
    if (previous && !previous.settled()) {
      previous.resolve();
    }
    set(request$, request);
    await request.promise;
    signal.throwIfAborted();
    if (get(root$) === root && get(request$) === request) {
      await set(restoreChatLayoutScroll$, signal);
    }
  });
  const commit$ = command(
    (
      { get },
      request: NonNullable<ReturnType<typeof createDeferredPromise<void>>>,
    ) => {
      if (get(request$) === request && !request.settled()) {
        request.resolve();
      }
    },
  );
  return { request$, mount$, sync$, commit$ };
}

function createPrepareWorkflowCommand(actions: WorkflowRecommendationActions) {
  return command(
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
}

function createPrepareExploreCommand(
  exploreKind$: State<HomeExploreKind | null>,
  selectTask$: Command<void, [ComposerTask | null]>,
  actions: WorkflowRecommendationActions,
) {
  return command(async ({ get, set }, prompt: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    const kind = get(exploreKind$);
    set(selectTask$, null);
    set(exploreKind$, kind);
    set(actions.insertPrompt$, prompt);
    set(actions.focusEditor$);
    await set(actions.saveDraft$, signal);
  });
}

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
  const internalMenuRevision$ = state(0);
  const layout = createCapabilityLayoutSignals();
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
  const menuRevision$ = computed((get) => {
    return get(internalMenuRevision$);
  });
  const workflowKind$ = computed((get) => {
    return get(internalWorkflowKind$);
  });
  const show$ = command(({ set }) => {
    set(internalVisible$, true);
    set(internalExploreKind$, null);
  });
  const dismissMenu$ = command(
    async ({ get, set }, revision: number, signal: AbortSignal) => {
      if (get(internalMenuOpen$) && get(internalMenuRevision$) === revision) {
        set(internalMenuOpen$, false);
        await set(layout.sync$, signal);
      }
    },
  );
  const close$ = command(async ({ set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(internalVisible$, false);
    set(internalMenuOpen$, false);
    set(closeWorkflow$);
    const cleared = set(actions.clearPrompt$);
    // The initiating capability control has unmounted; the composer remains.
    set(actions.focusEditor$);
    await set(layout.sync$, signal);
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
  const openCreation$ = command(
    async ({ set }, task: ComposerTask, signal: AbortSignal) => {
      set(internalMenuRevision$, (revision) => {
        return revision + 1;
      });
      set(openTask$, task);
      await set(layout.sync$, signal);
    },
  );
  const selectWorkflowKind$ = command(
    async ({ set }, kind: HomeWorkflowKind, signal: AbortSignal) => {
      set(internalMenuRevision$, (revision) => {
        return revision + 1;
      });
      set(openWorkflow$, kind);
      await set(layout.sync$, signal);
    },
  );
  const openCapability$ = command(
    async ({ get, set }, capability: HomeCapability, signal: AbortSignal) => {
      set(internalMenuOpen$, true);
      set(internalMenuRevision$, (revision) => {
        return revision + 1;
      });
      switch (capability) {
        case "search":
        case "research": {
          set(openExplore$, capability);
          break;
        }
        case "create": {
          const task = get(selectedTask$);
          set(
            openTask$,
            task !== null && task !== "workflow" ? task : "presentation",
          );
          break;
        }
        case "workflow": {
          set(openWorkflow$, get(workflowKind$));
          break;
        }
      }
      await set(layout.sync$, signal);
    },
  );
  return {
    task$,
    menuTask$,
    menuRevision$,
    layout,
    workflowKind$,
    show$,
    close$,
    dismissMenu$,
    openWorkflow$,
    openExplore$,
    openCreation$,
    selectWorkflowKind$,
    openCapability$,
    prepareWorkflow$: createPrepareWorkflowCommand(actions),
    prepareExplore$: createPrepareExploreCommand(
      internalExploreKind$,
      selectTask$,
      actions,
    ),
  };
}
