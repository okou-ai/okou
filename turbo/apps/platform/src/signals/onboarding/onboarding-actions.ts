import {
  loadMarketingHandoff$,
  marketingHandoff$,
  saveMarketingHandoff$,
} from "../prompt-page/marketing-handoff.ts";
import type {
  MarketingHandoffFile,
  MarketingHandoffManifest,
} from "@okouai/api-contracts/contracts/marketing-handoffs";
import { onboardingCompleteContract } from "@okouai/api-contracts/client/onboarding";
import { orgContract } from "@okouai/api-contracts/client/org-routes";
import { runModelsMainContract } from "@okouai/api-contracts/client/run-models";
import { userModelPreferenceContract } from "@okouai/api-contracts/client/user-model-preference";
import { command, computed } from "ccstate";
import { i18n } from "../../i18n/index.ts";
import { accept } from "../../lib/accept.ts";
import { resolvePlatformEnvironment } from "../../lib/platform-host.ts";
import { reloadAgents$ } from "../agent.ts";
import { discardApiBootstrapResponse } from "../api-client-base.ts";
import { apiClient$ } from "../api-client.ts";
import { invalidateAvailableRunModels$ } from "../external/run-models.ts";
import { reloadUserModelPreference$ } from "../external/user-model-preference.ts";
import { reloadOnboardingStatus$ } from "../okou-page/onboarding.ts";
import { refreshOrg$ } from "../org.ts";
import { ROUTES } from "../route-paths.ts";
import {
  detachedNavigateTo$,
  replaceSearchParams$,
  pathname$,
  searchParams$,
} from "../route.ts";
import {
  clearSourcesFirstDraft$,
  sourcesFirstDraft$,
} from "./onboarding-sources-first-state.ts";
import {
  hasUnresolvedOnboardingPastedFiles$,
  onboardingDraft$,
  onboardingPromptOutput$,
} from "./onboarding-state.ts";
import {
  onboardingOutputSuffix,
  type StartingPromptOutput,
} from "./onboarding-output-format.ts";
import { MARKETING_HANDOFF_PROMPT_MAX_CHARS } from "@okouai/api-contracts/validators/marketing-handoffs";

const ONBOARDING_TRANSIENT_PARAMS = [
  "choice",
  "category",
  "workflow",
  "onboarding_billing",
  "onboarding_billing_session_id",
  "onboarding_note",
  "onboarding_template",
  "redeemCode",
] as const;

/**
 * The query a prompt handoff carries on, with every parameter that only
 * belonged to the onboarding step itself dropped, so an already-onboarded
 * visitor is handed the same URL wherever they arrive.
 */
export function promptHandoffParams(
  searchParams: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams(searchParams);
  for (const key of ONBOARDING_TRANSIENT_PARAMS) {
    next.delete(key);
  }
  return next;
}

export const completeOnboarding$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const createClient = get(apiClient$);
    const onboardingClient = createClient(onboardingCompleteContract);
    const timezone =
      new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    // The industry answer can be absent after a resumed run or a prompt
    // handoff.
    const { industry } = get(sourcesFirstDraft$);
    await accept(
      onboardingClient.complete({
        body: industry === null ? { timezone } : { timezone, industry },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    // Completion provisions organization state these routes read. Snapshots
    // prefetched into the onboarding page's HTML predate them.
    for (const route of [
      orgContract.get,
      runModelsMainContract.list,
      userModelPreferenceContract.get,
    ]) {
      discardApiBootstrapResponse(route.method, route.path);
    }
    set(refreshOrg$);
    set(invalidateAvailableRunModels$);
    set(reloadUserModelPreference$);
    // Both a prior route and the Worker's HTML prefetch can retain an empty
    // list from before the status endpoint provisioned the default agent.
    set(reloadAgents$);
    set(reloadOnboardingStatus$);
    // The answers stay until the first chat replaces the step showing them. A
    // later onboarding visit or app start clears them for an onboarded user.
  },
);

/** Preview QA can enter the app without answering the onboarding questions. */
export const canSkipPreviewOnboarding$ = computed((get) => {
  return (
    get(pathname$) === ROUTES.onboarding &&
    resolvePlatformEnvironment() === "preview"
  );
});

export const skipPreviewOnboarding$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    if (!get(canSkipPreviewOnboarding$)) {
      return;
    }
    await set(completeOnboarding$, signal);
    set(clearSourcesFirstDraft$);
    set(detachedNavigateTo$, ROUTES.home, { replace: true });
  },
);

const saveOnboardingRequestHandoff$ = command(
  async (
    { get, set },
    request: {
      readonly prompt: string;
      readonly files: MarketingHandoffFile[];
      readonly template: string | null;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    const searchParams = get(searchParams$);
    const handoff = searchParams.get("handoff")
      ? (get(marketingHandoff$) ?? (await set(loadMarketingHandoff$, signal)))
      : null;
    if (searchParams.get("handoff") && !handoff) {
      throw new Error("Marketing handoff has not been loaded");
    }
    const manifest: MarketingHandoffManifest = {
      version: 1,
      prompt: request.prompt,
      files: request.files,
      options: {
        ...(handoff?.manifest.options ?? {
          model: searchParams.get("model")?.trim() || undefined,
          connector: searchParams.get("connector")?.trim() || undefined,
          showcase: searchParams.get("showcase") || undefined,
        }),
        template: request.template ?? undefined,
      },
    };
    return await set(saveMarketingHandoff$, manifest, signal);
  },
);

/**
 * Leaves onboarding for its first request. Finishing the flow is what marks
 * onboarding complete, so the request goes out after it: otherwise
 * `needsOnboarding` stays true and the bootstrap guard returns the user to
 * onboarding on the next load. When completion fails the rejected command
 * keeps the user on the step with their input intact.
 */
export const runOnboardingRequest$ = command(
  async (
    { get, set },
    request: string,
    template: string | null,
    output: StartingPromptOutput | null,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const prompt = request + onboardingOutputSuffix(output);
    // Guard the command as well as the controls, before resolving, saving or
    // completing anything. Output instructions count toward the wire limit.
    if (prompt.length > MARKETING_HANDOFF_PROMPT_MAX_CHARS) {
      throw new Error(
        i18n.t(($) => {
          return $.onboarding.sourcesFirst.prompt.tooLong;
        }),
      );
    }
    if (get(hasUnresolvedOnboardingPastedFiles$)) {
      return;
    }
    const searchParams = get(searchParams$);
    const handoffParams = promptHandoffParams(searchParams);
    const files =
      searchParams.has("handoff") || searchParams.has("prompt")
        ? get(onboardingDraft$).files
        : [];
    if (searchParams.get("handoff") || files.length > 0) {
      const hash = await set(
        saveOnboardingRequestHandoff$,
        { prompt, files, template },
        signal,
      );
      handoffParams.delete("prompt");
      handoffParams.delete("template");
      handoffParams.set("handoff", hash);
      // Persist the edited reference before completion can change the route's guard.
      // A failed/uncertain completion must not make a refresh run the old task.
      const pending = new URLSearchParams(searchParams);
      pending.delete("prompt");
      pending.delete("template");
      pending.set("handoff", hash);
      set(replaceSearchParams$, pending);
    } else {
      handoffParams.set("prompt", prompt);
      if (template) {
        handoffParams.set("template", template);
      } else {
        handoffParams.delete("template");
      }
    }
    await set(completeOnboarding$, signal);
    set(detachedNavigateTo$, ROUTES.prompt, {
      searchParams: handoffParams,
      replace: true,
    });
  },
);

/**
 * Combines the edited task and selected format only at submission. Capture
 * both before completion so the editable draft stays intact during handoff.
 */
export const runPromptOnboarding$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const { prompt } = get(onboardingDraft$);
    const output = get(onboardingPromptOutput$);
    const template = get(searchParams$).get("handoff")
      ? (get(marketingHandoff$)?.manifest.options.template ?? null)
      : get(searchParams$).get("template")?.trim() || null;
    await set(runOnboardingRequest$, prompt, template, output, signal);
  },
);
