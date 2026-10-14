import { command } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import {
  organizationAuthContext$,
  type AuthErrorResponse,
} from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import type { SignalRouteHandler } from "../context/route";
import { userFeatureSwitchContext } from "../services/feature-switches.service";

const managementUnavailable: AuthErrorResponse = Object.freeze({
  status: 403,
  body: Object.freeze({
    error: Object.freeze({
      code: "FORBIDDEN",
      message: "Remote control CLI management is not available",
    }),
  }),
});

/** Configuration access is separate from SSH/VNC execution authorization. */
export function remoteControlOwnerRoute<T>(
  capability: "connector:read" | "connector:write",
  handler$: SignalRouteHandler<T>,
) {
  const gatedHandler$ = command(
    async (
      { get, set },
      signal: AbortSignal,
    ): Promise<T | AuthErrorResponse> => {
      const auth = get(organizationAuthContext$);
      if (auth.tokenType !== "session") {
        const featureContext = await get(
          userFeatureSwitchContext(auth.orgId, auth.userId),
        );
        signal.throwIfAborted();
        if (
          !isFeatureEnabled(
            FeatureSwitchKey.RemoteControlCliManagement,
            featureContext,
          )
        ) {
          return managementUnavailable;
        }
      }
      return "write" in handler$
        ? await set(handler$, signal)
        : await get(handler$);
    },
  );
  return authRoute(
    {
      requireOrganization: true,
      missingOrganizationStatus: 401,
      requiredCapability: capability,
      accept: ["session", "pat", "agent"],
    },
    gatedHandler$,
  );
}
