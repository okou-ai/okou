import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command } from "ccstate";

import { notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { clerk$ } from "../external/clerk";
import { db$, writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  clearThreadRemoteAccessOverride,
  listRemoteHostDefaults,
  listThreadRemoteAccess,
  setThreadRemoteAccessOverride,
  updateRemoteHostDefault,
} from "../services/chat-remote-access.service";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import { hasCurrentVncMembership } from "../services/vnc-owner-lifecycle.service";

const ownerAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  accept: ["session"],
} as const;

const unavailable = notFound("Remote access is not available");
const missingHost = notFound("Remote access host not found");
const missingThread = notFound("Chat thread not found");

const accessContext$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const auth = get(organizationAuthContext$);
  const featureContext = await get(
    userFeatureSwitchContext(auth.orgId, auth.userId),
  );
  signal.throwIfAborted();
  if (!isFeatureEnabled(FeatureSwitchKey.ThreadRemoteAccess, featureContext)) {
    return null;
  }
  return {
    auth,
    owner: { orgId: auth.orgId, userId: auth.userId },
    vncEnabled: isFeatureEnabled(FeatureSwitchKey.VncAccess, featureContext),
  };
});

const listHostDefaults$ = command(async ({ get, set }, signal: AbortSignal) => {
  const context = await set(accessContext$, signal);
  if (!context) return unavailable;
  const includeVnc =
    context.vncEnabled &&
    (await hasCurrentVncMembership(get(clerk$), context.auth, signal));
  const body = await listRemoteHostDefaults(
    get(db$),
    context.owner,
    includeVnc,
  );
  signal.throwIfAborted();
  return { status: 200 as const, body };
});

const updateHostDefault$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const context = await set(accessContext$, signal);
    if (!context) return unavailable;
    const params = get(
      pathParamsOf(chatRemoteAccessContract.updateHostDefault),
    );
    if (
      params.protocol === "vnc" &&
      (!context.vncEnabled ||
        !(await hasCurrentVncMembership(get(clerk$), context.auth, signal)))
    ) {
      return unavailable;
    }
    const body = await get(
      bodyResultOf(chatRemoteAccessContract.updateHostDefault),
    );
    signal.throwIfAborted();
    if (!body.ok) return body.response;
    const result = await updateRemoteHostDefault(
      set(writeDb$),
      { ...context.owner, connectionId: params.connectionId },
      params.protocol,
      body.data.enabled,
    );
    signal.throwIfAborted();
    return result ? { status: 200 as const, body: result } : missingHost;
  },
);

const listThreadAccess$ = command(async ({ get, set }, signal: AbortSignal) => {
  const context = await set(accessContext$, signal);
  if (!context) return unavailable;
  const params = get(pathParamsOf(chatRemoteAccessContract.listThreadAccess));
  const includeVnc =
    context.vncEnabled &&
    (await hasCurrentVncMembership(get(clerk$), context.auth, signal));
  const result = await listThreadRemoteAccess(
    get(db$),
    { ...context.owner, chatThreadId: params.threadId },
    includeVnc,
  );
  signal.throwIfAborted();
  return result ? { status: 200 as const, body: result } : missingThread;
});

const setThreadOverride$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const context = await set(accessContext$, signal);
    if (!context) return unavailable;
    const params = get(
      pathParamsOf(chatRemoteAccessContract.setThreadOverride),
    );
    if (
      params.protocol === "vnc" &&
      (!context.vncEnabled ||
        !(await hasCurrentVncMembership(get(clerk$), context.auth, signal)))
    ) {
      return unavailable;
    }
    const body = await get(
      bodyResultOf(chatRemoteAccessContract.setThreadOverride),
    );
    signal.throwIfAborted();
    if (!body.ok) return body.response;
    const result = await setThreadRemoteAccessOverride(
      set(writeDb$),
      {
        ...context.owner,
        chatThreadId: params.threadId,
        connectionId: params.connectionId,
      },
      params.protocol,
      body.data.enabled,
    );
    signal.throwIfAborted();
    return result ? { status: 200 as const, body: result } : missingHost;
  },
);

const clearThreadOverride$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const context = await set(accessContext$, signal);
    if (!context) return unavailable;
    const params = get(
      pathParamsOf(chatRemoteAccessContract.clearThreadOverride),
    );
    if (
      params.protocol === "vnc" &&
      (!context.vncEnabled ||
        !(await hasCurrentVncMembership(get(clerk$), context.auth, signal)))
    ) {
      return unavailable;
    }
    const result = await clearThreadRemoteAccessOverride(
      set(writeDb$),
      {
        ...context.owner,
        chatThreadId: params.threadId,
        connectionId: params.connectionId,
      },
      params.protocol,
    );
    signal.throwIfAborted();
    return result ? { status: 200 as const, body: result } : missingHost;
  },
);

export const chatRemoteAccessRoutes: readonly RouteEntry[] = [
  {
    route: chatRemoteAccessContract.listHostDefaults,
    handler: authRoute(ownerAuth, listHostDefaults$),
  },
  {
    route: chatRemoteAccessContract.updateHostDefault,
    handler: authRoute(ownerAuth, updateHostDefault$),
  },
  {
    route: chatRemoteAccessContract.listThreadAccess,
    handler: authRoute(ownerAuth, listThreadAccess$),
  },
  {
    route: chatRemoteAccessContract.setThreadOverride,
    handler: authRoute(ownerAuth, setThreadOverride$),
  },
  {
    route: chatRemoteAccessContract.clearThreadOverride,
    handler: authRoute(ownerAuth, clearThreadOverride$),
  },
];
