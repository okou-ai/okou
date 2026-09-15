import { command } from "ccstate";
import {
  connectorsSlugCallbackContract,
  type ConnectorOauthCallbackResult,
} from "@okouai/api-contracts/contracts/connectors-slug-callback";
import {
  connectorAuthMethodIdSchema,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  connectorGrantScopes,
  resolveConnectorAuthClient,
} from "@okouai/connectors/connector-auth-method";
import {
  exchangeConnectorAuthCodeWithMethod,
  verifyConnectorOpenIdAuthCallbackWithMethod,
  type ConnectorAuthProviderGrantResult,
} from "@okouai/connectors/auth-providers";

import { request$, setResHeader$ } from "../context/hono";
import { pathParamsOf, queryOf } from "../context/request";
import { db$, writeDb$, type Db } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { env, optionalEnv } from "../../lib/env";
import {
  claimConnectorOAuthState,
  getConnectorOAuthStateStatus,
  type StoredBuiltinOAuthState,
} from "../services/connector-oauth-state.service";
import { authorizeConnectedConnector$ } from "../services/connected-connector-authorization.service";
import { recordConnectorOAuthCompletion } from "../services/connector-oauth-completion.service";
import { publishBuiltinConnectorInvalidationAfterCommit } from "../services/connector-client-invalidation.service";
import {
  connectorActionResolverForSnapshot,
  type ConnectorActionResolver,
  type ResolvedConnectorActionMethod,
} from "../services/connector-action-resolver.service";
import {
  getConnectorRuntimeConnector,
  loadConnectorRuntimeSnapshot,
  type ConnectorRuntimeConnector,
  type ConnectorRuntimeSnapshot,
} from "../services/connector-catalog-runtime.service";
import {
  connectorConnectionWriteFailureMessage,
  upsertConnectorTokenConnection$,
} from "../services/connector-data.service";
import { resolveOAuthRequestedScopeSnapshot } from "../services/connector-oauth-scope-snapshot.service";
import {
  linkGithubUser,
  loadActiveGithubInstallationForOrg,
} from "../services/github-oauth.service";
import { safeJsonParse, tapError } from "../utils";
import { SLACK_CONNECTOR_OAUTH_STATE_PREFIX } from "../services/slack-connector-oauth-state";
import type { RouteEntry } from "../route-entry";
import {
  getConnectorOAuthCanonicalRedirectUrlForMethods,
  getConnectorOAuthOrigin,
} from "./connector-oauth-origin";
import {
  clearConnectorOAuthCookies,
  connectorOAuthRedirectResponse,
} from "../../lib/connector-oauth-state";
import { openIdRealmForOrigin } from "./connector-openid-auth-start";

type CallbackIdentity = {
  readonly userId: string;
  readonly orgId: string;
};

type CompleteOAuthCallbackInput = {
  readonly oauthAttemptId: string;
  readonly resolvedMethod: ResolvedConnectorActionMethod;
  readonly oauthRequestedScopes: readonly string[];
  readonly authorizationUrl: string | null;
  readonly code: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeVerifier: string | undefined;
  readonly oauthContext: string | undefined;
  readonly identity: CallbackIdentity;
  readonly agentId: string | null;
  readonly authorizeAgent: boolean;
  readonly origin: string;
  readonly connectorSlug: ConnectorSlug;
  readonly account: ConnectorAccountMutationIntent;
  readonly insertConnectionId?: string;
};

type CompleteOpenIdCallbackInput = {
  readonly oauthAttemptId: string;
  readonly resolvedMethod: ResolvedConnectorActionMethod;
  readonly oauthRequestedScopes: readonly string[];
  readonly callbackParams: Readonly<Record<string, string>>;
  readonly expectedReturnTo: string;
  readonly expectedRealm: string;
  readonly identity: CallbackIdentity;
  readonly agentId: string | null;
  readonly authorizeAgent: boolean;
  readonly origin: string;
  readonly connectorSlug: ConnectorSlug;
  readonly account: ConnectorAccountMutationIntent;
  readonly insertConnectionId?: string;
};

type ResolveCallbackStateInput = {
  readonly origin: string;
  readonly connectorSlug: ConnectorSlug;
  readonly storedState: StoredBuiltinOAuthState;
  readonly resolver: ConnectorActionResolver;
};

type ResolveOpenIdCallbackStateInput = {
  readonly origin: string;
  readonly connectorSlug: ConnectorSlug;
  readonly storedState: StoredBuiltinOAuthState;
  readonly resolver: ConnectorActionResolver;
};

type ResolvedCallbackState =
  | {
      readonly ok: true;
      readonly identity: CallbackIdentity;
      readonly agentId: string | null;
      readonly authorizeAgent: boolean;
      readonly codeVerifier: string | undefined;
      readonly oauthContext: string | undefined;
      readonly authorizationUrl: string | null;
      readonly oauthRequestedScopes: readonly string[];
      readonly redirectUri: string;
      readonly resolvedMethod: ResolvedConnectorActionMethod;
      readonly account: ConnectorAccountMutationIntent;
      readonly insertConnectionId?: string;
    }
  | {
      readonly ok: false;
      readonly response: Response;
    };

type ResolvedOpenIdCallbackState =
  | {
      readonly ok: true;
      readonly identity: CallbackIdentity;
      readonly agentId: string | null;
      readonly authorizeAgent: boolean;
      readonly expectedReturnTo: string;
      readonly expectedRealm: string;
      readonly oauthRequestedScopes: readonly string[];
      readonly resolvedMethod: ResolvedConnectorActionMethod;
      readonly account: ConnectorAccountMutationIntent;
      readonly insertConnectionId?: string;
    }
  | {
      readonly ok: false;
      readonly response: Response;
    };

type ClaimedCallbackState =
  | {
      readonly ok: true;
      readonly storedState: StoredBuiltinOAuthState;
    }
  | {
      readonly ok: false;
      readonly response: Response;
    };

type ConnectorCallbackQuery = Readonly<Record<string, string | undefined>>;

function callbackRequestedOauthScopes(
  storedScopes: string | null,
  resolvedMethod: ResolvedConnectorActionMethod,
): readonly string[] {
  return resolveOAuthRequestedScopeSnapshot(
    storedScopes,
    connectorGrantScopes(resolvedMethod.method.grant),
  );
}

function redirectWithError(
  origin: string,
  connectorSlug: string,
  message: string,
  clearCookies = false,
): Response {
  const errorUrl = new URL("/connector/error", origin);
  errorUrl.searchParams.set("connectorSlug", connectorSlug);
  errorUrl.searchParams.set("message", message);

  const response = connectorOAuthRedirectResponse(errorUrl.toString());
  if (clearCookies) {
    clearConnectorOAuthCookies(response);
  }
  return response;
}

function invalidStateRedirectResponse(
  origin: string,
  connectorSlug: string,
): Response {
  return redirectWithError(
    origin,
    connectorSlug,
    "Invalid state - please try again",
    true,
  );
}

function missingAuthorizationCodeRedirectResponse(
  origin: string,
  connectorSlug: string,
): Response {
  return redirectWithError(
    origin,
    connectorSlug,
    "Missing authorization code",
    true,
  );
}

function missingStateRedirectResponse(
  origin: string,
  connectorSlug: string,
): Response {
  return redirectWithError(
    origin,
    connectorSlug,
    "Missing state parameter",
    true,
  );
}

function appCallbackOrigin(): string {
  return new URL(env("APP_URL")).origin;
}

async function exchangeTokenForConnector(args: {
  readonly resolvedMethod: ResolvedConnectorActionMethod;
  readonly authorizationUrl: string | null;
  readonly code: string;
  readonly redirectUri: string;
  readonly state: string | undefined;
  readonly codeVerifier: string | undefined;
  readonly oauthContext: string | undefined;
}): Promise<ConnectorAuthProviderGrantResult> {
  if (
    args.resolvedMethod.method.grant.kind !== "auth-code" ||
    args.resolvedMethod.method.client === undefined
  ) {
    throw new Error("Connector execution is not configured");
  }
  const authClient = resolveConnectorAuthClient(
    args.resolvedMethod.method.client,
    optionalEnv,
  );
  if (!authClient) {
    throw new Error(
      `${args.resolvedMethod.connectorSlug} auth client not configured`,
    );
  }

  return await exchangeConnectorAuthCodeWithMethod({
    connectorSlug: args.resolvedMethod.connectorSlug,
    authMethodId: args.resolvedMethod.authMethodId,
    method: args.resolvedMethod.method,
    authClient,
    authorizationUrl: args.authorizationUrl,
    code: args.code,
    redirectUri: args.redirectUri,
    state: args.state,
    codeVerifier: args.codeVerifier,
    oauthContext: args.oauthContext,
  });
}

async function verifyOpenIdForConnector(
  args: {
    readonly resolvedMethod: ResolvedConnectorActionMethod;
    readonly callbackParams: Readonly<Record<string, string>>;
    readonly expectedReturnTo: string;
    readonly expectedRealm: string;
  },
  signal: AbortSignal,
): Promise<ConnectorAuthProviderGrantResult> {
  return await verifyConnectorOpenIdAuthCallbackWithMethod(
    {
      connectorSlug: args.resolvedMethod.connectorSlug,
      authMethodId: args.resolvedMethod.authMethodId,
      method: args.resolvedMethod.method,
      callbackParams: args.callbackParams,
      expectedReturnTo: args.expectedReturnTo,
      expectedRealm: args.expectedRealm,
    },
    signal,
  );
}

function resolveConnectorWithGrant(args: {
  readonly snapshot: ConnectorRuntimeSnapshot;
  readonly connectorSlug: ConnectorSlug;
  readonly grantKind: "auth-code" | "openid-auth";
  readonly origin: string;
}):
  | { readonly ok: true; readonly connector: ConnectorRuntimeConnector }
  | { readonly ok: false; readonly response: Response } {
  const connector = getConnectorRuntimeConnector(
    args.snapshot,
    args.connectorSlug,
  );
  if (!connector) {
    return {
      ok: false,
      response: redirectWithError(
        args.origin,
        args.connectorSlug,
        "Unknown connector slug",
      ),
    };
  }
  if (
    ![...connector.methods.values()].some((runtimeMethod) => {
      return runtimeMethod.method.grant.kind === args.grantKind;
    })
  ) {
    const label = args.grantKind === "auth-code" ? "auth-code" : "OpenID auth";
    return {
      ok: false,
      response: redirectWithError(
        args.origin,
        args.connectorSlug,
        `${args.connectorSlug} connector does not use an ${label} grant`,
      ),
    };
  }
  return { ok: true, connector };
}

async function claimStoredOAuthStateForCallback(
  args: {
    readonly db: Db;
    readonly state: string;
    readonly connectorSlug: ConnectorSlug;
    readonly origin: string;
  },
  signal: AbortSignal,
): Promise<ClaimedCallbackState> {
  const storedStateResolution = await claimConnectorOAuthState(
    args.db,
    {
      state: args.state,
      target: { kind: "builtin", connectorSlug: args.connectorSlug },
    },
    signal,
  );
  if (storedStateResolution.kind === "invalid") {
    return {
      ok: false,
      response: invalidStateRedirectResponse(args.origin, args.connectorSlug),
    };
  }
  if (storedStateResolution.kind === "missing") {
    return {
      ok: false,
      response: invalidStateRedirectResponse(args.origin, args.connectorSlug),
    };
  }

  return {
    ok: true,
    storedState: storedStateResolution.state,
  };
}

async function rejectInvalidStoredOAuthStateForCallback(
  args: {
    readonly db: Db;
    readonly state: string;
    readonly connectorSlug: ConnectorSlug;
    readonly origin: string;
  },
  signal: AbortSignal,
): Promise<
  | { readonly ok: true; readonly origin: string }
  | { readonly ok: false; readonly response: Response }
> {
  const status = await getConnectorOAuthStateStatus(
    args.db,
    {
      state: args.state,
      target: { kind: "builtin", connectorSlug: args.connectorSlug },
    },
    signal,
  );
  if (status.kind === "usable") {
    return {
      ok: true,
      origin: appCallbackOrigin(),
    };
  }

  return {
    ok: false,
    response: invalidStateRedirectResponse(args.origin, args.connectorSlug),
  };
}

function invalidStoredAuthMethodResponse(
  origin: string,
  connectorSlug: string,
): Response {
  return redirectWithError(
    origin,
    connectorSlug,
    "Invalid connector auth method - please try again",
    true,
  );
}

async function resolveStoredCallbackMethod(args: {
  readonly resolver: ConnectorActionResolver;
  readonly connectorSlug: ConnectorSlug;
  readonly authMethod: string;
  readonly expectedGrantKind: "auth-code" | "openid-auth";
  readonly origin: string;
}): Promise<
  | {
      readonly ok: true;
      readonly resolvedMethod: ResolvedConnectorActionMethod;
    }
  | { readonly ok: false; readonly response: Response }
> {
  const authMethodResult = connectorAuthMethodIdSchema.safeParse(
    args.authMethod,
  );
  if (!authMethodResult.success) {
    return {
      ok: false,
      response: invalidStoredAuthMethodResponse(
        args.origin,
        args.connectorSlug,
      ),
    };
  }

  const resolvedMethod = await args.resolver.resolveMethod({
    connectorSlug: args.connectorSlug,
    authMethodId: authMethodResult.data,
    expectedGrantKind: args.expectedGrantKind,
  });
  if (!resolvedMethod.ok) {
    return {
      ok: false,
      response: invalidStoredAuthMethodResponse(
        args.origin,
        args.connectorSlug,
      ),
    };
  }

  return {
    ok: true,
    resolvedMethod,
  };
}

async function linkGithubIntegrationAfterConnectorConnect(
  args: {
    readonly db: Db;
    readonly connectorSlug: ConnectorSlug;
    readonly identity: CallbackIdentity;
    readonly token: ConnectorAuthProviderGrantResult;
  },
  signal: AbortSignal,
): Promise<void> {
  if (args.connectorSlug !== "github") {
    return;
  }

  const installation = await loadActiveGithubInstallationForOrg(
    {
      db: args.db,
      orgId: args.identity.orgId,
    },
    signal,
  );
  if (!installation) {
    return;
  }

  const githubUserId = await linkGithubUser(
    {
      db: args.db,
      installRecordId: installation.id,
      userId: args.identity.userId,
      knownGithubUserId: args.token.userInfo.id,
    },
    signal,
  );
  signal.throwIfAborted();

  if (githubUserId) {
    await publishUserSignal([args.identity.userId], "github:changed");
  }
}

function successRedirectResponse(args: {
  readonly origin: string;
  readonly connectorSlug: ConnectorSlug;
  readonly username: string | null | undefined;
}): Response {
  const successUrl = new URL("/connector/success", args.origin);
  successUrl.searchParams.set("connectorSlug", args.connectorSlug);
  successUrl.searchParams.set("username", args.username ?? "");

  const response = connectorOAuthRedirectResponse(successUrl.toString());
  clearConnectorOAuthCookies(response);
  return response;
}

function callbackResultFromRedirect(
  response: Response,
): ConnectorOauthCallbackResult {
  const location = response.headers.get("location");
  if (!location) {
    throw new Error("Connector callback response is missing a redirect");
  }
  const url = new URL(location);
  if (url.pathname === "/connector/success") {
    return {
      status: "success",
      username: url.searchParams.get("username") || null,
    };
  }
  if (url.pathname === "/connector/error") {
    return {
      status: "error",
      message:
        url.searchParams.get("message") ||
        "OAuth authorization failed. Please try again.",
    };
  }
  throw new Error(`Unexpected connector callback redirect: ${location}`);
}

function callbackOAuthContext(args: {
  readonly storedContext: string | undefined;
  readonly realmId: string | undefined;
  readonly domain: string | undefined;
}): string | undefined {
  if (!args.realmId && !args.domain) {
    return args.storedContext;
  }
  return JSON.stringify({
    ...(args.storedContext ? { storedContext: args.storedContext } : {}),
    ...(args.realmId ? { realmId: args.realmId } : {}),
    ...(args.domain ? { domain: args.domain } : {}),
  });
}

const completeOAuthCallback$ = command(
  async (
    { set },
    args: CompleteOAuthCallbackInput,
    signal: AbortSignal,
  ): Promise<Response> => {
    const token = await exchangeTokenForConnector({
      resolvedMethod: args.resolvedMethod,
      authorizationUrl: args.authorizationUrl,
      code: args.code,
      redirectUri: args.redirectUri,
      state: args.state,
      codeVerifier: args.codeVerifier,
      oauthContext: args.oauthContext,
    });
    signal.throwIfAborted();

    const result = await set(
      upsertConnectorTokenConnection$,
      {
        orgId: args.identity.orgId,
        userId: args.identity.userId,
        runtimeMethod: args.resolvedMethod.runtimeMethod,
        snapshot: args.resolvedMethod.snapshot,
        outputs: token.outputs,
        userInfo: token.userInfo,
        oauthRequestedScopes: args.oauthRequestedScopes,
        oauthGrantedScopes: token.scopes,
        expiresIn: token.expiresIn,
        extraConnectorSecrets: token.extraConnectorSecrets,
        account: args.account,
        matchExistingExternalIdentity:
          args.resolvedMethod.connectorSlug === "github" &&
          args.account.intent === "add",
        insertConnectionId: args.insertConnectionId,
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status !== "connected") {
      return redirectWithError(
        args.origin,
        args.connectorSlug,
        connectorConnectionWriteFailureMessage(result.status),
        true,
      );
    }

    if (args.authorizeAgent) {
      const authorization = await set(
        authorizeConnectedConnector$,
        {
          orgId: args.identity.orgId,
          userId: args.identity.userId,
          agentId: args.agentId,
          connectorSlug: args.resolvedMethod.connectorSlug,
        },
        signal,
      );
      if (authorization.status === "agentNotFound") {
        return redirectWithError(
          args.origin,
          args.connectorSlug,
          authorization.message,
          true,
        );
      }
    }

    await linkGithubIntegrationAfterConnectorConnect(
      {
        db: set(writeDb$),
        connectorSlug: args.resolvedMethod.connectorSlug,
        identity: args.identity,
        token,
      },
      signal,
    );
    signal.throwIfAborted();

    await recordConnectorOAuthCompletion(
      set(writeDb$),
      {
        attemptId: args.oauthAttemptId,
        connectionId: result.connector.id,
        ...args.identity,
      },
      signal,
    );
    await publishBuiltinConnectorInvalidationAfterCommit(
      {
        userId: args.identity.userId,
        connectorSlug: args.connectorSlug,
      },
      signal,
    );

    return successRedirectResponse({
      origin: args.origin,
      connectorSlug: args.connectorSlug,
      username: result.connector.externalUsername,
    });
  },
);

const completeOpenIdCallback$ = command(
  async (
    { set },
    args: CompleteOpenIdCallbackInput,
    signal: AbortSignal,
  ): Promise<Response> => {
    const token = await verifyOpenIdForConnector(
      {
        resolvedMethod: args.resolvedMethod,
        callbackParams: args.callbackParams,
        expectedReturnTo: args.expectedReturnTo,
        expectedRealm: args.expectedRealm,
      },
      signal,
    );
    signal.throwIfAborted();

    const result = await set(
      upsertConnectorTokenConnection$,
      {
        orgId: args.identity.orgId,
        userId: args.identity.userId,
        runtimeMethod: args.resolvedMethod.runtimeMethod,
        snapshot: args.resolvedMethod.snapshot,
        outputs: token.outputs,
        userInfo: token.userInfo,
        oauthRequestedScopes: args.oauthRequestedScopes,
        oauthGrantedScopes: token.scopes,
        expiresIn: token.expiresIn,
        extraConnectorSecrets: token.extraConnectorSecrets,
        account: args.account,
        insertConnectionId: args.insertConnectionId,
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status !== "connected") {
      return redirectWithError(
        args.origin,
        args.connectorSlug,
        connectorConnectionWriteFailureMessage(result.status),
        true,
      );
    }

    if (args.authorizeAgent) {
      const authorization = await set(
        authorizeConnectedConnector$,
        {
          orgId: args.identity.orgId,
          userId: args.identity.userId,
          agentId: args.agentId,
          connectorSlug: args.resolvedMethod.connectorSlug,
        },
        signal,
      );
      if (authorization.status === "agentNotFound") {
        return redirectWithError(
          args.origin,
          args.connectorSlug,
          authorization.message,
          true,
        );
      }
    }

    await recordConnectorOAuthCompletion(
      set(writeDb$),
      {
        attemptId: args.oauthAttemptId,
        connectionId: result.connector.id,
        ...args.identity,
      },
      signal,
    );
    await publishBuiltinConnectorInvalidationAfterCommit(
      {
        userId: args.identity.userId,
        connectorSlug: args.connectorSlug,
      },
      signal,
    );

    return successRedirectResponse({
      origin: args.origin,
      connectorSlug: args.connectorSlug,
      username: result.connector.externalUsername,
    });
  },
);

async function resolveCallbackState(
  args: ResolveCallbackStateInput,
  signal: AbortSignal,
): Promise<ResolvedCallbackState> {
  const authMethodResult = await resolveStoredCallbackMethod({
    resolver: args.resolver,
    connectorSlug: args.connectorSlug,
    authMethod: args.storedState.authMethod,
    expectedGrantKind: "auth-code",
    origin: args.origin,
  });
  signal.throwIfAborted();
  if (!authMethodResult.ok) {
    return authMethodResult;
  }

  return {
    ok: true,
    identity: {
      userId: args.storedState.userId,
      orgId: args.storedState.orgId,
    },
    agentId: args.storedState.agentId,
    authorizeAgent: args.storedState.authorizeAgent,
    resolvedMethod: authMethodResult.resolvedMethod,
    codeVerifier: args.storedState.codeVerifier ?? undefined,
    oauthContext: args.storedState.oauthContext ?? undefined,
    authorizationUrl: args.storedState.authorizationUrl,
    oauthRequestedScopes: callbackRequestedOauthScopes(
      args.storedState.oauthRequestedScopes,
      authMethodResult.resolvedMethod,
    ),
    redirectUri: args.storedState.redirectUri,
    account: args.storedState.accountMutation,
    insertConnectionId:
      args.storedState.accountMutation.intent === "add"
        ? args.storedState.id
        : undefined,
  };
}

function storedOpenIdRealm(
  storedContext: string | null,
  expectedReturnTo: string,
): string {
  if (storedContext) {
    const parsed = safeJsonParse(storedContext);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "realm" in parsed &&
      typeof parsed.realm === "string"
    ) {
      return parsed.realm;
    }
  }
  return openIdRealmForOrigin(new URL(expectedReturnTo).origin);
}

async function resolveOpenIdCallbackState(
  args: ResolveOpenIdCallbackStateInput,
  signal: AbortSignal,
): Promise<ResolvedOpenIdCallbackState> {
  const authMethodResult = await resolveStoredCallbackMethod({
    resolver: args.resolver,
    connectorSlug: args.connectorSlug,
    authMethod: args.storedState.authMethod,
    expectedGrantKind: "openid-auth",
    origin: args.origin,
  });
  signal.throwIfAborted();
  if (!authMethodResult.ok) {
    return authMethodResult;
  }

  return {
    ok: true,
    identity: {
      userId: args.storedState.userId,
      orgId: args.storedState.orgId,
    },
    agentId: args.storedState.agentId,
    authorizeAgent: args.storedState.authorizeAgent,
    resolvedMethod: authMethodResult.resolvedMethod,
    expectedReturnTo: args.storedState.redirectUri,
    expectedRealm: storedOpenIdRealm(
      args.storedState.oauthContext,
      args.storedState.redirectUri,
    ),
    oauthRequestedScopes: callbackRequestedOauthScopes(
      args.storedState.oauthRequestedScopes,
      authMethodResult.resolvedMethod,
    ),
    account: args.storedState.accountMutation,
    insertConnectionId:
      args.storedState.accountMutation.intent === "add"
        ? args.storedState.id
        : undefined,
  };
}

function hasOpenIdCallbackFields(query: ConnectorCallbackQuery): boolean {
  return Object.keys(query).some((name) => {
    return name.startsWith("openid.");
  });
}

function openIdCallbackParamsFromQuery(
  query: ConnectorCallbackQuery,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(query).flatMap(([name, value]) => {
      return value === undefined || !name.startsWith("openid.")
        ? []
        : ([[name, value]] as const);
    }),
  );
}

const handleOpenIdConnectorCallback$ = command(
  async (
    { get, set },
    args: {
      readonly connectorSlug: ConnectorSlug;
      readonly query: ConnectorCallbackQuery;
      readonly origin: string;
      readonly snapshot: ConnectorRuntimeSnapshot;
    },
    signal: AbortSignal,
  ): Promise<Response> => {
    const connectorResult = resolveConnectorWithGrant({
      snapshot: args.snapshot,
      connectorSlug: args.connectorSlug,
      grantKind: "openid-auth",
      origin: args.origin,
    });
    if (!connectorResult.ok) {
      return connectorResult.response;
    }
    const state = args.query.state;
    if (!state) {
      return missingStateRedirectResponse(args.origin, args.connectorSlug);
    }

    const claimedState = await claimStoredOAuthStateForCallback(
      {
        db: set(writeDb$),
        connectorSlug: args.connectorSlug,
        origin: args.origin,
        state,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!claimedState.ok) {
      return claimedState.response;
    }
    const callbackOrigin = appCallbackOrigin();

    const resolver = await get(
      connectorActionResolverForSnapshot(args.snapshot),
    );
    signal.throwIfAborted();
    const resolvedState = await resolveOpenIdCallbackState(
      {
        origin: callbackOrigin,
        connectorSlug: args.connectorSlug,
        storedState: claimedState.storedState,
        resolver,
      },
      signal,
    );
    if (!resolvedState.ok) {
      return resolvedState.response;
    }

    const callbackResponse = await tapError(
      set(
        completeOpenIdCallback$,
        {
          oauthAttemptId: claimedState.storedState.id,
          resolvedMethod: resolvedState.resolvedMethod,
          oauthRequestedScopes: resolvedState.oauthRequestedScopes,
          callbackParams: openIdCallbackParamsFromQuery(args.query),
          expectedReturnTo: resolvedState.expectedReturnTo,
          expectedRealm: resolvedState.expectedRealm,
          identity: resolvedState.identity,
          agentId: resolvedState.agentId,
          authorizeAgent: resolvedState.authorizeAgent,
          account: resolvedState.account,
          insertConnectionId: resolvedState.insertConnectionId,
          origin: callbackOrigin,
          connectorSlug: args.connectorSlug,
        },
        signal,
      ),
    );
    signal.throwIfAborted();

    if (callbackResponse) {
      return callbackResponse;
    }

    return redirectWithError(
      callbackOrigin,
      args.connectorSlug,
      "OpenID authorization failed. Please try again.",
      true,
    );
  },
);

function requestMatchesStoredCallback(
  request: Request,
  redirectUri: string,
): boolean {
  const requestUrl = new URL(request.url);
  const storedCallbackUrl = new URL(redirectUri);
  return (
    requestUrl.origin === storedCallbackUrl.origin &&
    requestUrl.pathname === storedCallbackUrl.pathname
  );
}

async function authCodeCallbackPreflight(
  db: Db,
  args: {
    readonly connectorSlug: ConnectorSlug;
    readonly query: ConnectorCallbackQuery;
    readonly request: Request;
    readonly origin: string;
    readonly snapshot: ConnectorRuntimeSnapshot;
  },
  signal: AbortSignal,
): Promise<Response | null> {
  const connectorResult = resolveConnectorWithGrant({
    snapshot: args.snapshot,
    connectorSlug: args.connectorSlug,
    grantKind: "auth-code",
    origin: args.origin,
  });
  if (!connectorResult.ok) {
    return connectorResult.response;
  }
  if (args.query.responseMode === "json") {
    return null;
  }
  const canonicalRedirectUrl = getConnectorOAuthCanonicalRedirectUrlForMethods(
    args.request,
    [...connectorResult.connector.methods.values()]
      .filter((runtimeMethod) => {
        return runtimeMethod.executable;
      })
      .map((runtimeMethod) => {
        return runtimeMethod.method;
      }),
  );
  if (!canonicalRedirectUrl) {
    return null;
  }
  if (args.connectorSlug === "github" && args.query.state) {
    const stateStatus = await getConnectorOAuthStateStatus(
      db,
      {
        state: args.query.state,
        target: { kind: "builtin", connectorSlug: args.connectorSlug },
      },
      signal,
    );
    signal.throwIfAborted();
    if (
      stateStatus.kind === "usable" &&
      requestMatchesStoredCallback(args.request, stateStatus.redirectUri)
    ) {
      return null;
    }
  }
  return connectorOAuthRedirectResponse(canonicalRedirectUrl);
}

function storedOAuthStateCallbackArgs(
  db: Db,
  args: { readonly connectorSlug: ConnectorSlug; readonly origin: string },
) {
  return {
    db,
    connectorSlug: args.connectorSlug,
    origin: args.origin,
  };
}

async function authCodeProviderErrorResponse(
  db: Db,
  args: {
    readonly connectorSlug: ConnectorSlug;
    readonly query: ConnectorCallbackQuery;
    readonly origin: string;
  },
  signal: AbortSignal,
): Promise<Response> {
  let callbackOrigin = args.origin;
  if (args.query.state) {
    const claimedState = await claimStoredOAuthStateForCallback(
      {
        ...storedOAuthStateCallbackArgs(db, args),
        state: args.query.state,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!claimedState.ok) {
      return claimedState.response;
    }
    callbackOrigin = appCallbackOrigin();
  }
  return redirectWithError(
    callbackOrigin,
    args.connectorSlug,
    args.query.error_description ||
      args.query.error ||
      "OAuth authorization failed",
    true,
  );
}

async function missingAuthCodeResponse(
  db: Db,
  args: {
    readonly connectorSlug: ConnectorSlug;
    readonly query: ConnectorCallbackQuery;
    readonly origin: string;
  },
  signal: AbortSignal,
): Promise<Response> {
  let callbackOrigin = args.origin;
  if (args.query.state) {
    const stateStatus = await rejectInvalidStoredOAuthStateForCallback(
      {
        ...storedOAuthStateCallbackArgs(db, args),
        state: args.query.state,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!stateStatus.ok) {
      return stateStatus.response;
    }
    callbackOrigin = stateStatus.origin;
  }
  return missingAuthorizationCodeRedirectResponse(
    callbackOrigin,
    args.connectorSlug,
  );
}

const handleAuthCodeConnectorCallback$ = command(
  async (
    { get, set },
    args: {
      readonly connectorSlug: ConnectorSlug;
      readonly query: ConnectorCallbackQuery;
      readonly request: Request;
      readonly origin: string;
      readonly snapshot: ConnectorRuntimeSnapshot;
    },
    signal: AbortSignal,
  ): Promise<Response> => {
    // Combined Slack grants must validate workspace and member identity in the
    // integration callback before either connection can be created.
    if (args.query.state?.startsWith(SLACK_CONNECTOR_OAUTH_STATE_PREFIX)) {
      return invalidStateRedirectResponse(args.origin, args.connectorSlug);
    }
    const preflightResponse = await authCodeCallbackPreflight(
      set(writeDb$),
      args,
      signal,
    );
    if (preflightResponse) {
      return preflightResponse;
    }

    const state = args.query.state;

    if (args.query.error) {
      return await authCodeProviderErrorResponse(set(writeDb$), args, signal);
    }

    const code = args.query.code ?? args.query.auth_code;
    if (!code) {
      return await missingAuthCodeResponse(set(writeDb$), args, signal);
    }

    if (!state) {
      return missingStateRedirectResponse(args.origin, args.connectorSlug);
    }

    const claimedState = await claimStoredOAuthStateForCallback(
      {
        ...storedOAuthStateCallbackArgs(set(writeDb$), args),
        state,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!claimedState.ok) {
      return claimedState.response;
    }
    const callbackOrigin = appCallbackOrigin();

    const resolver = await get(
      connectorActionResolverForSnapshot(args.snapshot),
    );
    signal.throwIfAborted();
    const resolvedState = await resolveCallbackState(
      {
        origin: callbackOrigin,
        connectorSlug: args.connectorSlug,
        storedState: claimedState.storedState,
        resolver,
      },
      signal,
    );
    if (!resolvedState.ok) {
      return resolvedState.response;
    }

    const callbackResponse = await tapError(
      set(
        completeOAuthCallback$,
        {
          oauthAttemptId: claimedState.storedState.id,
          resolvedMethod: resolvedState.resolvedMethod,
          oauthRequestedScopes: resolvedState.oauthRequestedScopes,
          authorizationUrl: resolvedState.authorizationUrl,
          code,
          redirectUri: resolvedState.redirectUri,
          state,
          codeVerifier: resolvedState.codeVerifier,
          oauthContext: callbackOAuthContext({
            storedContext: resolvedState.oauthContext,
            realmId: args.query.realmId,
            domain: args.query.domain,
          }),
          identity: resolvedState.identity,
          agentId: resolvedState.agentId,
          authorizeAgent: resolvedState.authorizeAgent,
          account: resolvedState.account,
          insertConnectionId: resolvedState.insertConnectionId,
          origin: callbackOrigin,
          connectorSlug: args.connectorSlug,
        },
        signal,
      ),
    );
    signal.throwIfAborted();

    return (
      callbackResponse ??
      redirectWithError(
        callbackOrigin,
        args.connectorSlug,
        "OAuth authorization failed. Please try again.",
        true,
      )
    );
  },
);

const callbackConnectorInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const { connectorSlug } = get(
      pathParamsOf(connectorsSlugCallbackContract.callback),
    );
    const query = get(queryOf(connectorsSlugCallbackContract.callback));
    const request = get(request$).raw;
    const origin = getConnectorOAuthOrigin(request);
    const snapshot = await loadConnectorRuntimeSnapshot(get(db$));
    signal.throwIfAborted();

    const response = hasOpenIdCallbackFields(query)
      ? await set(
          handleOpenIdConnectorCallback$,
          {
            connectorSlug,
            query,
            origin,
            snapshot,
          },
          signal,
        )
      : await set(
          handleAuthCodeConnectorCallback$,
          {
            connectorSlug,
            query,
            request,
            origin,
            snapshot,
          },
          signal,
        );
    signal.throwIfAborted();

    if (query.responseMode !== "json") {
      return response;
    }

    set(setResHeader$, "Cache-Control", "no-store");
    for (const cookie of response.headers.getSetCookie()) {
      set(setResHeader$, "Set-Cookie", cookie, { append: true });
    }
    return { status: 200 as const, body: callbackResultFromRedirect(response) };
  },
);

export const connectorsSlugCallbackRoutes: readonly RouteEntry[] = [
  {
    route: connectorsSlugCallbackContract.callback,
    handler: callbackConnectorInner$,
  },
];
