import { command } from "ccstate";
import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import { customConnectorOAuth2Contract } from "@okouai/api-contracts/contracts/custom-connectors";
import type { ConnectorOauthCallbackResult } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";

import { badRequestMessage } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$, setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import {
  claimConnectorOAuthState,
  getConnectorOAuthStateStatus,
  type StoredCustomConnectorOAuthState,
} from "../services/connector-oauth-state.service";
import { validateConnectorAuthorizationTarget$ } from "../services/connected-connector-authorization.service";
import {
  customConnectorOAuth2EffectiveInitialToken as effectiveInitialToken,
  customConnectorOAuthStateMatchesDefinition,
  isCustomConnectorAutomaticOAuthStateContext,
  isCustomConnectorCustomOAuthStateContext,
  decryptCustomConnectorOAuth2Credentials,
  exchangeCustomConnectorOAuth2Code,
  parseValidCustomConnectorOAuthState,
  startCustomConnectorOAuth2$,
  storeCustomConnectorOAuth2Connection,
  type OAuthTokenResult,
} from "../services/custom-connector-oauth2.service";
import {
  CustomConnectorAutomaticOAuthError,
  customConnectorAutomaticOAuthResourceMatchesEndpoint,
  exchangeCustomConnectorAutomaticOAuthCode,
  validateCustomConnectorAutomaticOAuthCallbackIssuer,
} from "../services/custom-connector-automatic-oauth.service";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import { addUserCustomConnector } from "../services/user-connectors.service";
import { commitConnectorRuntimeMutation } from "../services/connector-runtime-wakeup.service";
import { publishCustomConnectorUserInvalidationAfterCommit as publishCustomUserInvalidation } from "../services/connector-client-invalidation.service";
import { isCustomConnectorMcpEnabled } from "../services/custom-connector-mcp-feature.service";
import {
  getCustomConnectorById,
  type CustomConnectorOAuthConfigRow,
  type CustomConnectorRow,
} from "../services/custom-connector.service";
import { safeSync, tapError } from "../utils";
import type { RouteEntry } from "../route-entry";
import {
  connectorOAuthRedirectResponse,
  clearConnectorOAuthCookies,
} from "../../lib/connector-oauth-state";
import { env } from "../../lib/env";
import { recordConnectorOAuthCompletion } from "../services/connector-oauth-completion.service";
import { connectorConnectionWriteFailureMessage } from "../services/connector-data.service";
import { PUBLIC_BRAND } from "@okouai/core/public-brand";
import {
  okouMcpOAuthClientMetadata,
  okouMcpOAuthDynamicClientMetadata,
} from "../services/mcp-oauth-client-metadata.service";

const CUSTOM_CONNECTOR_OAUTH_CALLBACK_PATH = "/connectors/custom/callback";

function callbackRedirect(args: {
  readonly origin: string;
  readonly status: "success" | "error";
  readonly message?: string;
}): Response {
  const url = new URL(
    `/connectors/custom/callback/${args.status}`,
    args.origin,
  );
  if (args.message) {
    url.searchParams.set("message", args.message);
  }
  const response = connectorOAuthRedirectResponse(url.toString());
  clearConnectorOAuthCookies(response);
  return response;
}

function callbackError(origin: string, message: string): Response {
  return callbackRedirect({ origin, status: "error", message });
}

function appOrigin(): string {
  return new URL(env("APP_URL")).origin;
}

function okouOAuthRedirectUri(request: Request): string {
  const [redirectUri] = okouMcpOAuthClientMetadata(request).redirect_uris;
  if (!redirectUri) {
    throw new Error("Okou MCP OAuth callback is unavailable");
  }
  return redirectUri;
}

function callbackResultFromRedirect(
  response: Response,
): ConnectorOauthCallbackResult {
  const location = response.headers.get("location");
  if (!location) {
    throw new Error("Custom connector callback response is missing a redirect");
  }
  const url = new URL(location);
  if (url.pathname === "/connectors/custom/callback/success") {
    return { status: "success", username: null };
  }
  if (url.pathname === "/connectors/custom/callback/error") {
    return {
      status: "error",
      message:
        url.searchParams.get("message") ||
        "OAuth authorization failed. Please try again.",
    };
  }
  throw new Error(`Unexpected custom connector callback redirect: ${location}`);
}

const startOAuth2Inner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(customConnectorOAuth2Contract.start));
  const body = await get(bodyResultOf(customConnectorOAuth2Contract.start));
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
  signal.throwIfAborted();
  if (!agentTarget.ok) {
    return badRequestMessage(agentTarget.message);
  }
  const publicBrand = PUBLIC_BRAND;
  const redirectUri = new URL(
    CUSTOM_CONNECTOR_OAUTH_CALLBACK_PATH,
    appOrigin(),
  ).toString();
  const okouClientMetadata = okouMcpOAuthClientMetadata(get(request$).raw);
  const result = await set(
    startCustomConnectorOAuth2$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      connectorId: params.id,
      redirectUri,
      publicBrand,
      automaticOAuthClient: {
        redirectUri: okouOAuthRedirectUri(get(request$).raw),
        cimdClientId: okouClientMetadata.client_id,
        dcrClientMetadata: okouMcpOAuthDynamicClientMetadata(get(request$).raw),
      },
      agentId: body.data.agentId,
      account: body.data.account,
    },
    signal,
  );
  signal.throwIfAborted();
  if ("status" in result) {
    return result;
  }
  return { status: 200 as const, body: result };
});

function validateClaimedState(storedState: StoredCustomConnectorOAuthState):
  | {
      readonly ok: true;
      readonly context: NonNullable<
        ReturnType<typeof parseValidCustomConnectorOAuthState>
      >;
    }
  | { readonly ok: false } {
  const context = parseValidCustomConnectorOAuthState(storedState);
  if (!context) {
    return { ok: false };
  }
  return { ok: true, context };
}

function isCurrentOAuthCustomConnector(
  connector: CustomConnectorRow | null,
  context: NonNullable<ReturnType<typeof parseValidCustomConnectorOAuthState>>,
): connector is CustomConnectorRow & {
  readonly authMode: "oauth";
  readonly oauthConfig: CustomConnectorOAuthConfigRow;
} {
  return Boolean(
    connector &&
    isCustomConnectorCustomOAuthStateContext(context) &&
    connector.authMode === "oauth" &&
    connector.oauthConfig &&
    customConnectorOAuthStateMatchesDefinition(context, connector),
  );
}

function isCurrentAutomaticOAuthCustomConnector(
  connector: CustomConnectorRow | null,
  context: NonNullable<ReturnType<typeof parseValidCustomConnectorOAuthState>>,
): connector is CustomConnectorRow & {
  readonly kind: "mcp";
  readonly authMode: "automatic";
  readonly oauthConfig: null;
} {
  return Boolean(
    connector &&
    isCustomConnectorAutomaticOAuthStateContext(context) &&
    connector.kind === "mcp" &&
    connector.authMode === "automatic" &&
    connector.oauthConfig === null &&
    customConnectorAutomaticOAuthResourceMatchesEndpoint(
      context.resource,
      connector.endpoint,
    ) &&
    customConnectorOAuthStateMatchesDefinition(context, connector),
  );
}

async function authorizeCustomConnectorAgent(
  args: {
    readonly db: Db;
    readonly state: StoredCustomConnectorOAuthState;
    readonly connectorId: string;
  },
  signal: AbortSignal,
): Promise<string | null> {
  if (!args.state.authorizeAgent || !args.state.agentId) {
    return null;
  }
  const authorization = await addUserCustomConnector(args.db, {
    orgId: args.state.orgId,
    userId: args.state.userId,
    agentId: args.state.agentId,
    customConnectorId: args.connectorId,
  });
  signal.throwIfAborted();
  switch (authorization.status) {
    case "added": {
      return null;
    }
    case "agentNotFound": {
      return "OAuth connected, but the requested agent was not found";
    }
    case "customConnectorsNotFound": {
      return "OAuth connected, but the custom connector was not found";
    }
    case "customConnectorPermissionSelectionRequired": {
      return "OAuth connected, but connector permissions must be selected before authorizing the agent";
    }
    case "invalidCustomConnectorPermissions": {
      return `OAuth connected, but agent authorization failed: ${authorization.message}`;
    }
    case "mcpFeatureDisabled": {
      return "OAuth connected, but MCP custom connector management is not enabled";
    }
  }
}

async function recordAuthorizedCustomOAuthCompletion(
  args: {
    readonly db: Db;
    readonly state: StoredCustomConnectorOAuthState;
    readonly connectorId: string;
    readonly connectionId: string;
  },
  signal: AbortSignal,
): Promise<string | null> {
  const error = await authorizeCustomConnectorAgent(args, signal);
  if (error) {
    return error;
  }
  await recordConnectorOAuthCompletion(
    args.db,
    {
      attemptId: args.state.id,
      connectionId: args.connectionId,
      orgId: args.state.orgId,
      userId: args.state.userId,
    },
    signal,
  );
  return null;
}

type CustomOAuthPersistenceResult =
  | { readonly ok: true; readonly connectionId: string }
  | { readonly ok: false; readonly message: string };

async function persistCustomConnectorOAuth2Connection(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
    readonly storageVersion: number;
    readonly token: OAuthTokenResult;
    readonly featureContext: FeatureSwitchContext;
    readonly account: ConnectorAccountMutationIntent;
    readonly insertConnectionId?: string;
    readonly automaticOAuthBinding?: {
      readonly issuer: string;
      readonly resource: string;
      readonly resourceMetadataUrl: string | null;
      readonly tokenEndpoint: string;
      readonly clientId: string;
      readonly tokenEndpointAuthMethod:
        | "none"
        | "client_secret_basic"
        | "client_secret_post";
      readonly registrationMethod: "cimd" | "dcr";
      readonly dcrRegistrationId: string | null;
    };
  },
  signal: AbortSignal,
): Promise<CustomOAuthPersistenceResult> {
  const connectionStorage = storeCustomConnectorOAuth2Connection(args, signal);
  const result = await commitConnectorRuntimeMutation(connectionStorage, () => {
    return {
      db: args.db,
      scope: { orgId: args.orgId, userId: args.userId },
      targets: [{ kind: "custom", customConnectorId: args.connectorId }],
    };
  });
  if (result.kind !== "stored") {
    const status =
      result.kind === "missing"
        ? "accountNotFound"
        : result.kind === "ambiguous"
          ? "accountAmbiguous"
          : "siblingDisabled";
    return {
      ok: false,
      message: connectorConnectionWriteFailureMessage(status),
    };
  }
  await publishCustomUserInvalidation(args.userId, signal);
  return { ok: true, connectionId: result.connectionId };
}

function customConnectorOAuthPersistenceResult(
  result:
    | Awaited<ReturnType<typeof persistCustomConnectorOAuth2Connection>>
    | undefined,
): CustomOAuthPersistenceResult {
  if (!result) {
    return {
      ok: false,
      message: "OAuth token exchange failed - please try again",
    };
  }
  return result;
}

async function codeLessCustomOAuthCallbackResponse(
  args: { readonly db: Db; readonly origin: string; readonly state: string },
  signal: AbortSignal,
): Promise<Response> {
  const status = await getConnectorOAuthStateStatus(
    args.db,
    { state: args.state, target: { kind: "custom" } },
    signal,
  );
  signal.throwIfAborted();
  return status.kind === "usable"
    ? callbackError(appOrigin(), "Missing authorization code")
    : callbackError(args.origin, "Invalid OAuth state - please try again");
}

async function completeAutomaticOAuthCallback(
  args: {
    readonly db: Db;
    readonly request: Request;
    readonly state: StoredCustomConnectorOAuthState;
    readonly connector: CustomConnectorRow & {
      readonly kind: "mcp";
      readonly authMode: "automatic";
      readonly oauthConfig: null;
    };
    readonly context: NonNullable<
      ReturnType<typeof parseValidCustomConnectorOAuthState>
    > & { readonly authMode: "automatic" };
    readonly authorizationCode: string;
    readonly iss: string | undefined;
    readonly featureContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
): Promise<CustomOAuthPersistenceResult> {
  const completed = await tapError(
    (async () => {
      if (!args.state.codeVerifier) {
        throw new CustomConnectorAutomaticOAuthError(
          { kind: "binding-drift", reason: "binding-drift" },
          "Automatic OAuth state is missing its PKCE verifier",
        );
      }
      const clientMetadata = okouMcpOAuthClientMetadata(args.request);
      if (args.state.redirectUri !== okouOAuthRedirectUri(args.request)) {
        throw new CustomConnectorAutomaticOAuthError(
          { kind: "binding-drift", reason: "binding-drift" },
          "Automatic OAuth callback changed",
        );
      }
      const token = await exchangeCustomConnectorAutomaticOAuthCode(
        {
          db: args.db,
          context: args.context,
          redirectUri: args.state.redirectUri,
          cimdClientId: clientMetadata.client_id,
          code: args.authorizationCode,
          iss: args.iss,
          codeVerifier: args.state.codeVerifier,
          featureContext: args.featureContext,
        },
        signal,
      );
      signal.throwIfAborted();
      return await persistCustomConnectorOAuth2Connection(
        {
          db: args.db,
          orgId: args.state.orgId,
          userId: args.state.userId,
          connectorId: args.connector.id,
          storageVersion: args.connector.storageVersion,
          token: effectiveInitialToken(token, args.state.authorizationUrl),
          featureContext: args.featureContext,
          account: args.state.accountMutation,
          insertConnectionId:
            args.state.accountMutation.intent === "add"
              ? args.state.id
              : undefined,
          automaticOAuthBinding: {
            issuer: args.context.issuer,
            resource: args.context.resource,
            resourceMetadataUrl: args.context.resourceMetadataUrl,
            tokenEndpoint: args.context.tokenEndpoint,
            clientId: args.context.clientId,
            tokenEndpointAuthMethod: args.context.tokenEndpointAuthMethod,
            registrationMethod: args.context.registrationMethod,
            dcrRegistrationId:
              args.context.registrationMethod === "dcr"
                ? args.context.dcrRegistrationId
                : null,
          },
        },
        signal,
      );
    })(),
  );
  signal.throwIfAborted();
  return customConnectorOAuthPersistenceResult(completed);
}

async function completeCustomOAuthCallback(
  args: {
    readonly db: Db;
    readonly state: StoredCustomConnectorOAuthState;
    readonly connector: CustomConnectorRow & {
      readonly authMode: "oauth";
      readonly oauthConfig: CustomConnectorOAuthConfigRow;
    };
    readonly authorizationCode: string;
    readonly featureContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
): Promise<CustomOAuthPersistenceResult> {
  if (args.connector.oauthConfig.providerAdapter !== "standard") {
    return {
      ok: false,
      message: "OAuth callback was sent to the wrong connector endpoint",
    };
  }
  const credentials = await tapError(
    decryptCustomConnectorOAuth2Credentials(
      args.connector,
      args.featureContext,
    ),
  );
  signal.throwIfAborted();
  if (!credentials) {
    return { ok: false, message: "Could not read OAuth client credentials" };
  }
  const completed = await tapError(
    (async () => {
      const token = await exchangeCustomConnectorOAuth2Code(
        {
          config: args.connector.oauthConfig,
          clientSecret: credentials.clientSecret,
          code: args.authorizationCode,
          codeVerifier: args.state.codeVerifier,
          redirectUri: args.state.redirectUri,
        },
        signal,
      );
      signal.throwIfAborted();
      return await persistCustomConnectorOAuth2Connection(
        {
          db: args.db,
          orgId: args.state.orgId,
          userId: args.state.userId,
          connectorId: args.connector.id,
          storageVersion: args.connector.storageVersion,
          token: effectiveInitialToken(token, args.state.authorizationUrl),
          featureContext: args.featureContext,
          account: args.state.accountMutation,
          insertConnectionId:
            args.state.accountMutation.intent === "add"
              ? args.state.id
              : undefined,
        },
        signal,
      );
    })(),
  );
  signal.throwIfAborted();
  return customConnectorOAuthPersistenceResult(completed);
}

async function completeCurrentOAuthCallback(
  args: {
    readonly db: Db;
    readonly request: Request;
    readonly state: StoredCustomConnectorOAuthState;
    readonly connector: CustomConnectorRow;
    readonly context: NonNullable<
      ReturnType<typeof parseValidCustomConnectorOAuthState>
    >;
    readonly authorizationCode: string;
    readonly iss: string | undefined;
    readonly featureContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
): Promise<CustomOAuthPersistenceResult> {
  if (isCustomConnectorAutomaticOAuthStateContext(args.context)) {
    if (!isCurrentAutomaticOAuthCustomConnector(args.connector, args.context)) {
      throw new Error(
        "Custom connector OAuth configuration changed during callback",
      );
    }
    return await completeAutomaticOAuthCallback(
      {
        db: args.db,
        request: args.request,
        state: args.state,
        connector: args.connector,
        context: args.context,
        authorizationCode: args.authorizationCode,
        iss: args.iss,
        featureContext: args.featureContext,
      },
      signal,
    );
  }
  if (!isCurrentOAuthCustomConnector(args.connector, args.context)) {
    throw new Error(
      "Custom connector OAuth configuration changed during callback",
    );
  }
  return await completeCustomOAuthCallback(
    {
      db: args.db,
      state: args.state,
      connector: args.connector,
      authorizationCode: args.authorizationCode,
      featureContext: args.featureContext,
    },
    signal,
  );
}

const completeOAuth2Callback$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const query = get(queryOf(customConnectorOAuth2Contract.callback));
    const defaultOrigin = new URL(env("APP_URL")).origin;
    const oauthState = query.state;
    const authorizationCode = query.code ?? "";
    const providerError = query.error;
    if (!oauthState) {
      return callbackError(defaultOrigin, "Missing OAuth state");
    }
    if (!providerError && !authorizationCode) {
      return await codeLessCustomOAuthCallbackResponse(
        { db: set(writeDb$), origin: defaultOrigin, state: oauthState },
        signal,
      );
    }
    const claimed = await claimConnectorOAuthState(
      set(writeDb$),
      { state: oauthState, target: { kind: "custom" } },
      signal,
    );
    signal.throwIfAborted();
    if (claimed.kind !== "usable") {
      return callbackError(
        defaultOrigin,
        "Invalid OAuth state - please try again",
      );
    }
    const origin = appOrigin();
    const state = validateClaimedState(claimed.state);
    if (!state.ok) {
      return callbackError(origin, "Invalid OAuth state - please try again");
    }
    const automaticContext = isCustomConnectorAutomaticOAuthStateContext(
      state.context,
    )
      ? state.context
      : null;
    if (automaticContext) {
      const issuerValidation = safeSync(() => {
        validateCustomConnectorAutomaticOAuthCallbackIssuer(
          automaticContext,
          query.iss,
        );
        return true;
      });
      if (!("ok" in issuerValidation)) {
        return callbackError(
          origin,
          "OAuth authorization issuer did not match - please try again",
        );
      }
    }
    if (providerError) {
      return callbackError(origin, query.error_description ?? providerError);
    }
    const connector = await get(
      getCustomConnectorById({
        orgId: claimed.state.orgId,
        connectorId: state.context.connectorId,
      }),
    );
    signal.throwIfAborted();
    const currentCustom = isCurrentOAuthCustomConnector(
      connector,
      state.context,
    );
    const currentAutomatic = automaticContext
      ? isCurrentAutomaticOAuthCustomConnector(connector, automaticContext)
      : false;
    if (!currentCustom && !currentAutomatic) {
      return callbackError(
        origin,
        "Custom connector OAuth configuration changed - please try again",
      );
    }
    if (!connector) {
      throw new Error("Validated custom connector is unavailable");
    }
    const featureContext = await get(
      userFeatureSwitchContext(claimed.state.orgId, claimed.state.userId),
    );
    signal.throwIfAborted();
    if (
      connector.kind === "mcp" &&
      !isCustomConnectorMcpEnabled(featureContext)
    ) {
      return callbackError(
        origin,
        "MCP custom connector management is not enabled",
      );
    }
    const persistence = await completeCurrentOAuthCallback(
      {
        db: set(writeDb$),
        request: get(request$).raw,
        state: claimed.state,
        connector,
        context: state.context,
        authorizationCode,
        iss: query.iss,
        featureContext,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!persistence.ok) {
      return callbackError(origin, persistence.message);
    }
    const completionError = await recordAuthorizedCustomOAuthCompletion(
      {
        db: set(writeDb$),
        state: claimed.state,
        connectorId: connector.id,
        connectionId: persistence.connectionId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (completionError) {
      return callbackError(origin, completionError);
    }
    return callbackRedirect({ origin, status: "success" });
  },
);

const callbackOAuth2$ = command(async ({ get, set }, signal: AbortSignal) => {
  const query = get(queryOf(customConnectorOAuth2Contract.callback));
  const response = await set(completeOAuth2Callback$, signal);
  signal.throwIfAborted();
  if (query.responseMode !== "json") {
    return response;
  }
  set(setResHeader$, "Cache-Control", "no-store");
  for (const cookie of response.headers.getSetCookie()) {
    set(setResHeader$, "Set-Cookie", cookie, { append: true });
  }
  return { status: 200 as const, body: callbackResultFromRedirect(response) };
});

export const customConnectorOAuth2Routes: readonly RouteEntry[] = [
  {
    route: customConnectorOAuth2Contract.start,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "connector:write",
      },
      startOAuth2Inner$,
    ),
  },
  {
    route: customConnectorOAuth2Contract.callback,
    handler: callbackOAuth2$,
  },
];
