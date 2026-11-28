import { kotlinRouteBindings } from "../kotlin-bindings/bindings";
import { androidUpgradeRequiredSchema } from "../contracts/android-client-compatibility";
import type { RuntimeApiRouteBinding } from "./routes";

export const androidRouteBindings: readonly RuntimeApiRouteBinding[] =
  kotlinRouteBindings.map(({ name, route, ...rest }) => {
    const authenticated = "authenticated" in rest ? rest.authenticated : true;
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
