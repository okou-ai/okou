import { command, computed, state, type Command } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../external/feature-switch.ts";
import type {
  ComposerTask,
  ComposerTaskChipsSignals,
} from "./composer-task-chips.ts";
import type { WorkflowComposerSignals } from "./tiptap-workflow-composer.ts";

const homeTaskDiscoveryEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.HomeTaskDiscovery];
});

export type ComposerHomeEntry =
  "people" | "information" | "general" | "briefs" | "monitor";

const HOME_ENTRY_PROMPTS = {
  people: "Find people who match the user's criteria.",
  information: "Find information and materials relevant to the user's request.",
  general: "Answer the user's question through search.",
  briefs: "Prepare a brief on the topic specified by the user.",
  monitor: "Help the user track changes to the specified subject or topic.",
} as const satisfies Record<ComposerHomeEntry, string>;

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
  const activeEntry$ = computed((get): ComposerHomeEntry | null => {
    const view = get(view$);
    return get(enabled$) && view !== "directory" && view !== "task"
      ? view
      : null;
  });
  const additionalInfo$ = computed((get) => {
    const entry = get(activeEntry$);
    return entry === null ? undefined : HOME_ENTRY_PROMPTS[entry];
  });
  const hasSelection$ = computed((get) => {
    return get(activeEntry$) !== null || get(taskChips.task$) !== null;
  });
  const clearSelection$ = command(({ get, set }) => {
    if (get(activeEntry$) === null) {
      set(taskChips.selectTask$, null);
      return;
    }
    set(internalView$, "directory");
    set(internalIdeasVisible$, false);
    set(editor.focus$);
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
    activeEntry$,
    additionalInfo$,
    hasSelection$,
    clearSelection$,
    ideasVisible$,
    openEntry$,
    openTask$,
    useExample$,
  };
}

export type ComposerHomeDiscoverySignals = ReturnType<
  typeof createComposerHomeDiscoverySignals
>;
