import { authRoute } from "../auth/auth-route";
import type { SignalRouteHandler } from "../context/route";

/** Configuration access is separate from SSH/VNC execution authorization. */
export function remoteControlOwnerRoute<T>(
  capability: "connector:read" | "connector:write",
  handler$: SignalRouteHandler<T>,
) {
  return authRoute(
    {
      requireOrganization: true,
      missingOrganizationStatus: 401,
      requiredCapability: capability,
      accept: ["session", "pat", "agent"],
    },
    handler$,
  );
}
