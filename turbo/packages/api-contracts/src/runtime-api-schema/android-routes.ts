import { kotlinRouteBindings } from "../kotlin-bindings/bindings";
import { androidUpgradeRequiredSchema } from "../contracts/android-client-compatibility";
import { featureSwitchesContract } from "../contracts/feature-switches";
import type { RuntimeApiRouteBinding } from "./routes";

const installedReaderBindings = [
  ...kotlinRouteBindings,
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
