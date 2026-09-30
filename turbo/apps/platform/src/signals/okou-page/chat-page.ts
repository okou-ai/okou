import { command, computed, state } from "ccstate";
import { getMemberModelPolicyRoute } from "@okouai/api-contracts/contracts/member-model-policy";
import { orgModelPolicies$ } from "../external/org-model-policies.ts";
import { userModelPreference$ } from "../external/user-model-preference.ts";
import {
  isCodexFastModeAvailableForSelection,
  resolveModelFirstUserDefaultSelection,
} from "./model-default-selection.ts";
import type { ModelProviderSelection } from "../../views/okou-page/components/model-provider-picker.tsx";
import { createPersonalModelProviderAuthSignals } from "./personal-model-provider-auth.ts";

const internalTaglineIndex$ = state(Math.floor(Math.random() * 17));
const internalChatGreetingHasEntered$ = state(false);
const internalChatGreetingShouldAnimate$ = state(false);

/**
 * Start one composer visit as a single state transition. The first visit in
 * this App lifetime owns the decorative entrance; later visits may choose new
 * copy, but they publish it with motion already disabled so a changed React key
 * cannot restart the animation between route-setup writes.
 */
export const startChatGreetingVisit$ = command(({ get, set }): boolean => {
  const shouldAnimate = !get(internalChatGreetingHasEntered$);
  set(internalChatGreetingHasEntered$, true);
  set(internalChatGreetingShouldAnimate$, shouldAnimate);
  set(internalTaglineIndex$, Math.floor(Math.random() * 17));
  return shouldAnimate;
});

/** Restore the first entrance when the requested agent cannot be opened. */
export const releaseChatGreetingVisit$ = command(({ set }) => {
  set(internalChatGreetingHasEntered$, false);
  set(internalChatGreetingShouldAnimate$, false);
});

export const finishChatGreetingEntrance$ = command(({ set }) => {
  set(internalChatGreetingShouldAnimate$, false);
});

export const chatPageTaglineIndex$ = computed((get) => {
  return get(internalTaglineIndex$);
});

export const chatGreetingShouldAnimate$ = computed((get) => {
  return get(internalChatGreetingShouldAnimate$);
});

// ---------------------------------------------------------------------------
// Landing-page composer model selection
// ---------------------------------------------------------------------------

// Discriminated union so "user hasn't picked anything" can resolve to the
// current model-first default while "user explicitly picked inherit" stays null.
const internalChatPageUserOverride$ = state<
  { kind: "unset" } | { kind: "set"; value: ModelProviderSelection | null }
>({ kind: "unset" });

export const chatPageModelSelection$ = computed(
  async (get): Promise<ModelProviderSelection | null> => {
    const user = get(internalChatPageUserOverride$);
    if (user.kind === "set") {
      if (!user.value) {
        return null;
      }
      const selection: ModelProviderSelection = {
        selectedModel: user.value.selectedModel,
        modelSettings: user.value.modelSettings ?? {},
      };
      if (!user.value.codexServiceTier) {
        return selection;
      }
      const policies = await get(orgModelPolicies$);
      if (user.value.codexServiceTier === "ultrafast") {
        const directAstra = policies?.policies.some((policy) => {
          return (
            policy.model === user.value?.selectedModel &&
            policy.model === "gpt-6-astra" &&
            getMemberModelPolicyRoute(policy).providerType === "openai-api-key"
          );
        });
        return directAstra
          ? { ...selection, codexServiceTier: "ultrafast" }
          : selection;
      }
      return isCodexFastModeAvailableForSelection({
        policies,
        selectedModel: user.value.selectedModel,
      })
        ? { ...selection, codexServiceTier: "fast" }
        : selection;
    }
    const policies = await get(orgModelPolicies$);
    const userPreference = await get(userModelPreference$);
    return resolveModelFirstUserDefaultSelection({
      userPreference,
      policies,
    });
  },
);

const chatPageSelectedModel$ = computed(async (get): Promise<string | null> => {
  return (await get(chatPageModelSelection$))?.selectedModel ?? null;
});

export const {
  oauthAvailable$: chatPageSelectedModelOauthAvailable$,
  configure$: configureChatPageSelectedModel$,
} = createPersonalModelProviderAuthSignals(chatPageSelectedModel$);

export const setChatPageModelSelection$ = command(
  ({ set }, value: ModelProviderSelection | null) => {
    set(internalChatPageUserOverride$, { kind: "set", value });
  },
);

export const resetChatPageModelSelection$ = command(({ get, set }) => {
  if (get(internalChatPageUserOverride$).kind === "set") {
    set(internalChatPageUserOverride$, { kind: "unset" });
  }
});
