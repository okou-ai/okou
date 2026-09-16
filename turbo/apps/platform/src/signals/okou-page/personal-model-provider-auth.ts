import { isMemberModelPolicyAvailable } from "@okouai/api-contracts/contracts/member-model-policy";
import { orgModelPolicies$ } from "../external/org-model-policies.ts";
import { personalModelProviders$ } from "../external/personal-model-providers.ts";
import { command, computed, type Computed } from "ccstate";
import {
  isPersonalOauthProviderType,
  personalStatusForPolicy,
  reloadPersonalModelProvider$,
} from "./model-first-personal-oauth.ts";
import { openClaudeCodeDeviceAuthDialogPersonal$ } from "./settings/claude-code-device-auth.ts";
import { openCodexDeviceAuthDialogPersonal$ } from "./settings/codex-device-auth.ts";

/**
 * Personal OAuth readiness for the provider behind `selectedModel$` (a null
 * selection counts as available) and the connect / reconnect dialog dispatch.
 */
export function createPersonalModelProviderAuthSignals(
  selectedModel$: Computed<Promise<string | null> | string | null>,
) {
  const oauthAvailable$ = computed(async (get): Promise<boolean> => {
    const selectedModel = await get(selectedModel$);
    if (selectedModel === null) {
      return true;
    }
    const { policies } = await get(orgModelPolicies$);
    const policy = policies.find((candidate) => {
      return candidate.model === selectedModel;
    });
    if (policy?.memberEffective) {
      return isMemberModelPolicyAvailable(policy);
    }
    if (
      policy === undefined ||
      policy.credentialScope !== "member" ||
      !isPersonalOauthProviderType(policy.defaultProviderType)
    ) {
      return true;
    }
    // Read the source in this observed derivation. A separate async status
    // projection can be recomputed without an observer during invalidation.
    const { modelProviders } = await get(personalModelProviders$);
    const status = personalStatusForPolicy(policy, modelProviders);
    return status === null || status.status === "connected";
  });

  const configure$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const selectedModel = await get(selectedModel$);
      signal.throwIfAborted();
      if (selectedModel === null) {
        return;
      }
      // Remote notices refresh only the cheap policy projection. An explicit
      // configuration action needs the latest account before choosing a target.
      set(reloadPersonalModelProvider$);
      const [policies, personal] = await Promise.all([
        get(orgModelPolicies$),
        get(personalModelProviders$),
      ]);
      signal.throwIfAborted();
      const policy = policies.policies.find((candidate) => {
        return candidate.model === selectedModel;
      });
      const status = personalStatusForPolicy(policy, personal.modelProviders);
      if (status === null || status.status === "connected") {
        return;
      }
      const authArgs =
        status.status === "needs_reconnect"
          ? {
              mode: "reconnect" as const,
              modelProviderId: status.credentialId,
            }
          : { mode: "connect" as const };
      if (status.providerType === "claude-code-oauth-token") {
        await set(openClaudeCodeDeviceAuthDialogPersonal$, authArgs, signal);
        return;
      }
      await set(openCodexDeviceAuthDialogPersonal$, authArgs, signal);
    },
  );

  return { oauthAvailable$, configure$ };
}
