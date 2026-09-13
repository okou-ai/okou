import { command, computed } from "ccstate";
import type { BrowserClerk as Clerk } from "@clerk/shared/types";
import {
  getAllFeatureStates,
  getEmailEnabledFeatureStates,
} from "@okouai/core/feature-switch";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isCodexFastModeEnabled } from "@okouai/core/model-feature-switch";
import { clerk$ } from "../auth";
import { appVersion$ } from "../app-version.ts";
import { accept } from "../../lib/accept.ts";
import { resolveApiBaseForTarget } from "../api-base.ts";
import { getCapturedPreviewBypassForTarget } from "../../lib/preview-bypass-cookie.ts";
import { createAuthedContractClient } from "../api-client-base.ts";
import { rootSignal$ } from "../root-signal.ts";
import { readClerkToken } from "../clerk-token.ts";
import { writeConnectionDiagnostic$ } from "../connection-diagnostics.ts";
import { syncShellDocumentAttributes$ } from "../theme.ts";
import {
  featureSwitchState$,
  resetFeatureSwitchState$,
  setFeatureSwitchState$,
} from "./feature-switch-state.ts";
import {
  completeOnLocalAbort,
  createChildAbortController,
  createDeferredPromise,
  onRejection,
  withCleanup,
} from "../utils.ts";

type FeatureSwitchClerk = Pick<
  Clerk,
  "addListener" | "organization" | "session" | "user"
>;

interface FeatureSwitchIdentity {
  readonly email: string | undefined;
  readonly orgId: string;
  readonly sessionId: string;
  readonly userId: string;
}

function readFeatureSwitchIdentity(
  clerk: FeatureSwitchClerk,
): FeatureSwitchIdentity | null {
  const user = clerk.user;
  const organization = clerk.organization;
  const session = clerk.session;
  if (!user || !organization || !session) {
    return null;
  }
  return {
    email: user.primaryEmailAddress?.emailAddress,
    orgId: organization.id,
    sessionId: session.id,
    userId: user.id,
  };
}

function isSameFeatureSwitchIdentity(
  left: FeatureSwitchIdentity,
  right: FeatureSwitchIdentity | null,
): boolean {
  return (
    right !== null &&
    left.email === right.email &&
    left.orgId === right.orgId &&
    left.sessionId === right.sessionId &&
    left.userId === right.userId
  );
}

// Pinned to the API backend: feature switches bootstrap before the platform API
// client is available.
// eslint-disable-next-line ccstate/no-computed-signal -- migrate this computed away from AbortSignal ownership
const apiFeatureSwitchClient$ = computed((get) => {
  const apiBaseUrl = resolveApiBaseForTarget("api");
  const clerkPromise = get(clerk$);
  const rootSignal = get(rootSignal$);
  return createAuthedContractClient(featureSwitchesContract, {
    baseUrl: apiBaseUrl,
    clientVersion: get(appVersion$),
    getToken: async (signal) => {
      const clerk = await clerkPromise;
      signal.throwIfAborted();
      return await readClerkToken(clerk, signal);
    },
    getRootSignal: () => {
      return rootSignal;
    },
    getVercelProtectionBypass: () => {
      return getCapturedPreviewBypassForTarget(apiBaseUrl) ?? undefined;
    },
  });
});

function applySwitches(
  result: Record<FeatureSwitchKey, boolean>,
  switches: Partial<Record<string, boolean>> | undefined,
) {
  if (switches) {
    for (const key of Object.values(FeatureSwitchKey)) {
      const value = switches[key];
      if (value !== undefined) {
        result[key] = Boolean(value);
      }
    }
  }
}

export const featureSwitch$ = computed((get) => {
  return get(featureSwitchState$);
});

// eslint-disable-next-line ccstate/no-computed-signal -- migrate this computed away from AbortSignal ownership
const initialFeatureSwitchHydrationDeferred$ = computed((get) => {
  return createDeferredPromise<void>(get(rootSignal$));
});

/**
 * Resolves after the first authoritative feature-switch read for this app
 * lifetime. Consumers that turn a switch into immutable parsed state await
 * this boundary instead of committing repository defaults permanently.
 */
export const initialFeatureSwitchHydration$ = computed((get) => {
  return get(initialFeatureSwitchHydrationDeferred$).promise;
});

export const composerImageAnnotationEnabled$ = computed((get): boolean => {
  return get(featureSwitch$)[FeatureSwitchKey.ComposerImageAnnotation] ?? false;
});

export const modelPickerMenuEnabled$ = computed((get): boolean => {
  return get(featureSwitch$)[FeatureSwitchKey.ModelPickerMenu] ?? false;
});

/** The flyout replaces the drill-in menu's pages with two detached panels. */
export const modelPickerFlyoutEnabled$ = computed((get): boolean => {
  return get(featureSwitch$)[FeatureSwitchKey.ModelPickerFlyout] ?? false;
});

export const chatReasoningEffortEnabled$ = computed((get): boolean => {
  return get(featureSwitch$)[FeatureSwitchKey.ChatReasoningEffort];
});

export const codexFastModeEnabled$ = computed((get): boolean => {
  return isCodexFastModeEnabled({ overrides: get(featureSwitch$) });
});

export const agentMessageMathEnabled$ = computed((get): boolean => {
  return get(featureSwitch$)[FeatureSwitchKey.AgentMessageMath] ?? false;
});

export const avatarNeckSweaterEnabled$ = computed((get): boolean => {
  return get(featureSwitch$)[FeatureSwitchKey.AvatarNeckSweater] ?? false;
});

export const avatarFramingEnabled$ = computed((get): boolean => {
  return get(featureSwitch$)[FeatureSwitchKey.AvatarFraming] ?? false;
});

export const customConnectorMcpEnabled$ = computed((get): boolean => {
  return get(featureSwitch$)[FeatureSwitchKey.CustomConnectorMcp] ?? false;
});

export const voiceInputV2Enabled$ = computed((get): boolean => {
  return get(featureSwitch$)[FeatureSwitchKey.VoiceInputV2] ?? false;
});

const hydrateFeatureSwitch$ = command(
  async (
    { get, set },
    clerk: FeatureSwitchClerk,
    identity: FeatureSwitchIdentity,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const client = get(apiFeatureSwitchClient$);
    const result = await accept(
      client.get({ fetchOptions: { signal } }),
      [200],
    );
    signal.throwIfAborted();

    if (
      !isSameFeatureSwitchIdentity(identity, readFeatureSwitchIdentity(clerk))
    ) {
      return;
    }

    const combined = getAllFeatureStates({
      userId: identity.userId,
      email: identity.email,
      orgId: identity.orgId,
    });
    applySwitches(
      combined,
      result.body.effectiveSwitches ?? result.body.switches,
    );
    applySwitches(combined, getEmailEnabledFeatureStates(identity.email));
    applySwitches(combined, result.body.switches);
    set(setFeatureSwitchState$, combined);
    set(syncShellDocumentAttributes$);
    set(writeConnectionDiagnostic$, {
      action: "set-enabled",
      enabled: combined[FeatureSwitchKey.OkouDebug],
    });
  },
);

const refreshFeatureSwitchState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    const identity = readFeatureSwitchIdentity(clerk);
    if (!identity) {
      set(resetFeatureSwitchState$);
      set(syncShellDocumentAttributes$);
      set(writeConnectionDiagnostic$, {
        action: "set-enabled",
        enabled: false,
      });
      return;
    }

    // eslint-disable-next-line ccstate/no-create-child-abort-controller -- migrate this lifetime to the ccstate signal hierarchy
    const requestController = createChildAbortController(signal);
    const abortIfIdentityChanged = () => {
      if (
        !isSameFeatureSwitchIdentity(identity, readFeatureSwitchIdentity(clerk))
      ) {
        requestController.abort();
      }
    };
    const unsubscribe = clerk.addListener(abortIfIdentityChanged, {
      skipInitialEmit: true,
    });
    abortIfIdentityChanged();
    await withCleanup(
      completeOnLocalAbort(
        set(hydrateFeatureSwitch$, clerk, identity, requestController.signal),
        requestController.signal,
        signal,
      ),
      () => {
        unsubscribe();
        requestController.abort();
      },
    );
  },
);

export const reloadFeatureSwitch$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const initialHydration = get(initialFeatureSwitchHydrationDeferred$);
    await onRejection(
      set(refreshFeatureSwitchState$, signal),
      (error: unknown) => {
        if (!initialHydration.settled()) {
          initialHydration.reject(error);
        }
      },
    );
    signal.throwIfAborted();
    if (!initialHydration.settled()) {
      initialHydration.resolve(undefined);
    }
  },
);

export const setFeatureSwitch$ = command(
  async (
    { get, set },
    overrides: Partial<Record<FeatureSwitchKey, boolean>>,
    signal: AbortSignal,
  ) => {
    const client = get(apiFeatureSwitchClient$);
    signal.throwIfAborted();
    await accept(
      client.update({
        body: { switches: overrides },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    await set(reloadFeatureSwitch$, signal);
  },
);

export const resetFeatureSwitches$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const client = get(apiFeatureSwitchClient$);
    signal.throwIfAborted();
    await accept(client.delete({ fetchOptions: { signal } }), [200]);
    signal.throwIfAborted();
    await set(reloadFeatureSwitch$, signal);
  },
);
