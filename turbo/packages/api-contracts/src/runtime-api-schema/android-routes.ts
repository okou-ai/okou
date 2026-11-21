import { kotlinRouteBindings } from "../kotlin-bindings/bindings";
import { androidUpgradeRequiredSchema } from "../contracts/android-client-compatibility";
import { featureSwitchesContract } from "../contracts/feature-switches";
import type { RuntimeApiRouteBinding } from "./routes";

import { userPreferencesContract } from "../contracts/user-preferences";
import { onboardingStatusContract } from "../contracts/onboarding";
import { agentsMainContract } from "../contracts/agents";
import { agentDraftContract } from "../contracts/agent-draft";

const installedReaderBindings = [
  ...kotlinRouteBindings,
  // Android through 0.36 still calls these served routes. Retire with the native version floor.
  {
    name: "preferences",
    route: userPreferencesContract.get,
    authenticated: true,
  },
  {
    name: "initializePreferences",
    route: userPreferencesContract.initialize,
    authenticated: true,
  },
  {
    name: "updatePreferences",
    route: userPreferencesContract.update,
    authenticated: true,
  },
  {
    name: "onboardingStatus",
    route: onboardingStatusContract.getStatus,
    authenticated: true,
  },
  { name: "agents", route: agentsMainContract.list, authenticated: true },
  { name: "agentDraft", route: agentDraftContract.get, authenticated: true },
  {
    name: "saveAgentDraft",
    route: agentDraftContract.patch,
    authenticated: true,
  },

  // Keep the route in the inventory while installed Android clients still call it.
  {
    name: "featureSwitches",
    route: featureSwitchesContract.get,
    authenticated: true,
  },
];

export const androidRouteBindings: readonly RuntimeApiRouteBinding[] =
  installedReaderBindings.map(({ name, route, authenticated }) => {
    return {
      id: `android.${name}`,
      owner: "android",
      route: {
        ...route,
        responses:
          authenticated === false
            ? route.responses
            : { ...route.responses, 426: androidUpgradeRequiredSchema },
      },
    };
  });
