import { command, computed, state } from "ccstate";
import type { BrowserClerk as Clerk } from "@clerk/shared/types";
import {
  getAllFeatureStates,
  getEmailEnabledFeatureStates,
} from "@okouai/core/feature-switch";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isCodexFastModeEnabled } from "@okouai/core/model-feature-switch";
import { clerk$ } from "../auth";
import { apiClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { writeConnectionDiagnostic$ } from "../connection-diagnostics.ts";
import { syncShellDocumentAttributes$ } from "../theme.ts";
import {
  featureSwitchState$,
  setFeatureSwitchState$,
} from "./feature-switch-state.ts";

type FeatureSwitchClerk = Pick<Clerk, "organization" | "session" | "user">;

interface FeatureSwitchIdentity {
  readonly email: string | undefined;
  readonly orgId: string;
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
    userId: user.id,
  };
}

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

const internalReloadFeatureSwitches$ = state(0);

/** The authoritative feature switches for the active workspace. */
export const featureSwitches$ = computed(async (get) => {
  get(internalReloadFeatureSwitches$);
  const createClient = get(apiClient$);
  const clerk = await get(clerk$);
  const identity = readFeatureSwitchIdentity(clerk);
  if (!identity) {
    return getAllFeatureStates({});
  }

  const client = createClient(featureSwitchesContract, {
    apiBase: "api",
  });
  const result = await accept(client.get(), [200]);
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
  return combined;
});

export const featureSwitch$ = computed((get) => {
  return get(featureSwitchState$);
});

export const composerImageAnnotationEnabled$ = computed((get): boolean => {
  return get(featureSwitch$)[FeatureSwitchKey.ComposerImageAnnotation] ?? false;
});

export const codexFastModeEnabled$ = computed((get): boolean => {
  return isCodexFastModeEnabled({ overrides: get(featureSwitch$) });
});

export const avatarNeckSweaterEnabled$ = computed((get): boolean => {
  return get(featureSwitch$)[FeatureSwitchKey.AvatarNeckSweater] ?? false;
});

export const avatarFramingEnabled$ = computed((get): boolean => {
  return get(featureSwitch$)[FeatureSwitchKey.AvatarFraming] ?? false;
});

export const applyFeatureSwitches$ = command(
  ({ set }, switches: Record<FeatureSwitchKey, boolean>) => {
    set(setFeatureSwitchState$, switches);
    set(syncShellDocumentAttributes$);
    set(writeConnectionDiagnostic$, {
      action: "set-enabled",
      enabled: switches[FeatureSwitchKey.OkouDebug],
    });
  },
);

const reloadFeatureSwitch$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(internalReloadFeatureSwitches$, (value) => {
      return value + 1;
    });
    const switches = await get(featureSwitches$);
    signal.throwIfAborted();
    set(applyFeatureSwitches$, switches);
  },
);

export const setFeatureSwitch$ = command(
  async (
    { get, set },
    overrides: Partial<Record<FeatureSwitchKey, boolean>>,
    signal: AbortSignal,
  ) => {
    const client = get(apiClient$)(featureSwitchesContract, {
      apiBase: "api",
    });
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
    const client = get(apiClient$)(featureSwitchesContract, {
      apiBase: "api",
    });
    signal.throwIfAborted();
    await accept(client.delete({ fetchOptions: { signal } }), [200]);
    signal.throwIfAborted();
    await set(reloadFeatureSwitch$, signal);
  },
);
