import { command, computed, state, type Command } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../external/feature-switch.ts";
import type {
  ComposerTask,
  ComposerTaskChipsSignals,
} from "./composer-task-chips.ts";
import type { WorkflowComposerSignals } from "./tiptap-workflow-composer.ts";
import { onRef } from "../utils.ts";

const homeTaskDiscoveryEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.HomeTaskDiscovery];
});

export type ComposerHomeEntry =
  "people" | "information" | "general" | "briefs" | "monitor";

type HomeDiscoveryView = "initial" | "directory" | "task" | ComposerHomeEntry;

function isHomeSearchEntry(
  entry: string,
): entry is "people" | "information" | "general" {
  return entry === "people" || entry === "information" || entry === "general";
}

export function createComposerHomeDiscoverySignals(
  taskChips: ComposerTaskChipsSignals,
  editor: Pick<WorkflowComposerSignals, "focus$" | "selectOrAppendText$">,
  saveDraft$: Command<Promise<void>, [AbortSignal]>,
  home: boolean,
) {
  const internalView$ = state<HomeDiscoveryView>("initial");
  const internalIdeasVisible$ = state(true);
  const returnFocusEntry$ = state<string | null>(null);
  const enabled$ = computed((get) => {
    return home && get(homeTaskDiscoveryEnabled$);
  });
  const view$ = computed((get): Exclude<HomeDiscoveryView, "initial"> => {
    const view = get(internalView$);
    if (view === "initial" || view === "task") {
      return get(taskChips.task$) === null ? "directory" : "task";
    }
    return view;
  });
  const searchActive$ = computed((get) => {
    return get(enabled$) && isHomeSearchEntry(get(view$));
  });
  const ideasVisible$ = computed((get) => {
    const view = get(view$);
    return (
      view !== "directory" && view !== "task" && get(internalIdeasVisible$)
    );
  });
  const openEntry$ = command(({ set }, entry: ComposerHomeEntry) => {
    set(internalView$, entry);
    set(internalIdeasVisible$, true);
    set(editor.focus$);
  });
  const openTask$ = command(({ set }, task: ComposerTask) => {
    set(taskChips.openTask$, task);
    set(internalView$, "task");
  });
  const showDirectory$ = command(({ get, set }) => {
    const view = get(view$);
    set(returnFocusEntry$, view === "task" ? get(taskChips.task$) : view);
    // Browsing entries never clears a creation mode, template, or draft.
    set(internalView$, "directory");
    set(internalIdeasVisible$, false);
  });
  const bindDirectoryEntry$ = onRef<HTMLElement>(
    command(({ get, set }, element: HTMLElement) => {
      if (element.dataset.homeEntry === get(returnFocusEntry$)) {
        element.focus({ preventScroll: true });
        set(returnFocusEntry$, null);
      }
    }),
  );
  const useExample$ = command(
    async ({ set }, text: string, signal: AbortSignal) => {
      signal.throwIfAborted();
      // This editor action appends without replacing a selection or template.
      set(editor.selectOrAppendText$, text);
      set(internalIdeasVisible$, false);
      await set(saveDraft$, signal);
    },
  );
  return {
    enabled$,
    view$,
    searchActive$,
    ideasVisible$,
    openEntry$,
    openTask$,
    showDirectory$,
    bindDirectoryEntry$,
    useExample$,
  };
}

export type ComposerHomeDiscoverySignals = ReturnType<
  typeof createComposerHomeDiscoverySignals
>;
