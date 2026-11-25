import { antigravityDeviceAuthContract as contract } from "@okouai/api-contracts/contracts/antigravity-device-auth";
import { command } from "ccstate";

import { badRequestMessage, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  antigravityDeviceAuthUnavailable,
  cancelAntigravityDeviceAuth$,
  completeAntigravityDeviceAuth$,
  startAntigravityDeviceAuth$,
} from "../services/antigravity-device-auth.service";
import { isAntigravityEnabledForMember$ } from "../services/feature-switches.service";

const modelProviderWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const startBody$ = bodyResultOf(contract.start);
const completeBody$ = bodyResultOf(contract.complete);
const cancelBody$ = bodyResultOf(contract.cancel);

const start$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const body = await get(startBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  if (
    !(await set(
      isAntigravityEnabledForMember$,
      auth.orgId,
      auth.userId,
      signal,
    ))
  ) {
    return notFound("Resource not found");
  }
  if (body.data.mode === "reconnect" && !body.data.modelProviderId) {
    return badRequestMessage("modelProviderId is required for reconnect");
  }
  const result = await set(
    startAntigravityDeviceAuth$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      mode: body.data.mode,
      modelProviderId: body.data.modelProviderId,
    },
    signal,
  );
  signal.throwIfAborted();
  if (!result.ok) {
    return antigravityDeviceAuthUnavailable(result.message);
  }
  return {
    status: 200 as const,
    body: {
      sessionToken: result.sessionToken,
      type: "antigravity" as const,
      status: "pending" as const,
      browserUrl: result.browserUrl,
      expiresIn: result.expiresIn,
    },
  };
});

const complete$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const body = await get(completeBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  if (
    !(await set(
      isAntigravityEnabledForMember$,
      auth.orgId,
      auth.userId,
      signal,
    ))
  ) {
    return notFound("Resource not found");
  }
  const result = await set(
    completeAntigravityDeviceAuth$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      sessionToken: body.data.sessionToken,
      authorizationCode: body.data.authorizationCode,
    },
    signal,
  );
  signal.throwIfAborted();
  switch (result.status) {
    case "complete": {
      return {
        status: 200 as const,
        body: {
          status: "complete" as const,
          provider: result.body.provider,
          created: result.body.created,
        },
      };
    }
    case "invalid_token": {
      return badRequestMessage(result.message);
    }
    case "forbidden": {
      return notFound(result.message);
    }
    case "auth_error": {
      return result.response;
    }
    case "error": {
      return antigravityDeviceAuthUnavailable(result.message);
    }
  }
});

// Cancelling stays available after the switch is turned off.
const cancel$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const body = await get(cancelBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const result = await set(
    cancelAntigravityDeviceAuth$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      sessionToken: body.data.sessionToken,
    },
    signal,
  );
  signal.throwIfAborted();
  switch (result.status) {
    case "cancelled": {
      return { status: 200 as const, body: { status: "cancelled" as const } };
    }
    case "invalid_token": {
      return badRequestMessage(result.message);
    }
    case "forbidden": {
      return notFound(result.message);
    }
  }
});

export const antigravityDeviceAuthRoutes: readonly RouteEntry[] = [
  {
    route: contract.start,
    handler: authRoute(modelProviderWriteAuth, start$),
  },
  {
    route: contract.complete,
    handler: authRoute(modelProviderWriteAuth, complete$),
  },
  {
    route: contract.cancel,
    handler: authRoute(modelProviderWriteAuth, cancel$),
  },
];
