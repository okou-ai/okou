import { kotlinRouteBindings } from "../kotlin-bindings/bindings";
import { androidUpgradeRequiredSchema } from "../contracts/android-client-compatibility";
import { featureSwitchesContract } from "../contracts/feature-switches";
import type { RuntimeApiRouteBinding } from "./routes";

const installedReaderBindings = [
  ...kotlinRouteBindings,
  // Shipped Android readers still consume this route. Track retirement in #49547.
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
