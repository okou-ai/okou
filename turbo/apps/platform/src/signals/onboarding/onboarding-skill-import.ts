import { command, computed } from "ccstate";
import { authenticatedSessionKey$ } from "../auth.ts";
import {
  captureSourceOnboardingImportPromptShown$,
  captureSourceOnboardingPromptCopied$,
} from "../bootstrap/source-onboarding-telemetry.ts";
import { rootVersion$ } from "../root-signal.ts";
import { createSkillImportSignals } from "../skill-import/skill-import.ts";
import { sourcesFirstDraft$ } from "./onboarding-sources-first-state.ts";

const provider$ = computed((get) => {
  return get(sourcesFirstDraft$).provider;
});

/** Back retains this flow session; identity or provider changes replace it. */
export const sourcesFirstSkillImportSignals$ = computed((get) => {
  get(authenticatedSessionKey$);
  get(rootVersion$);
  const provider = get(provider$);
  return createSkillImportSignals({
    provider,
    onPromptShown$: captureSourceOnboardingImportPromptShown$,
    onPromptCopied$: captureSourceOnboardingPromptCopied$,
  });
});

export const watchOnboardingSkillImport$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    await set(get(sourcesFirstSkillImportSignals$).watch$, signal);
  },
);
