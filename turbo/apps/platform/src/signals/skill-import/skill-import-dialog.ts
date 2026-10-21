/** The dialog retains one session across close/reopen for the same identity. */
import { command, computed, state } from "ccstate";
import { authenticatedSessionKey$ } from "../auth.ts";
import { rootVersion$ } from "../root-signal.ts";
import { reloadWorkflowData$ } from "../workflows-page/workflow-reload.ts";
import {
  createSkillImportSignals,
  type SkillImportProvider,
} from "./skill-import.ts";

const dialog$ = computed((get) => {
  get(authenticatedSessionKey$);
  get(rootVersion$);
  const open$ = state(false);
  const provider$ = state<SkillImportProvider>("claudeCode");
  const promptShown$ = state(false);
  const signals$ = computed((get) => {
    const provider = get(provider$);
    return createSkillImportSignals({ provider });
  });
  return { open$, provider$, promptShown$, signals$ };
});

export const skillImportDialogOpen$ = computed((get) => {
  return get(get(dialog$).open$);
});
export const skillImportDialogProvider$ = computed((get) => {
  return get(get(dialog$).provider$);
});
export const skillImportPromptShown$ = computed((get) => {
  return get(get(dialog$).promptShown$);
});
export const skillImportDialogSignals$ = computed((get) => {
  return get(get(dialog$).signals$);
});

export const openSkillImportDialog$ = command(({ get, set }) => {
  const owner = get(dialog$);
  set(owner.promptShown$, false);
  set(owner.open$, true);
});

export const closeSkillImportDialog$ = command(({ get, set }) => {
  const owner = get(dialog$);
  set(owner.open$, false);
  set(reloadWorkflowData$);
});

export const selectSkillImportProvider$ = command(
  ({ get, set }, provider: SkillImportProvider) => {
    const owner = get(dialog$);
    if (get(owner.provider$) === provider) {
      return;
    }
    set(owner.provider$, provider);
  },
);

export const setSkillImportPromptShown$ = command(
  ({ get, set }, shown: boolean) => {
    set(get(dialog$).promptShown$, shown);
  },
);
