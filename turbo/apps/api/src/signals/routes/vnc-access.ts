import { vncHostsContract } from "@okouai/api-contracts/contracts/vnc-access";
import { VNC_ERROR_CODES } from "@okouai/api-contracts/contracts/vnc-errors";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command } from "ccstate";

import { vncErrorResponse } from "../../lib/vnc-error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { clerk$ } from "../external/clerk";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import { listRunVncHosts } from "../services/vnc-access.service";
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
  const auth = get(organizationAuthContext$);
  const db = set(writeDb$);
  const featureContext = await loadUserFeatureSwitchContext(
    db,
    auth.orgId,
    auth.userId,
  );
  signal.throwIfAborted();
  if (!isFeatureEnabled(FeatureSwitchKey.VncAccess, featureContext)) {
    return null;
  }
  if (!(await hasCurrentVncMembership(get(clerk$), auth, signal))) {
    return null;
  }
  return db;
});

const listHosts$ = command(async ({ get, set }, signal: AbortSignal) => {
  const db = await set(admission$, signal);
  if (!db) {
    return unavailable;
  }
  const auth = get(organizationAuthContext$);
  if (auth.tokenType !== "agent") {
    throw new Error("VNC inventory requires Agent authentication");
  }
  const result = await listRunVncHosts(db, auth, signal);
  signal.throwIfAborted();
  return result ? { status: 200 as const, body: result } : unavailable;
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
