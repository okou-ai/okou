import { command, computed, state } from "ccstate";
import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";

import {
  personalModelProviders$,
  reloadPersonalModelProviders$,
} from "../external/personal-model-providers.ts";
import {
  claudeCodeDeviceAuthDialogStatePersonal$,
  openClaudeCodeDeviceAuthDialogPersonal$,
} from "../okou-page/settings/claude-code-device-auth.ts";
import {
  codexDeviceAuthDialogStatePersonal$,
  openCodexDeviceAuthDialogPersonal$,
} from "../okou-page/settings/codex-device-auth.ts";
import { withCleanup } from "../utils.ts";
import {
  sourcesFirstDraft$,
  type SubscriptionProvider,
} from "./onboarding-sources-first-state.ts";

/**
 * The AI-experience step connects the plan the person already pays for, through
 * the same personal device-auth dialogs Settings uses.
 *
 * What the step reports comes from `/api/me/model-providers`: a dialog that
 * says it finished is not the account, so only a provider the API lists counts
 * as connected. An attempt that fails or is called off says so instead.
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
  | "cancelled"
  /** The provider list could not be read, so the account is unknown. */
  | "unconfirmed";

/** One attempt, from the click until the dialog hands control back. */
interface ConnectAttempt {
  readonly provider: SubscriptionProvider;
  readonly outcome: "running" | "failed" | "ended";
}

const internalAttempt$ = state<ConnectAttempt | null>(null);

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

function statusOfAttempt(
  attempt: ConnectAttempt | null,
  provider: SubscriptionProvider,
): OnboardingSubscriptionStatus {
  if (!attempt || attempt.provider !== provider) {
    return "idle";
  }
  switch (attempt.outcome) {
    case "running": {
      return "connecting";
    }
    case "failed": {
      return "failed";
    }
    // The dialog handed control back without an error of its own, and the
    // account still has no provider: the person stopped.
    case "ended": {
      return "cancelled";
    }
  }
}

export const onboardingSubscriptionStatus$ = computed(
  async (get): Promise<OnboardingSubscriptionStatus> => {
    const { provider } = get(sourcesFirstDraft$);
    if (provider === null) {
      return "idle";
    }
    // Read the synchronous answers first, so this recomputes when a dialog
    // opens or an attempt settles rather than only when the list reloads.
    const dialogOpen = get(personalDeviceAuthOpen$)[provider];
    const attempt = get(internalAttempt$);
    const { modelProviders } = await get(personalModelProviders$);

    if (hasConnectedAccount(modelProviders, provider)) {
      return "connected";
    }
    return dialogOpen ? "connecting" : statusOfAttempt(attempt, provider);
  },
);

export const connectOnboardingSubscription$ = command(
  async (
    { set },
    provider: SubscriptionProvider,
    signal: AbortSignal,
  ): Promise<void> => {
    const attempt: ConnectAttempt = { provider, outcome: "running" };
    set(internalAttempt$, attempt);
    // Identity keeps a superseded attempt from writing over the current one,
    // and keeps a reported failure from being relabelled when it ends.
    const settle = (outcome: ConnectAttempt["outcome"]): void => {
      set(internalAttempt$, (current) => {
        return current === attempt ? { provider, outcome } : current;
      });
    };

    await withCleanup(
      (async () => {
        const started =
          provider === "codex"
            ? await set(
                openCodexDeviceAuthDialogPersonal$,
                { mode: "connect" },
                signal,
              )
            : await set(
                openClaudeCodeDeviceAuthDialogPersonal$,
                { mode: "connect" },
                signal,
              );
        if (!started) {
          settle("failed");
        }
      })(),
      () => {
        settle("ended");
        // Finished, failed or called off, the account is whatever the API
        // lists: read it again instead of trusting the dialog's own result.
        set(reloadPersonalModelProviders$);
      },
    );
  },
);
