import { kotlinRouteBindings } from "../kotlin-bindings/bindings";
import { androidUpgradeRequiredSchema } from "../contracts/android-client-compatibility";
import type { RuntimeApiRouteBinding } from "./routes";

const installedReaderBindings = [...kotlinRouteBindings];

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
