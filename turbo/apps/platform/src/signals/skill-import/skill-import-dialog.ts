/**
 * The import skills dialog the workflows page and the composer's plus menu
 * open. It runs one skill import for the app session: the tool is picked in
 * the dialog, and its baseline and session survive closing it, so reopening
 * the dialog still lists what this session already imported.
 */
import { command, computed, state } from "ccstate";
import { resetSignal } from "../utils.ts";
import { reloadWorkflowData$ } from "../workflows-page/workflow-reload.ts";
import {
  createSkillImportSignals,
  type SkillImportProvider,
} from "./skill-import.ts";

/**
 * `prompt-first` is the dialog's own layout. A dialog reopened after skills
 * arrived leads with them and keeps the prompt behind a disclosure, which the
 * user may open.
 */
type SkillImportPromptDisclosure = "prompt-first" | "collapsed" | "expanded";

const internalOpen$ = state(false);
const internalProvider$ = state<SkillImportProvider>("claudeCode");
const internalDisclosure$ = state<SkillImportPromptDisclosure>("prompt-first");
/** Owns the poll while the dialog is open; closing or re-entering aborts it. */
const resetSkillImport$ = resetSignal();

export const skillImportDialogOpen$ = computed((get) => {
  return get(internalOpen$);
});

export const skillImportDialogProvider$ = computed((get) => {
  return get(internalProvider$);
});

export const skillImportPromptDisclosure$ = computed((get) => {
  return get(internalDisclosure$);
});

export const skillImportDialogSignals = createSkillImportSignals({
  provider$: skillImportDialogProvider$,
  // The dialog's baseline outlives it, so a workflow made in chat between two
  // openings would otherwise read as imported.
  requireImportSource: true,
});

/**
 * (Re)enters the import for the chosen tool under a fresh child of the
 * caller's signal, so the previous poll stops first. Also the failed state's
 * retry.
 */
export const startSkillImport$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    const importSignal = set(resetSkillImport$, signal);
    await set(skillImportDialogSignals.enter$, importSignal);
  },
);

export const openSkillImportDialog$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const { imported } = get(skillImportDialogSignals.state$);
    set(
      internalDisclosure$,
      imported.length > 0 ? "collapsed" : "prompt-first",
    );
    set(internalOpen$, true);
    await set(startSkillImport$, signal);
  },
);

/**
 * Closing stops the poll. Skills it saw arrive are already workflows, so the
 * workflow list is asked again rather than left without them until a reload.
 */
export const closeSkillImportDialog$ = command(({ get, set }) => {
  set(internalOpen$, false);
  set(resetSkillImport$);
  if (get(skillImportDialogSignals.state$).imported.length > 0) {
    set(reloadWorkflowData$);
  }
});

/** Writing the prompt for another tool needs a session for that tool. */
export const selectSkillImportProvider$ = command(
  async (
    { get, set },
    provider: SkillImportProvider,
    signal: AbortSignal,
  ): Promise<void> => {
    if (get(internalProvider$) === provider) {
      return;
    }
    set(internalProvider$, provider);
    await set(startSkillImport$, signal);
  },
);

export const setSkillImportPromptExpanded$ = command(
  ({ set }, expanded: boolean) => {
    set(internalDisclosure$, expanded ? "expanded" : "collapsed");
  },
);
