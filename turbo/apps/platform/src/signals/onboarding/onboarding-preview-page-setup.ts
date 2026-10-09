import { command, type Command } from "ccstate";
import { resolvePlatformEnvironment } from "../../lib/platform-host.ts";
import { authenticatedIdentity$ } from "../auth.ts";
import { onboardingStatus$ } from "../okou-page/onboarding.ts";
import { ROUTES } from "../route-paths.ts";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import { settle } from "../utils.ts";
import {
  completeOnboarding$,
  promptHandoffParams,
} from "./onboarding-actions.ts";
import {
  clearSourcesFirstDraft$,
  restoreSourcesFirstDraft$,
} from "./onboarding-sources-first-state.ts";

/** Runs after authentication, only on the deployment-authorized PR preview. */
export function setupPreviewOnboardingPageWrapper(
  setupPage: Command<Promise<void> | void, [AbortSignal]>,
) {
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const searchParams = get(searchParams$);
    if (
      resolvePlatformEnvironment() !== "preview" ||
      document.documentElement.dataset.appPrPreview !== "true" ||
      searchParams.get("skipOnboarding") !== "true"
    ) {
      await set(setupPage, signal);
      return;
    }

    const status = await get(onboardingStatus$);
    signal.throwIfAborted();
    if (!status.hasOrg) {
      await set(setupPage, signal);
      return;
    }

    const identity = await get(authenticatedIdentity$);
    signal.throwIfAborted();
    set(restoreSourcesFirstDraft$, identity);
    if (status.needsOnboarding) {
      const completion = await settle(
        set(
          completeOnboarding$,
          searchParams.get("redeemCode")?.trim() || null,
          signal,
        ),
        signal,
      );
      if (!completion.ok) {
        // Completion owns its API error presentation. Keep the ordinary flow
        // available for recovery instead of treating a failed request as done.
        await set(setupPage, signal);
        return;
      }
    }

    set(clearSourcesFirstDraft$);
    const nextParams = promptHandoffParams(searchParams);
    nextParams.delete("skipOnboarding");
    // A QA shortcut opens the app without sending a dummy or supplied request.
    nextParams.delete("prompt");
    set(detachedNavigateTo$, ROUTES.home, {
      searchParams: nextParams,
      replace: true,
    });
  });
}
