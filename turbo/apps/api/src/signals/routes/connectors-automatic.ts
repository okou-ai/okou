import { command } from "ccstate";
import { builtinConnectorAutomaticContract } from "@okouai/api-contracts/contracts/connectors";
import type { ConnectorOauthCallbackResult } from "@okouai/api-contracts/contracts/connectors-slug-callback";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$, setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  badRequestMessage,
  conflict,
  notFound,
  providerUnavailable,
  resourceUnavailable,
} from "../../lib/error";
import { env } from "../../lib/env";
import { connectorOAuthRedirectResponse } from "../../lib/connector-oauth-state";
import { connectorActionResolver } from "../services/connector-action-resolver.service";
import {
  completeBuiltinConnectorAutomatic$,
  startBuiltinConnectorAutomatic$,
} from "../services/builtin-connector-automatic-oauth.service";
import {
  authorizeConnectedConnector$,
  connectorAgentAuthorizationRequested,
  validateConnectorAuthorizationTarget$,
} from "../services/connected-connector-authorization.service";
import { recordConnectorOAuthCompletion } from "../services/connector-oauth-completion.service";
import { publishBuiltinConnectorInvalidationAfterCommit } from "../services/connector-client-invalidation.service";
import {
  builtinConnectorAutomaticOAuthRedirectUri,
  okouMcpOAuthClientMetadata,
  okouMcpOAuthDynamicClientMetadata,
} from "../services/mcp-oauth-client-metadata.service";

type AutomaticFailureReason =
  | "invalid-account"
  | "stale-contract"
  | "invalid-state"
  | "oauth-failed"
  | "unsafe"
  | "temporary"
  | "incompatible";

function failureMessage(reason: AutomaticFailureReason): string {
  switch (reason) {
    case "invalid-account": {
      return "Connector account is unavailable or changed";
    }
    case "stale-contract": {
      return "Connector authentication changed; please connect again";
    }
    case "invalid-state": {
      return "Authorization attempt expired or is invalid; please try again";
    }
    case "oauth-failed": {
      return "Connector authorization failed; please try again";
    }
    case "unsafe": {
      return "Connector authorization endpoint is not allowed";
    }
    case "temporary": {
      return "Connector authorization is temporarily unavailable";
    }
    case "incompatible": {
      return "Connector authentication is not supported";
    }
  }
}

function failureResponse(reason: AutomaticFailureReason) {
  const message = failureMessage(reason);
  switch (reason) {
    case "invalid-account":
    case "stale-contract":
    case "incompatible": {
      return conflict(message);
    }
    case "temporary": {
      return providerUnavailable(message);
    }
    case "invalid-state":
    case "oauth-failed":
    case "unsafe": {
      return badRequestMessage(message);
    }
  }
}

const startBuiltinAutomaticInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(builtinConnectorAutomaticContract.start));
    const body = await get(
      bodyResultOf(builtinConnectorAutomaticContract.start),
    );
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const agentTarget = await set(
      validateConnectorAuthorizationTarget$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        agentId: body.data.agentId,
      },
      signal,
    );
    if (!agentTarget.ok) {
      return notFound(agentTarget.message);
    }
    const resolver = await get(connectorActionResolver());
    signal.throwIfAborted();
    const resolved = resolver.resolveNewActionMethod({
      connectorSlug: params.connectorSlug,
      authMethodId: body.data.authMethod,
      expectedGrantKind: "automatic",
    });
    if (!resolved.ok) {
      if (
        resolved.reason === "hidden_auth_method" ||
        resolved.reason === "missing_executable_capability"
      ) {
        return resourceUnavailable("Connector authentication is unavailable");
      }
      return badRequestMessage(
        "Connector automatic auth method is unavailable",
      );
    }

    const request = get(request$).raw;
    const authorizeAgent = connectorAgentAuthorizationRequested(body.data);
    const result = await set(
      startBuiltinConnectorAutomatic$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        resolved,
        account: body.data.account,
        agentId: body.data.agentId ?? null,
        authorizeAgent,
        redirectUri: builtinConnectorAutomaticOAuthRedirectUri(request),
        cimdClientId: okouMcpOAuthClientMetadata(request).client_id,
        dcrClientMetadata: okouMcpOAuthDynamicClientMetadata(
          request,
          "builtin",
        ),
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.kind === "error") {
      return failureResponse(result.reason);
    }
    if (result.kind === "authorization") {
      return {
        status: 200 as const,
        body: {
          result: "authorization" as const,
          authorizationUrl: result.authorizationUrl,
          oauthAttemptId: result.oauthAttemptId,
        },
      };
    }
    if (authorizeAgent) {
      const authorization = await set(
        authorizeConnectedConnector$,
        {
          orgId: auth.orgId,
          userId: auth.userId,
          agentId: body.data.agentId ?? null,
          connectorSlug: resolved.connectorSlug,
        },
        signal,
      );
      if (authorization.status === "agentNotFound") {
        return notFound(authorization.message);
      }
    }
    await publishBuiltinConnectorInvalidationAfterCommit(
      { userId: auth.userId, connectorSlug: resolved.connectorSlug },
      signal,
    );
    return {
      status: 200 as const,
      body: {
        result: "connected" as const,
        connectedAccountId: result.connectionId,
      },
    };
  },
);

const completeBuiltinAutomatic$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<{
    readonly connectorSlug: string;
    readonly result: ConnectorOauthCallbackResult;
  }> => {
    const query = get(queryOf(builtinConnectorAutomaticContract.callback));
    if (!query.state) {
      return {
        connectorSlug: "automatic",
        result: { status: "error", message: "Missing authorization state" },
      };
    }
    const completed = await set(
      completeBuiltinConnectorAutomatic$,
      {
        state: query.state,
        code: query.code,
        error: query.error,
        errorDescription: query.error_description,
        issuer: query.iss,
        redirectUri: builtinConnectorAutomaticOAuthRedirectUri(
          get(request$).raw,
        ),
      },
      signal,
    );
    signal.throwIfAborted();
    if (completed.kind === "error") {
      return {
        connectorSlug: completed.connectorSlug ?? "automatic",
        result: { status: "error", message: failureMessage(completed.reason) },
      };
    }
    if (completed.authorizeAgent) {
      const authorization = await set(
        authorizeConnectedConnector$,
        {
          orgId: completed.orgId,
          userId: completed.userId,
          agentId: completed.agentId,
          connectorSlug: completed.connectorSlug,
        },
        signal,
      );
      if (authorization.status === "agentNotFound") {
        return {
          connectorSlug: completed.connectorSlug,
          result: { status: "error", message: authorization.message },
        };
      }
    }
    await recordConnectorOAuthCompletion(
      set(writeDb$),
      {
        attemptId: completed.oauthAttemptId,
        connectionId: completed.connectionId,
        orgId: completed.orgId,
        userId: completed.userId,
      },
      signal,
    );
    await publishBuiltinConnectorInvalidationAfterCommit(
      { userId: completed.userId, connectorSlug: completed.connectorSlug },
      signal,
    );
    return {
      connectorSlug: completed.connectorSlug,
      result: { status: "success", username: null },
    };
  },
);

const callbackBuiltinAutomatic$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const query = get(queryOf(builtinConnectorAutomaticContract.callback));
    const completed = await set(completeBuiltinAutomatic$, signal);
    signal.throwIfAborted();
    set(setResHeader$, "Cache-Control", "no-store");
    if (query.responseMode === "json") {
      return { status: 200 as const, body: completed.result };
    }
    const target = new URL(
      `/connectors/${encodeURIComponent(completed.connectorSlug)}/callback/${completed.result.status}`,
      env("APP_URL"),
    );
    if (completed.result.status === "error") {
      target.searchParams.set("message", completed.result.message);
    }
    return connectorOAuthRedirectResponse(target.toString());
  },
);

export const builtinConnectorsAutomaticRoutes: readonly RouteEntry[] = [
  {
    route: builtinConnectorAutomaticContract.start,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "connector:write",
      },
      startBuiltinAutomaticInner$,
    ),
  },
  {
    route: builtinConnectorAutomaticContract.callback,
    handler: callbackBuiltinAutomatic$,
  },
];
