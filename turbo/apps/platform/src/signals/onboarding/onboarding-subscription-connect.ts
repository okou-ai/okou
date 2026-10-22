import { command, computed } from "ccstate";
import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";

import { thirdPartySubscriptions$ } from "../external/third-party-subscriptions.ts";
import {
  claudeCodeDeviceAuthDialogStatePersonal$,
  claudeCodeDeviceAuthFlowStatePersonal$,
  claudeCodeDeviceAuthStartOperationPersonal$,
  openClaudeCodeDeviceAuthDialogPersonal$,
} from "../okou-page/settings/claude-code-device-auth.ts";
import {
  codexDeviceAuthDialogStatePersonal$,
  codexDeviceAuthFlowStatePersonal$,
  codexDeviceAuthStartOperationPersonal$,
  codexDeviceAuthRunOperationPersonal$,
  openCodexDeviceAuthDialogPersonal$,
} from "../okou-page/settings/codex-device-auth.ts";
import {
  sourcesFirstDraft$,
  type SubscriptionProvider,
} from "./onboarding-sources-first-state.ts";

/**
 * The AI-experience step connects the plan the person already pays for, through
 * the same personal device-auth dialogs Settings uses.
 *
 * What the step reports comes from `/api/me/3rd-party-subscriptions`: a dialog that
 * says it finished is not the account, so only a provider the API lists counts
 * as connected. Startup feedback observes the provider's actual operation;
 * closing a dialog alone does not establish why its session ended.
 */

const PROVIDER_TYPES = {
  codex: "codex-oauth-token",
  claudeCode: "claude-code-oauth-token",
} as const satisfies Record<
  SubscriptionProvider,
  ModelProviderResponse["type"]
>;

export type OnboardingSubscriptionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "failed"
  /** The provider list could not be read, so the account is unknown. */
  | "unconfirmed";

export const onboardingSubscriptionOperation$ = computed((get) => {
  const { provider } = get(sourcesFirstDraft$);
  if (provider === null) {
    return null;
  }
  // Codex owns a full authorization run; Claude intentionally owns a short
  // startup, followed by independent code submissions in its dialog.
  return provider === "codex"
    ? get(codexDeviceAuthRunOperationPersonal$)
    : get(claudeCodeDeviceAuthStartOperationPersonal$);
});

export const onboardingSubscriptionStartOperation$ = computed((get) => {
  const { provider } = get(sourcesFirstDraft$);
  if (provider === null) {
    return null;
  }
  // Observe retries in the same provider dialog as well as its initial start.
  return provider === "codex"
    ? get(codexDeviceAuthStartOperationPersonal$)
    : get(claudeCodeDeviceAuthStartOperationPersonal$);
});

/** Either personal dialog being open is this step's own work in progress. */
const personalDeviceAuthOpen$ = computed((get) => {
  return {
    codex: get(codexDeviceAuthDialogStatePersonal$).open,
    claudeCode: get(claudeCodeDeviceAuthDialogStatePersonal$).open,
  } satisfies Record<SubscriptionProvider, boolean>;
});

function hasConnectedAccount(
  providers: readonly ModelProviderResponse[],
  provider: SubscriptionProvider,
): boolean {
  return providers.some((candidate) => {
    return (
      candidate.type === PROVIDER_TYPES[provider] &&
      candidate.isActive !== false &&
      !candidate.needsReconnect
    );
  });
}

export const onboardingSubscriptionStatus$ = computed(
  async (get): Promise<OnboardingSubscriptionStatus> => {
    const { provider } = get(sourcesFirstDraft$);
    if (provider === null) {
      return "idle";
    }
    // Subscribe to session changes before awaiting the account read.
    const dialogOpen = get(personalDeviceAuthOpen$)[provider];
    const sessionStatus =
      provider === "codex"
        ? get(codexDeviceAuthFlowStatePersonal$).status
        : get(claudeCodeDeviceAuthFlowStatePersonal$).status;
    const { subscriptions } = await get(thirdPartySubscriptions$);

    if (hasConnectedAccount(subscriptions, provider)) {
      return "connected";
    }
    if (sessionStatus === "expired" || sessionStatus === "error") {
      return "failed";
    }
    // Closing is not evidence of user cancellation: success, expiry and owner
    // disposal can also end a session. Only the account list proves connection.
    return dialogOpen ? "connecting" : "idle";
  },
);

export const connectOnboardingSubscription$ = command(
  async (
    { set },
    provider: SubscriptionProvider,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();

    // Provider commands own account invalidation for start/run, close,
    // completion and owner cancellation, including retries outside onboarding.
    if (provider === "codex") {
      await set(
        openCodexDeviceAuthDialogPersonal$,
        { mode: "connect" },
        signal,
      );
    } else {
      await set(
        openClaudeCodeDeviceAuthDialogPersonal$,
        { mode: "connect" },
        signal,
      );
    }
  },
);
