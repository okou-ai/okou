import { command } from "ccstate";
import { browserAuthorizationRequestsContract } from "@okouai/api-contracts/contracts/browser";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import {
  applyBrowserAuthorizationRequest$,
  createBrowserAuthorizationRequest$,
  readBrowserAuthorizationRequest$,
} from "../services/browser-authorization.service";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import type { RouteEntry } from "../route-entry";

function expired() {
  return {
    status: 410 as const,
    body: {
      error: {
        message: "Cloud browser authorization request expired",
        code: "GONE",
      },
    },
  };
}

const unsupportedContext = conflict(
  "Cloud browser authorization links are only available from chat thread runs",
);

const createBody$ = bodyResultOf(browserAuthorizationRequestsContract.create);
const getParams$ = pathParamsOf(browserAuthorizationRequestsContract.get);
const applyParams$ = pathParamsOf(browserAuthorizationRequestsContract.apply);
const applyBody$ = bodyResultOf(browserAuthorizationRequestsContract.apply);

const browserAuthorizationAuthOptions = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const browserAuthorizationCreateAuthOptions = {
  ...browserAuthorizationAuthOptions,
  acceptAnySandboxCapability: true,
  accept: ["agent", "sandbox"],
} as const;

const createAuthorizationRequestInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const body = await get(createBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    if (auth.tokenType !== "agent" && auth.tokenType !== "sandbox") {
      return badRequestMessage(
        "Cloud browser authorization requires a run token",
      );
    }
    const result = await set(
      createBrowserAuthorizationRequest$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        runId: auth.runId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.status === "run_not_found") {
      return notFound("Run not found");
    }
    if (result.status === "unsupported_context") {
      return unsupportedContext;
    }
    return {
      status: 200 as const,
      body: {
        authorizationUrl: result.authorizationUrl,
        expiresAt: result.expiresAt,
      },
    };
  },
);

const getAuthorizationRequestInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const result = await set(
      readBrowserAuthorizationRequest$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        requestToken: get(getParams$).requestToken,
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.status === "not_found") {
      return notFound("Cloud browser authorization request not found");
    }
    if (result.status === "expired") {
      return expired();
    }
    return {
      status: 200 as const,
      body: {
        id: result.id,
        chatThreadId: result.chatThreadId,
        expiresAt: result.expiresAt,
        completedAt: result.completedAt,
        cloudBrowserEnabled: result.cloudBrowserEnabled,
      },
    };
  },
);

const applyAuthorizationRequestInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const body = await get(applyBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const result = await set(
      applyBrowserAuthorizationRequest$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        requestToken: get(applyParams$).requestToken,
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.status === "not_found") {
      return notFound("Cloud browser authorization request not found");
    }
    if (result.status === "expired") {
      return expired();
    }
    if (result.status === "scope_not_found") {
      return notFound("Cloud browser authorization scope not found");
    }
    return {
      status: 200 as const,
      body: { ok: true as const, cloudBrowserEnabled: true as const },
    };
  },
);

export const browserAuthorizationRoutes: readonly RouteEntry[] = [
  {
    route: browserAuthorizationRequestsContract.create,
    handler: authRoute(
      browserAuthorizationCreateAuthOptions,
      createAuthorizationRequestInner$,
    ),
  },
  {
    route: browserAuthorizationRequestsContract.get,
    handler: authRoute(
      browserAuthorizationAuthOptions,
      getAuthorizationRequestInner$,
    ),
  },
  {
    route: browserAuthorizationRequestsContract.apply,
    handler: authRoute(
      browserAuthorizationAuthOptions,
      applyAuthorizationRequestInner$,
    ),
  },
];
