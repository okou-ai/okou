import { MARKETING_HANDOFF_PROMPT_MAX_CHARS } from "@okouai/api-contracts/validators/marketing-handoffs";
import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { OnboardingAutomaticPage } from "../../views/onboarding-sources-first/onboarding-automatic-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { sendEvent$ } from "../marketing/events.ts";
import { loadMarketingHandoff$ } from "../prompt-page/marketing-handoff.ts";
import { updatePage$ } from "../react-router.ts";
import { searchParams$ } from "../route.ts";
import { detach, Reason } from "../utils.ts";
import { startAutomaticOnboarding$ } from "./onboarding-actions.ts";
import { claimSourcesFirstStartEvent$ } from "./onboarding-sources-first-state.ts";

/** The explicit entry starts once; its page projects the operation's loadable. */
export const trySkipOnboarding$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
    signal.throwIfAborted();
    const params = get(searchParams$);
    if (
      params.get("skipOnboarding") !== "true" ||
      (params.get("prompt")?.trim().length ?? 0) >
        MARKETING_HANDOFF_PROMPT_MAX_CHARS
    ) {
      return false;
    }
    if (set(claimSourcesFirstStartEvent$)) {
      // Root-owned Marketing delivery retains cookies through the redirect.
      set(sendEvent$, "onboarding-start");
    }
    if (params.get("handoff") && !(await set(loadMarketingHandoff$, signal))) {
      return false;
    }
    detach(
      set(startAutomaticOnboarding$, signal),
      Reason.Entrance,
      "automatic onboarding",
    );
    set(updatePage$, createElement(OnboardingAutomaticPage), "none");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.onboarding.autoComplete.title;
      }),
    );
    await set(hideAppSkeleton$, signal);
    return true;
  },
);
