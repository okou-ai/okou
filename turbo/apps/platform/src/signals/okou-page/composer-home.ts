import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { restoreChatLayoutScroll$ } from "../chat-page/chat-layout.ts";
import { resetSignal, waitForBrowserPaint } from "../utils.ts";
import type { ComposerTask } from "./composer-task-chips.ts";
import type {
  WorkflowRecommendationActions,
  WorkflowRecommendationDraft,
} from "./composer-workflow-recommendations.ts";

export type HomeWorkflowKind = "scheduled" | "triggers" | "advanced";
export type HomeExploreKind = "search" | "research";
export type HomeCapability = HomeExploreKind | "create" | "workflow";

/** What a capability card or the tray's close control swaps the home to. */
export type HomeSwap =
  | { readonly kind: "explore"; readonly explore: HomeExploreKind }
  | { readonly kind: "task"; readonly task: ComposerTask }
  | { readonly kind: "workflow"; readonly workflow: HomeWorkflowKind }
  | { readonly kind: "close" };

/** The view transition type the home's cards-to-tray swap runs under. */
const HOME_SWAP_TRANSITION = "capability-home";

/** A source action waits for its own mounted composer before restoring reading intent. */
function createCapabilityLayoutSignals() {
  const root$ = state<{
    readonly element: HTMLElement;
    readonly signal: AbortSignal;
  } | null>(null);
  const resetPaint$ = resetSignal();
  const mount$ = command(
    ({ get, set }, element: HTMLElement, signal: AbortSignal) => {
      const root = { element, signal };
      set(root$, root);
      signal.addEventListener(
        "abort",
        () => {
          if (get(root$) === root) {
            set(root$, null);
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
    const paintSignal = set(resetPaint$, signal, root.signal);
    // Unmount and supersession release the initiating action normally; only
    // that action's own cancellation must reject its continuation.
    const [paint] = await Promise.allSettled([
      waitForBrowserPaint(paintSignal),
    ]);
    signal.throwIfAborted();
    if (paint.status === "rejected") {
      if (!paintSignal.aborted) {
        throw paint.reason;
      }
      return;
    }
    if (get(root$) === root && !paintSignal.aborted) {
      await set(restoreChatLayoutScroll$, signal);
    }
  });
  return { mount$, sync$ };
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

/**
 * The capability cards and the tray replace each other in one column, and the
 * greeting moves between two rows when they do. Where the browser can, the
 * swap runs as one view transition: the column cross-fades while the
 * greeting, the one thing on both sides, glides to its new row instead of
 * jumping there. Only the state change runs inside the transition; closing
 * still finishes its layout and draft work after the new page is captured.
 */
function createHomeSwapCommand(
  home: {
    readonly openExplore$: Command<void, [HomeExploreKind]>;
    readonly openWorkflow$: Command<void, [HomeWorkflowKind]>;
    readonly close$: Command<Promise<void>, [AbortSignal]>;
  },
  openTask$: Command<void, [ComposerTask]>,
) {
  return command(async ({ set }, change: HomeSwap, signal: AbortSignal) => {
    signal.throwIfAborted();
    let closing: Promise<void> | undefined;
    const update = () => {
      signal.throwIfAborted();
      switch (change.kind) {
        case "explore": {
          set(home.openExplore$, change.explore);
          break;
        }
        case "task": {
          set(openTask$, change.task);
          break;
        }
        case "workflow": {
          set(home.openWorkflow$, change.workflow);
          break;
        }
        case "close": {
          closing = set(home.close$, signal);
          break;
        }
      }
    };
    if (
      "startViewTransition" in document &&
      CSS.supports("selector(:active-view-transition-type(a))")
    ) {
      await document.startViewTransition({
        update,
        types: [HOME_SWAP_TRANSITION],
      }).updateCallbackDone;
    } else {
      update();
    }
    await closing;
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
  const home = createHomeDiscoverySignals(
    selectedTask$,
    openTask$,
    selectTask$,
    actions,
    closeWorkflow$,
  );
  return { ...home, swap$: createHomeSwapCommand(home, openTask$) };
}

function createHomeDiscoverySignals(
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
