import { vncHostsContract } from "@okouai/api-contracts/contracts/vnc-access";
import { VNC_ERROR_CODES } from "@okouai/api-contracts/contracts/vnc-errors";
import { command } from "ccstate";

import { vncErrorResponse } from "../../lib/vnc-error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import type { RouteEntry } from "../route-entry";
import { listRunVncHosts$ } from "../services/vnc-access.service";

const unavailable = Object.freeze(
  vncErrorResponse(
    404,
    VNC_ERROR_CODES.UNAVAILABLE,
    "VNC access is not available",
  ),
);

const listHosts$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const auth = get(organizationAuthContext$);
  if (auth.tokenType !== "agent") {
    throw new Error("VNC inventory requires Agent authentication");
  }
  const result = await set(listRunVncHosts$, auth, signal);
  signal.throwIfAborted();
  return result
    ? {
        status: 200 as const,
        body: result,
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
