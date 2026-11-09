import { command } from "ccstate";
import { computerUseAuthorizationRequestsContract } from "@okouai/api-contracts/contracts/computer-use";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import {
  applyComputerUseAuthorizationRequest$,
  createComputerUseAuthorizationRequest$,
  readComputerUseAuthorizationRequest$,
} from "../services/computer-use-authorization.service";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import type { RouteEntry } from "../route-entry";

function expired() {
  return {
    status: 410 as const,
    body: {
      error: {
        message: "Computer Use authorization request expired",
        code: "GONE",
      },
    },
  };
}

const unsupportedContext = conflict(
  "Computer Use authorization links are only available from web chat and Slack thread runs",
);

const createBody$ = bodyResultOf(
  computerUseAuthorizationRequestsContract.create,
);
const getParams$ = pathParamsOf(computerUseAuthorizationRequestsContract.get);
const applyParams$ = pathParamsOf(
  computerUseAuthorizationRequestsContract.apply,
);
const applyBody$ = bodyResultOf(computerUseAuthorizationRequestsContract.apply);

const computerUseAuthorizationAuthOptions = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const computerUseAuthorizationCreateAuthOptions = {
  ...computerUseAuthorizationAuthOptions,
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
        "Computer Use authorization requires a run token",
      );
    }
    const result = await set(
      createComputerUseAuthorizationRequest$,
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
        source: result.source,
        expiresAt: result.expiresAt,
      },
    };
  },
);

const getAuthorizationRequestInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(getParams$);

    const result = await set(
      readComputerUseAuthorizationRequest$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        requestToken: params.requestToken,
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status === "not_found") {
      return notFound("Computer Use authorization request not found");
    }
    if (result.status === "expired") {
      return expired();
    }

    return {
      status: 200 as const,
      body: {
        source: result.source,
        expiresAt: result.expiresAt,
        completedAt: result.completedAt,
        chatThreadId: result.chatThreadId,
        computerUseHostId: result.computerUseHostId,
        hosts: result.hosts,
      },
    };
  },
);

const applyAuthorizationRequestInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(applyParams$);
    const body = await get(applyBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const result = await set(
      applyComputerUseAuthorizationRequest$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        requestToken: params.requestToken,
        computerUseHostId: body.data.computerUseHostId,
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status === "not_found") {
      return notFound("Computer Use authorization request not found");
    }
    if (result.status === "expired") {
      return expired();
    }
    if (result.status === "host_not_found") {
      return notFound("Computer-use host not found");
    }
    if (result.status === "scope_not_found") {
      return notFound("Computer Use authorization scope not found");
    }

    return {
      status: 200 as const,
      body: {
        ok: true as const,
        source: result.source,
        computerUseHostId: result.computerUseHostId,
      },
    };
  },
);

export const computerUseAuthorizationRoutes: readonly RouteEntry[] = [
  {
    route: computerUseAuthorizationRequestsContract.create,
    handler: authRoute(
      computerUseAuthorizationCreateAuthOptions,
      createAuthorizationRequestInner$,
    ),
  },
  {
    route: computerUseAuthorizationRequestsContract.get,
    handler: authRoute(
      computerUseAuthorizationAuthOptions,
      getAuthorizationRequestInner$,
    ),
  },
  {
    route: computerUseAuthorizationRequestsContract.apply,
    handler: authRoute(
      computerUseAuthorizationAuthOptions,
      applyAuthorizationRequestInner$,
    ),
  },
];
