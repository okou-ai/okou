import { kotlinRouteBindings } from "../kotlin-bindings/bindings";
import { androidUpgradeRequiredSchema } from "../contracts/android-client-compatibility";
import type { RuntimeApiRouteBinding } from "./routes";

/** The generated service and installed-reader inventory share canonical references. */
export const androidRouteBindings: readonly RuntimeApiRouteBinding[] =
  kotlinRouteBindings.map(({ name, route }) => {
    return {
      id: `android.${name}`,
      owner: "android",
      route: {
        ...route,
        responses: { ...route.responses, 426: androidUpgradeRequiredSchema },
      },
    };
  });
