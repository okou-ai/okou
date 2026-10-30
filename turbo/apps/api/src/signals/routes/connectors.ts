import { command, computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import {
  builtinConnectorManualGrantContract,
  builtinConnectorNoAuthGrantContract,
  builtinConnectorOpenIdStartContract,
  builtinConnectorOauthStartContract,
  builtinConnectorsMainContract,
  builtinConnectorsSearchContract,
} from "@okouai/api-contracts/contracts/connectors";
import type { PublicConnectorCatalogDetail } from "@okouai/api-contracts/contracts/connector-catalog";
import { connectorGrantScopes } from "@okouai/connectors/connector-auth-method";
import { connectors } from "@okouai/db/schema/connector";
import { connectorOauthStates } from "@okouai/db/schema/connector-oauth-state";

import { authContext$, organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import {
  badRequestMessage,
  conflict,
  notFound,
  providerUnavailable,
} from "../../lib/error";
import { optionalEnv } from "../../lib/env";
import { db$, writeDb$ } from "../external/db";
import { logger } from "../../lib/log";
import {
  authorizeConnectedConnector$,
  connectorAgentAuthorizationRequested,
  validateConnectorAuthorizationTarget$,
} from "../services/connected-connector-authorization.service";
import {
  connectManualGrantBuiltinConnector$,
  connectNoAuthBuiltinConnector$,
  builtinConnectorList,
  builtinConnectorSearch$,
} from "../services/connector-data.service";
import {
  readConnectorResolver$,
  type ConnectorActionMethodResolution,
} from "../services/connector-action-resolver.service";
import { isConnectorCatalogUnavailableError } from "../services/connector-catalog-reader.service";
import type { RouteEntry } from "../route-entry";
import { settle } from "../utils";
import {
  getBuiltinConnectorOAuthCallbackUrlForMethod,
  getBuiltinConnectorOpenIdCallbackOriginForMethod,
} from "./connector-oauth-origin";
import { connectorOAuthStateExpiresAt } from "../../lib/connector-oauth-state";
import {
  buildBuiltinConnectorAuthCodeAuthUrlWithMethod,
  prepareBuiltinConnectorAuthCodeStartWithMethod,
} from "./connector-auth-code-start";
import {
  buildBuiltinConnectorOpenIdAuthUrlWithMethod,
  prepareBuiltinConnectorOpenIdAuthStartWithMethod,
} from "./connector-openid-auth-start";

const connectorReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "connector:read",
} as const;

const connectorWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "connector:write",
} as const;

function connectorUnavailable(connectorSlug: string) {
  return {
    status: 403 as const,
    body: {
      error: {
        message: `${connectorSlug} connector is not available`,
        code: "FORBIDDEN",
      },
    },
  };
}

function internalServerError(message: string) {
  return {
    status: 500 as const,
    body: {
      error: {
        message,
        code: "INTERNAL_SERVER_ERROR",
      },
    },
  };
}

function requestedScopeSnapshot(
  grant: Parameters<typeof connectorGrantScopes>[0],
): string {
  return JSON.stringify(connectorGrantScopes(grant));
}

function connectorAccountMutationFailureResponse(
  kind:
    | "missing"
    | "ambiguous"
    | "sibling-disabled"
    | "accountNotFound"
    | "accountAmbiguous"
    | "siblingDisabled",
) {
  if (kind === "missing" || kind === "accountNotFound") {
    return notFound("Connector account not found");
  }
  if (kind === "ambiguous" || kind === "accountAmbiguous") {
    return conflict("Multiple connector accounts require an exact choice");
  }
  return conflict("This connector does not support additional accounts");
}

type ActionGrantKind =
  PublicConnectorCatalogDetail["authMethods"][number]["grantKind"];

function catalogHasGrantKind(
  catalog: PublicConnectorCatalogDetail,
  grantKind: ActionGrantKind,
): boolean {
  return catalog.authMethods.some((method) => {
    return method.grantKind === grantKind;
  });
}

function connectorMethodResolutionError(
  resolution: Exclude<ConnectorActionMethodResolution, { readonly ok: true }>,
  args: {
    readonly connectorSlug: string;
    readonly authMethodId: string;
    readonly expectedGrantKind: ActionGrantKind;
    readonly expectedGrantLabel: string;
    readonly missingGrantWhenAbsent?: boolean;
  },
) {
  switch (resolution.reason) {
    case "unknown_connector": {
      return badRequestMessage(
        `${args.connectorSlug} connector is not supported`,
      );
    }
    case "unknown_auth_method":
    case "wrong_grant_kind": {
      if (
        args.missingGrantWhenAbsent &&
        !catalogHasGrantKind(
          resolution.catalogConnector,
          args.expectedGrantKind,
        )
      ) {
        return badRequestMessage(
          `${args.connectorSlug} connector does not use ${args.expectedGrantLabel}`,
        );
      }
      if (resolution.reason === "unknown_auth_method") {
        return badRequestMessage(
          `${args.connectorSlug} connector does not have ${args.authMethodId} auth method`,
        );
      }
      return badRequestMessage(
        `${args.connectorSlug} ${args.authMethodId} auth method does not use ${args.expectedGrantLabel}`,
      );
    }
    case "hidden_auth_method": {
      return connectorUnavailable(args.connectorSlug);
    }
    case "missing_executable_capability": {
      return connectorUnavailable(args.connectorSlug);
    }
  }
}

const getBuiltinConnectorListInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const result = await get(
    builtinConnectorList({ orgId: auth.orgId, userId: auth.userId }),
  );
  return { status: 200 as const, body: result };
});

const searchBuiltinConnectorsInner$ = command(async ({ get, set }) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(builtinConnectorsSearchContract.search));
  const connectors = await settle(
    set(builtinConnectorSearch$, {
      orgId: auth.orgId,
      userId: auth.userId,
      keyword: query.keyword,
    }),
  );
  if (!connectors.ok) {
    if (isConnectorCatalogUnavailableError(connectors.error)) {
      return providerUnavailable(
        "Connector catalog is temporarily unavailable",
      );
    }
    throw connectors.error;
  }
  return {
    status: 200 as const,
    body: { connectors: [...connectors.value] },
  };
});

const connectManualGrantBuiltinConnectorInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(
      pathParamsOf(builtinConnectorManualGrantContract.connect),
    );
    const bodyResult = await get(
      bodyResultOf(builtinConnectorManualGrantContract.connect),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const agentTarget = await set(
      validateConnectorAuthorizationTarget$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        agentId: bodyResult.data.agentId,
      },
      signal,
    );
    if (!agentTarget.ok) {
      return notFound(agentTarget.message);
    }

    const resolver = await set(readConnectorResolver$, [params.connectorSlug]);
    signal.throwIfAborted();
    const resolved = await resolver.resolveNewActionMethod({
      connectorSlug: params.connectorSlug,
      authMethodId: bodyResult.data.authMethod,
      expectedGrantKind: "manual",
    });
    signal.throwIfAborted();
    if (!resolved.ok) {
      return connectorMethodResolutionError(resolved, {
        connectorSlug: params.connectorSlug,
        authMethodId: bodyResult.data.authMethod,
        expectedGrantKind: "manual",
        expectedGrantLabel: "a manual grant",
      });
    }

    const result = await set(
      connectManualGrantBuiltinConnector$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        runtimeMethod: resolved.runtimeMethod,
        snapshot: resolved.snapshot,
        values: bodyResult.data.values,
        account: bodyResult.data.account,
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status === "invalid") {
      return badRequestMessage(result.message);
    }
    if (result.status !== "connected") {
      return connectorAccountMutationFailureResponse(result.status);
    }

    if (connectorAgentAuthorizationRequested(bodyResult.data)) {
      const authorization = await set(
        authorizeConnectedConnector$,
        {
          orgId: auth.orgId,
          userId: auth.userId,
          agentId: bodyResult.data.agentId ?? null,
          connectorSlug: resolved.connectorSlug,
        },
        signal,
      );
      if (authorization.status === "agentNotFound") {
        return notFound(authorization.message);
      }
    }

    return {
      status: 200 as const,
      body: { connectionId: result.connector.id },
    };
  },
);

const connectNoAuthBuiltinConnectorInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(
      pathParamsOf(builtinConnectorNoAuthGrantContract.connect),
    );
    const bodyResult = await get(
      bodyResultOf(builtinConnectorNoAuthGrantContract.connect),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const agentTarget = await set(
      validateConnectorAuthorizationTarget$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        agentId: bodyResult.data.agentId,
      },
      signal,
    );
    if (!agentTarget.ok) {
      return notFound(agentTarget.message);
    }

    const resolver = await set(readConnectorResolver$, [params.connectorSlug]);
    signal.throwIfAborted();
    const resolved = await resolver.resolveNewActionMethod({
      connectorSlug: params.connectorSlug,
      authMethodId: bodyResult.data.authMethod,
      expectedGrantKind: "none",
    });
    signal.throwIfAborted();
    if (!resolved.ok) {
      return connectorMethodResolutionError(resolved, {
        connectorSlug: params.connectorSlug,
        authMethodId: bodyResult.data.authMethod,
        expectedGrantKind: "none",
        expectedGrantLabel: "a no-auth grant",
      });
    }

    const result = await set(
      connectNoAuthBuiltinConnector$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        runtimeMethod: resolved.runtimeMethod,
        snapshot: resolved.snapshot,
        account: bodyResult.data.account,
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status !== "connected") {
      return connectorAccountMutationFailureResponse(result.status);
    }

    if (connectorAgentAuthorizationRequested(bodyResult.data)) {
      const authorization = await set(
        authorizeConnectedConnector$,
        {
          orgId: auth.orgId,
          userId: auth.userId,
          agentId: bodyResult.data.agentId ?? null,
          connectorSlug: resolved.connectorSlug,
        },
        signal,
      );
      if (authorization.status === "agentNotFound") {
        return notFound(authorization.message);
      }
    }

    return {
      status: 200 as const,
      body: { connectionId: result.connector.id },
    };
  },
);

const builtinOauthStartParams$ = pathParamsOf(
  builtinConnectorOauthStartContract.start,
);
const builtinOauthStartBodyResult$ = bodyResultOf(
  builtinConnectorOauthStartContract.start,
);

const builtinOauthStartAccountSelection$ = computed(async (get) => {
  const bodyResult = await get(builtinOauthStartBodyResult$);
  if (!bodyResult.ok) {
    return bodyResult;
  }
  const auth = get(organizationAuthContext$);
  const { connectorSlug } = get(builtinOauthStartParams$);
  const account = bodyResult.data.account;
  const db = get(db$);
  const selected =
    account.intent === "reconnect"
      ? await db
          .select({ id: connectors.id })
          .from(connectors)
          .where(
            and(
              eq(connectors.id, account.connectionId),
              eq(connectors.orgId, auth.orgId),
              eq(connectors.userId, auth.userId),
              eq(connectors.connectorSlug, connectorSlug),
            ),
          )
          .limit(1)
      : await db
          .select({ id: connectors.id })
          .from(connectors)
          .where(
            and(
              eq(connectors.orgId, auth.orgId),
              eq(connectors.userId, auth.userId),
              eq(connectors.connectorSlug, connectorSlug),
            ),
          )
          .orderBy(connectors.id)
          .limit(2);
  return {
    ok: true as const,
    selectedCount: selected.length,
    selectionCardinality:
      selected.length === 0
        ? "zero"
        : selected.length === 1
          ? "one"
          : "multiple",
  };
});

const accountMutationLog = logger("api:connector-account-mutation");

const startBuiltinConnectorOauthInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(builtinOauthStartParams$);
    const bodyResult = await get(builtinOauthStartBodyResult$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const request = get(request$).raw;
    const auth = get(authContext$);
    const connectorSlug = params.connectorSlug;
    if (!auth.orgId) {
      return badRequestMessage(
        "Explicit org context required — ensure active org in session",
      );
    }

    const agentTarget = await set(
      validateConnectorAuthorizationTarget$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        agentId: bodyResult.data.agentId,
      },
      signal,
    );
    if (!agentTarget.ok) {
      return badRequestMessage(agentTarget.message);
    }

    const resolver = await set(readConnectorResolver$, [connectorSlug]);
    signal.throwIfAborted();
    const resolved = await resolver.resolveNewActionMethod({
      connectorSlug,
      authMethodId: bodyResult.data.authMethod,
      expectedGrantKind: "auth-code",
    });
    signal.throwIfAborted();
    if (!resolved.ok) {
      return connectorMethodResolutionError(resolved, {
        connectorSlug,
        authMethodId: bodyResult.data.authMethod,
        expectedGrantKind: "auth-code",
        expectedGrantLabel: "an auth-code grant",
        missingGrantWhenAbsent: true,
      });
    }

    const method = resolved.method;
    if (method.grant.kind !== "auth-code") {
      return internalServerError("Connector execution is not configured");
    }

    const redirectUri = getBuiltinConnectorOAuthCallbackUrlForMethod({
      request,
      method,
      connectorSlug: resolved.connectorSlug,
      callbackTarget: bodyResult.data.callbackTarget,
    });
    const prepared = prepareBuiltinConnectorAuthCodeStartWithMethod({
      method,
      redirectUri,
      readEnv: optionalEnv,
    });
    if (!prepared.ok) {
      return internalServerError(`${connectorSlug} auth client not configured`);
    }
    const authResult = await buildBuiltinConnectorAuthCodeAuthUrlWithMethod({
      connectorSlug: resolved.connectorSlug,
      authMethodId: resolved.authMethodId,
      method,
      authClient: prepared.authClient,
      redirectUri: prepared.redirectUri,
      state: prepared.state,
    });
    signal.throwIfAborted();

    const selection = await get(builtinOauthStartAccountSelection$);
    signal.throwIfAborted();
    if (!selection.ok) {
      return selection.response;
    }
    const missing =
      bodyResult.data.account.intent === "reconnect" &&
      selection.selectedCount === 0;
    accountMutationLog.debug("Resolved connector account mutation", {
      targetKind: "builtin",
      intent: bodyResult.data.account.intent,
      selectionCardinality: selection.selectionCardinality,
      outcome: missing
        ? "missing"
        : bodyResult.data.account.intent === "add"
          ? "insert"
          : "update",
    });
    if (missing) {
      return connectorAccountMutationFailureResponse("missing");
    }

    const writeDb = set(writeDb$);
    const [oauthState] = await writeDb
      .insert(connectorOauthStates)
      .values({
        state: prepared.state,
        connectorSlug: resolved.connectorSlug,
        authMethod: resolved.authMethodId,
        userId: auth.userId,
        orgId: auth.orgId,
        agentId: bodyResult.data.agentId,
        authorizeAgent: connectorAgentAuthorizationRequested(bodyResult.data),
        redirectUri: prepared.redirectUri,
        authorizationUrl: authResult.url,
        oauthRequestedScopes: requestedScopeSnapshot(resolved.method.grant),
        codeVerifier: authResult.codeVerifier,
        oauthContext: authResult.oauthContext,
        accountMutation: bodyResult.data.account,
        expiresAt: connectorOAuthStateExpiresAt(),
      })
      .returning({ id: connectorOauthStates.id });
    signal.throwIfAborted();
    if (!oauthState) {
      throw new Error("Failed to create connector OAuth state");
    }

    return {
      status: 200 as const,
      body: {
        authorizationUrl: authResult.url,
        connectionId:
          bodyResult.data.account.intent === "add" ? oauthState.id : undefined,
        oauthAttemptId: oauthState.id,
      },
    };
  },
);

const builtinOpenIdStartParams$ = pathParamsOf(
  builtinConnectorOpenIdStartContract.start,
);
const builtinOpenIdStartBodyResult$ = bodyResultOf(
  builtinConnectorOpenIdStartContract.start,
);

const builtinOpenIdStartAccountSelection$ = computed(async (get) => {
  const bodyResult = await get(builtinOpenIdStartBodyResult$);
  if (!bodyResult.ok) {
    return bodyResult;
  }
  const auth = get(organizationAuthContext$);
  const { connectorSlug } = get(builtinOpenIdStartParams$);
  const account = bodyResult.data.account;
  const db = get(db$);
  const selected =
    account.intent === "reconnect"
      ? await db
          .select({ id: connectors.id })
          .from(connectors)
          .where(
            and(
              eq(connectors.id, account.connectionId),
              eq(connectors.orgId, auth.orgId),
              eq(connectors.userId, auth.userId),
              eq(connectors.connectorSlug, connectorSlug),
            ),
          )
          .limit(1)
      : await db
          .select({ id: connectors.id })
          .from(connectors)
          .where(
            and(
              eq(connectors.orgId, auth.orgId),
              eq(connectors.userId, auth.userId),
              eq(connectors.connectorSlug, connectorSlug),
            ),
          )
          .orderBy(connectors.id)
          .limit(2);
  return {
    ok: true as const,
    selectedCount: selected.length,
    selectionCardinality:
      selected.length === 0
        ? "zero"
        : selected.length === 1
          ? "one"
          : "multiple",
  };
});

const startBuiltinConnectorOpenIdInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(builtinOpenIdStartParams$);
    const bodyResult = await get(builtinOpenIdStartBodyResult$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const request = get(request$).raw;
    const auth = get(authContext$);
    const connectorSlug = params.connectorSlug;

    if (!auth.orgId) {
      return badRequestMessage(
        "Explicit org context required — ensure active org in session",
      );
    }

    const agentTarget = await set(
      validateConnectorAuthorizationTarget$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        agentId: bodyResult.data.agentId,
      },
      signal,
    );
    if (!agentTarget.ok) {
      return badRequestMessage(agentTarget.message);
    }

    const resolver = await set(readConnectorResolver$, [connectorSlug]);
    signal.throwIfAborted();
    const resolved = await resolver.resolveNewActionMethod({
      connectorSlug,
      authMethodId: bodyResult.data.authMethod,
      expectedGrantKind: "openid-auth",
    });
    signal.throwIfAborted();
    if (!resolved.ok) {
      return connectorMethodResolutionError(resolved, {
        connectorSlug,
        authMethodId: bodyResult.data.authMethod,
        expectedGrantKind: "openid-auth",
        expectedGrantLabel: "an OpenID auth grant",
        missingGrantWhenAbsent: true,
      });
    }

    if (resolved.method.grant.kind !== "openid-auth") {
      return internalServerError("Connector execution is not configured");
    }

    const prepared = prepareBuiltinConnectorOpenIdAuthStartWithMethod({
      connectorSlug: resolved.connectorSlug,
      method: resolved.method,
      origin: getBuiltinConnectorOpenIdCallbackOriginForMethod({
        request,
        method: resolved.method,
      }),
    });
    const authResult = await buildBuiltinConnectorOpenIdAuthUrlWithMethod({
      connectorSlug: resolved.connectorSlug,
      authMethodId: resolved.authMethodId,
      method: resolved.method,
      returnTo: prepared.returnTo,
      realm: prepared.realm,
      state: prepared.state,
    });
    signal.throwIfAborted();

    const selection = await get(builtinOpenIdStartAccountSelection$);
    signal.throwIfAborted();
    if (!selection.ok) {
      return selection.response;
    }
    const missing =
      bodyResult.data.account.intent === "reconnect" &&
      selection.selectedCount === 0;
    accountMutationLog.debug("Resolved connector account mutation", {
      targetKind: "builtin",
      intent: bodyResult.data.account.intent,
      selectionCardinality: selection.selectionCardinality,
      outcome: missing
        ? "missing"
        : bodyResult.data.account.intent === "add"
          ? "insert"
          : "update",
    });
    if (missing) {
      return connectorAccountMutationFailureResponse("missing");
    }

    const writeDb = set(writeDb$);
    const [oauthState] = await writeDb
      .insert(connectorOauthStates)
      .values({
        state: prepared.state,
        connectorSlug: resolved.connectorSlug,
        authMethod: resolved.authMethodId,
        userId: auth.userId,
        orgId: auth.orgId,
        agentId: bodyResult.data.agentId,
        authorizeAgent: connectorAgentAuthorizationRequested(bodyResult.data),
        redirectUri: prepared.expectedReturnTo,
        oauthRequestedScopes: requestedScopeSnapshot(resolved.method.grant),
        codeVerifier: authResult.codeVerifier,
        oauthContext: JSON.stringify({ realm: prepared.realm }),
        accountMutation: bodyResult.data.account,
        expiresAt: connectorOAuthStateExpiresAt(),
      })
      .returning({ id: connectorOauthStates.id });
    signal.throwIfAborted();
    if (!oauthState) {
      throw new Error("Failed to create connector OAuth state");
    }

    return {
      status: 200 as const,
      body: {
        authorizationUrl: authResult.url,
        connectionId:
          bodyResult.data.account.intent === "add" ? oauthState.id : undefined,
        oauthAttemptId: oauthState.id,
      },
    };
  },
);

export const builtinConnectorsRoutes: readonly RouteEntry[] = [
  {
    route: builtinConnectorManualGrantContract.connect,
    handler: authRoute(
      connectorWriteAuth,
      connectManualGrantBuiltinConnectorInner$,
    ),
  },
  {
    route: builtinConnectorNoAuthGrantContract.connect,
    handler: authRoute(connectorWriteAuth, connectNoAuthBuiltinConnectorInner$),
  },
  {
    route: builtinConnectorsSearchContract.search,
    handler: authRoute(connectorReadAuth, searchBuiltinConnectorsInner$),
  },
  {
    route: builtinConnectorsMainContract.list,
    handler: authRoute(connectorReadAuth, getBuiltinConnectorListInner$),
  },
  {
    route: builtinConnectorOauthStartContract.start,
    handler: authRoute(connectorWriteAuth, startBuiltinConnectorOauthInner$),
  },
  {
    route: builtinConnectorOpenIdStartContract.start,
    handler: authRoute(connectorWriteAuth, startBuiltinConnectorOpenIdInner$),
  },
];
