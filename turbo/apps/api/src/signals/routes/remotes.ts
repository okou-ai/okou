import { remotesContract } from "@okouai/api-contracts/contracts/remotes";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { clerk$ } from "../external/clerk";
import type { RouteEntry } from "../route-entry";
import { listRemoteHostDefaults$ } from "../services/chat-remote-access.service";
import { listComputerUseHosts$ } from "../services/computer-use.service";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import {
  cappedBaseConcurrencyLimit,
  loadActivePaidConcurrencySlots$,
  totalConcurrencyLimit,
} from "../services/org-concurrency-entitlements.service";
import { loadOrgPlanCapabilities$ } from "../services/org-plan-entitlement-read.service";
import { remotesOverviewPreference } from "../services/remotes-overview.service";
import { hasCurrentVncMembership } from "../services/vnc-owner-lifecycle.service";

const cloudBrowserDefault$ = remotesOverviewPreference(
  organizationAuthContext$,
);

const overview$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const auth = get(organizationAuthContext$);
  const owner = { orgId: auth.orgId, userId: auth.userId };
  const [hosts, enabledByDefault, capabilities, paidSlots, featureContext] =
    await Promise.all([
      set(listComputerUseHosts$, owner, signal),
      get(cloudBrowserDefault$),
      set(loadOrgPlanCapabilities$, owner.orgId),
      set(loadActivePaidConcurrencySlots$, owner.orgId),
      get(userFeatureSwitchContext(owner.orgId, owner.userId)),
    ]);
  signal.throwIfAborted();

  // Match the owner inventory's VNC feature and current-membership admission.
  const includeVnc =
    isFeatureEnabled(FeatureSwitchKey.VncAccess, featureContext) &&
    (await hasCurrentVncMembership(get(clerk$), owner, signal));
  signal.throwIfAborted();
  const remoteHosts = await set(listRemoteHostDefaults$, owner, includeVnc);
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      computerUseHosts: hosts.hosts.map((host) => {
        return {
          id: host.id,
          hostName: host.hostName ?? host.displayName,
          displayName: host.displayName,
          lastSeenAt: host.lastSeenAt,
          status: host.status,
        };
      }),
      // Use the same capacity calculation as managed browser admission. Do not
      // confuse this with free slots, session state or the user's preference.
      cloudBrowserAvailable:
        capabilities !== null &&
        totalConcurrencyLimit({
          baseLimit: cappedBaseConcurrencyLimit(
            capabilities.baseConcurrencyLimit,
          ),
          paidSlots,
        }) > 0,
      cloudBrowserEnabledByDefault: enabledByDefault,
      sshHosts: remoteHosts.ssh,
      vncHosts: remoteHosts.vnc,
    },
  };
});

export const remotesRoutes: readonly RouteEntry[] = [
  {
    route: remotesContract.overview,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        accept: ["session"],
      },
      overview$,
    ),
  },
];
