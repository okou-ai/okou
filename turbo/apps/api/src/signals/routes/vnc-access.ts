import { vncHostsContract } from "@okouai/api-contracts/contracts/vnc-access";
import { VNC_ERROR_CODES } from "@okouai/api-contracts/contracts/vnc-errors";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command } from "ccstate";

import { vncErrorResponse } from "../../lib/vnc-error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$, vncProfileVersion$ } from "../context/hono";
import {
  VNC_KERBEROS_VERSION,
  VNC_KERBEROS_VERSION_HEADER,
  isVncKerberosMethod,
} from "@okouai/api-contracts/contracts/vnc-kerberos";
import { clerk$ } from "../external/clerk";
import type { RouteEntry } from "../route-entry";
import { loadUserFeatureSwitchContext$ } from "../services/feature-switches.service";
import { listRunVncHosts$ } from "../services/vnc-access.service";
import { hasCurrentVncMembership } from "../services/vnc-owner-lifecycle.service";

const unavailable = Object.freeze(
  vncErrorResponse(
    404,
    VNC_ERROR_CODES.UNAVAILABLE,
    "VNC access is not available",
  ),
);

const admission$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  set(setResHeader$, VNC_KERBEROS_VERSION_HEADER, VNC_KERBEROS_VERSION);
  const auth = get(organizationAuthContext$);
  const featureContext = await set(
    loadUserFeatureSwitchContext$,
    auth.orgId,
    auth.userId,
    signal,
  );
  signal.throwIfAborted();
  if (!isFeatureEnabled(FeatureSwitchKey.VncAccess, featureContext)) {
    return null;
  }
  if (!(await hasCurrentVncMembership(get(clerk$), auth, signal))) {
    return null;
  }
  return true;
});

const listHosts$ = command(async ({ get, set }, signal: AbortSignal) => {
  const admitted = await set(admission$, signal);
  if (!admitted) {
    return unavailable;
  }
  const auth = get(organizationAuthContext$);
  if (auth.tokenType !== "agent") {
    throw new Error("VNC inventory requires Agent authentication");
  }
  const result = await set(listRunVncHosts$, auth, signal);
  signal.throwIfAborted();
  return result
    ? {
        status: 200 as const,
        body: {
          hosts:
            get(vncProfileVersion$) === VNC_KERBEROS_VERSION
              ? result.hosts
              : result.hosts.filter((host) => {
                  return !isVncKerberosMethod(host.authMethod);
                }),
        },
      }
    : unavailable;
});

export const vncAccessRoutes: readonly RouteEntry[] = [
  {
    route: vncHostsContract.list,
    handler: authRoute(
      {
        accept: ["agent"],
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "vnc:read",
      },
      listHosts$,
    ),
  },
];
