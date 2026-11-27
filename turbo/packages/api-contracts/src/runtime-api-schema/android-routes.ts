import { kotlinRouteBindings } from "../kotlin-bindings/bindings";
import { androidUpgradeRequiredSchema } from "../contracts/android-client-compatibility";
import { artifactSharesContract } from "../contracts/artifact-shares";
import { hostContract } from "../contracts/host";
import type { RuntimeApiRouteBinding } from "./routes";

// Legacy routes retired from the current Android app in Release 1, retained in
// the compatibility inventory until Release 2 raises android-client-compatibility.json.
const legacyAndroidRouteBindings = [
  { name: "artifactShareStatus", route: artifactSharesContract.status },
  { name: "updateArtifactShare", route: artifactSharesContract.update },
  { name: "artifactSiteVisibility", route: hostContract.siteVisibility },
  {
    name: "updateArtifactSiteVisibility",
    route: hostContract.updateSiteVisibility,
  },
] as const;

export const androidRouteBindings: readonly RuntimeApiRouteBinding[] = [
  ...kotlinRouteBindings,
  ...legacyAndroidRouteBindings,
].map(({ name, route, ...rest }) => {
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
