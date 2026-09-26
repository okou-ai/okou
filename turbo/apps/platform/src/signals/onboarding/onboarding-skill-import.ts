/**
 * The source-first onboarding skills step, as one skill import.
 *
 * The step writes the prompt for the tool the user picked earlier in the flow
 * and reports its progress to the onboarding funnel. Its baseline and session
 * live as long as the flow draft — one application start — so coming back
 * through Back still shows the skills this run imported, under the prompt the
 * user was already given.
 */
import { computed } from "ccstate";
import {
  captureSourceOnboardingImportPromptShown$,
  captureSourceOnboardingPromptCopied$,
  captureSourceOnboardingSkillImported$,
} from "../bootstrap/source-onboarding-telemetry.ts";
import { createSkillImportSignals } from "../skill-import/skill-import.ts";
import { sourcesFirstDraft$ } from "./onboarding-sources-first-state.ts";

export const sourcesFirstSkillImportSignals = createSkillImportSignals({
  provider$: computed((get) => {
    return get(sourcesFirstDraft$).provider;
  }),
  onPromptShown$: captureSourceOnboardingImportPromptShown$,
  // The funnel records that a copy happened, never what was copied.
  onPromptCopied$: captureSourceOnboardingPromptCopied$,
  // One event per skill, reported as how many the step had after it arrived.
  // A skill's name is something the user wrote, so the funnel counts them
  // instead of naming them.
  onSkillImported$: captureSourceOnboardingSkillImported$,
});

/**
 * Prepares the step. Nothing here can hold the flow back: a failure leaves the
 * step offering its own retry while Continue and Skip keep working.
 */
export const enterSkillImport$ = sourcesFirstSkillImportSignals.enter$;
