import { accept } from "@okouai/connectors/accept";
import { command } from "ccstate";
import { agents } from "@okouai/db/schema/agent";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { eq, and } from "drizzle-orm";
import { array, number, object, string } from "zod";
import {
  githubOauthContract,
  type GithubAppSetupCallbackQuery,
  type GithubOauthConnectQuery,
} from "@okouai/api-contracts/contracts/github-oauth";
import { connectorGrantScopes } from "@okouai/connectors/connector-auth-method";
import {
  exchangeGitHubCode,
  fetchGitHubUserInfo,
} from "@okouai/connectors/auth-providers/connectors/github/oauth";

import { requiredAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { checkOAuthCallbackActor$ } from "../services/oauth-callback-actor";
import {
  integrationOAuthAppRedirect,
  integrationOAuthCallbackResponse,
  setIntegrationOAuthCallbackHeaders$,
} from "../services/integration-oauth-callback";
import { queryOf } from "../context/request";
import { authorization$, request$ } from "../context/hono";
import { db$, writeDb$ } from "../external/db";
import { claimBuiltinConnectorOAuthState$ } from "../services/connector-oauth-state.service";
import { publishUserSignal } from "../external/realtime";
import { env, optionalEnv } from "../../lib/env";
import { getMemberRoleAndUpdateCache$ } from "../services/auth.service";
import {
  readConnectorResolver$,
  type ConnectorActionResolver,
  type ResolvedConnectorActionMethod,
} from "../services/connector-action-resolver.service";
import { isConnectorCatalogUnavailableError } from "../services/connector-catalog-reader.service";
import {
  buildGithubAppInstallUrl$,
  startGithubUserOAuth$,
  createOrActivateGithubInstallation$,
  findGithubInstallationByInstallationId$,
  getGithubInstallationAccessToken,
  getGithubInstallationInfo,
  getGithubOAuthAuthMethod,
  isGithubOauthStateSignatureValid,
  linkGithubUser$,
  loadActiveGithubInstallationForOrg$,
  loadComposeFeatureSwitchContext$,
  parseGithubOauthState,
  resolveGithubOauthOrgId$,
  tryLinkGithubFromLocalRecord$,
  verifyGithubConnectSignature,
} from "../services/github-oauth.service";
import { encryptPersistentSecretValue } from "../services/crypto.utils";
import { upsertBuiltinConnectorTokenConnection$ } from "../services/connector-data.service";
import { safeJsonParse, settle } from "../utils";
import type { RouteEntry } from "../route-entry";
import { getOAuthApiOrigin } from "../../lib/oauth-origin";

const REDIRECT_STATUS = 307;
const GITHUB_CONNECTOR_SLUG = "github";

function redirectResponse(url: string): Response {
  return new Response(null, {
    status: REDIRECT_STATUS,
    headers: { location: url },
  });
}

function noStoreRedirect(url: string): Response {
  return new Response(null, {
    status: REDIRECT_STATUS,
    headers: { location: url, "Cache-Control": "no-store" },
  });
}

function jsonErrorResponse(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function appUrl(path: string): string {
  return `${env("APP_URL")}${path}`;
}

function githubApiOrigin(request: Request): string {
  return getOAuthApiOrigin(request);
}

function githubAppSetupCallbackUri(request: Request): string {
  return new URL(
    "/api/github/app/setup/callback",
    githubApiOrigin(request),
  ).toString();
}

function replayGithubAppSetupCallbackAt(
  request: Request,
  callbackRedirectUri: string,
): string | null {
  const requestUrl = new URL(request.url);
  const callbackUrl = new URL(callbackRedirectUri);
  if (
    requestUrl.origin === callbackUrl.origin &&
    requestUrl.pathname === callbackUrl.pathname
  ) {
    return null;
  }
  callbackUrl.search = requestUrl.search;
  return callbackUrl.toString();
}

function replayPersistedGithubAppSetupCallback(args: {
  readonly request: Request;
}): string | null {
  const requestOrigin = new URL(args.request.url).origin;
  const apiOrigins = new Set([githubApiOrigin(args.request)]);
  if (!apiOrigins.has(requestOrigin)) {
    return null;
  }
  return replayGithubAppSetupCallbackAt(
    args.request,
    githubAppSetupCallbackUri(args.request),
  );
}

async function resolveGithubOauthMethod(
  resolver: ConnectorActionResolver,
): Promise<ResolvedConnectorActionMethod | null> {
  const resolved = await resolver.resolveMethod({
    connectorSlug: GITHUB_CONNECTOR_SLUG,
    authMethodId: getGithubOAuthAuthMethod(),
    expectedGrantKind: "auth-code",
  });
  return resolved.ok ? resolved : null;
}

async function resolveGithubOauthMethodForNewAction(
  resolver: ConnectorActionResolver,
): Promise<ResolvedConnectorActionMethod | null> {
  const resolved = await resolver.resolveNewActionMethod({
    connectorSlug: GITHUB_CONNECTOR_SLUG,
    authMethodId: getGithubOAuthAuthMethod(),
    expectedGrantKind: "auth-code",
  });
  return resolved.ok ? resolved : null;
}

async function githubAppInstallRequestedScopes(
  resolver: Promise<ConnectorActionResolver>,
  signal: AbortSignal,
): Promise<readonly string[] | undefined> {
  const result = await settle(
    (async () => {
      return await resolveGithubOauthMethodForNewAction(await resolver);
    })(),
    signal,
  );
  if (!result.ok) {
    if (isConnectorCatalogUnavailableError(result.error)) {
      return undefined;
    }
    throw result.error;
  }
  return result.value
    ? connectorGrantScopes(result.value.method.grant)
    : undefined;
}

const writeGithubConnectorConnection$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly method: ResolvedConnectorActionMethod;
      readonly outputs: Readonly<Record<string, string | null | undefined>>;
      readonly userInfo: {
        readonly id: string;
        readonly username: string | null;
        readonly email: string | null;
      };
      readonly oauthRequestedScopes: readonly string[];
      readonly oauthGrantedScopes: readonly string[];
      readonly extraConnectorSecrets?: Readonly<Record<string, string>>;
      readonly account: { readonly intent: "add" };
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const result = await set(
      upsertBuiltinConnectorTokenConnection$,
      {
        orgId: args.orgId,
        userId: args.userId,
        runtimeMethod: args.method.runtimeMethod,
        snapshot: args.method.snapshot,
        outputs: args.outputs,
        userInfo: args.userInfo,
        oauthRequestedScopes: args.oauthRequestedScopes,
        oauthGrantedScopes: args.oauthGrantedScopes,
        extraConnectorSecrets: args.extraConnectorSecrets,
        account: args.account,
        matchExistingExternalIdentity: true,
      },
      signal,
    );
    signal.throwIfAborted();
    return result.status === "connected";
  },
);

function githubAppUserOauthCredentials():
  { readonly clientId: string; readonly clientSecret: string } | undefined {
  const clientId = optionalEnv("GITHUB_APP_CLIENT_ID");
  const clientSecret = optionalEnv("GITHUB_APP_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return undefined;
  }
  return { clientId, clientSecret };
}

function worksErrorRedirect(message: string): Response {
  return redirectResponse(
    appUrl(`/works?error=${encodeURIComponent(message)}`),
  );
}

function hasGithubConnectSignatureQuery(
  query: GithubOauthConnectQuery,
): boolean {
  return Boolean(query.installation || query.ghUser || query.ts || query.sig);
}

function errorMessageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : "GitHub authorization failed";
}

const GITHUB_INSTALL_ADMIN_REQUIRED =
  "Only organization admins can install GitHub";

const GITHUB_SINGLE_INSTALLATION_REQUIRED =
  "GitHub is already installed for this organization";

const GITHUB_INSTALL_GITHUB_ADMIN_REQUIRED =
  "You don't have permission to install this GitHub App. Ask a GitHub organization owner to install it, then try again.";

type ParsedGithubOauthState = NonNullable<
  ReturnType<typeof parseGithubOauthState>
>;

type GithubCallbackStateResolution =
  | {
      readonly ok: true;
      readonly state: ParsedGithubOauthState;
    }
  | {
      readonly ok: false;
      readonly response: Response;
    };

type GithubCallbackAccessResolution =
  | {
      readonly ok: true;
      readonly orgAlreadyHasActiveInstallation: boolean;
    }
  | {
      readonly ok: false;
      readonly response: Response;
    };

type GithubSetupUserConnectionResolution =
  | {
      readonly ok: true;
      readonly connected: boolean;
    }
  | {
      readonly ok: false;
      readonly response: Response;
    };

function githubSetupUserConnectionError(
  message: string,
): GithubSetupUserConnectionResolution {
  return { ok: false, response: worksErrorRedirect(message) };
}

type GithubSetupUserIdentity = {
  readonly accessToken: string;
  readonly scopes: string[];
  readonly userInfo: Awaited<ReturnType<typeof fetchGitHubUserInfo>>;
  readonly method: ResolvedConnectorActionMethod;
  readonly installInfo: Awaited<ReturnType<typeof getGithubInstallationInfo>>;
  readonly oauthRequestedScopes: readonly string[];
};

type GithubSetupUserConnectionArgs = {
  readonly orgId: string;
  readonly installRecordId: string;
  readonly state: ParsedGithubOauthState;
  readonly identity: GithubSetupUserIdentity;
};

const isGithubInstallOrgAdmin$ = command(
  async (
    { set },
    args: { readonly orgId: string | null; readonly userId: string | null },
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (!args.orgId || !args.userId) {
      return false;
    }
    const membership = await set(
      getMemberRoleAndUpdateCache$,
      args.orgId,
      args.userId,
      signal,
    );
    signal.throwIfAborted();
    return membership.kind === "member" && membership.role === "admin";
  },
);

const hasActiveGithubInstallationForOrg$ = command(
  async ({ set }, orgId: string, signal: AbortSignal): Promise<boolean> => {
    set(writeDb$);
    const installation = await set(
      loadActiveGithubInstallationForOrg$,
      {
        orgId,
      },
      signal,
    );
    return installation !== null;
  },
);

async function resolveGithubCallbackState(args: {
  readonly stateString: string | undefined;
  readonly secretsEncryptionKey: string;
}): Promise<GithubCallbackStateResolution> {
  const state = parseGithubOauthState(args.stateString);
  if (!state) {
    return {
      ok: false,
      response: worksErrorRedirect(
        "Invalid OAuth state. Please try installing again from the Platform.",
      ),
    };
  }

  if (
    !(await isGithubOauthStateSignatureValid({
      state,
      secretsEncryptionKey: args.secretsEncryptionKey,
    }))
  ) {
    return {
      ok: false,
      response: worksErrorRedirect(
        "Invalid state signature. Please try installing again from the Platform.",
      ),
    };
  }

  return { ok: true, state };
}

function signedGithubCallbackReplayResponse(args: {
  readonly request: Request;
  readonly stateString: string | undefined;
  readonly stateResolution: GithubCallbackStateResolution;
}): Response | null {
  if (!args.stateString || !args.stateResolution.ok) {
    return null;
  }
  const callbackRedirectUri = args.stateResolution.state.callbackRedirectUri;
  if (!callbackRedirectUri) {
    return null;
  }
  const replayUrl = replayGithubAppSetupCallbackAt(
    args.request,
    callbackRedirectUri,
  );
  return replayUrl ? noStoreRedirect(replayUrl) : null;
}

const githubAppUpdateCallbackResponse$ = command(
  async (
    { set },
    args: {
      readonly request: Request;
      readonly installationId: string | undefined;
      readonly replayPersistedSetup: boolean;
    },
    signal: AbortSignal,
  ): Promise<Response> => {
    if (!args.replayPersistedSetup || !args.installationId) {
      return redirectResponse(appUrl("/workflows"));
    }

    const installation = await set(
      findGithubInstallationByInstallationId$,
      {
        installationId: args.installationId,
        orgId: null,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!installation) {
      return redirectResponse(appUrl("/workflows"));
    }

    const replayUrl = replayPersistedGithubAppSetupCallback({
      request: args.request,
    });
    return replayUrl
      ? noStoreRedirect(replayUrl)
      : redirectResponse(appUrl("/workflows"));
  },
);

const resolveGithubCallbackAccess$ = command(
  async (
    { set },
    args: {
      readonly state: ParsedGithubOauthState;
      readonly orgId: string;
    },
    signal: AbortSignal,
  ): Promise<GithubCallbackAccessResolution> => {
    if (
      args.state.orgId &&
      args.state.userId &&
      !(await set(
        isGithubInstallOrgAdmin$,
        { orgId: args.state.orgId, userId: args.state.userId },
        signal,
      ))
    ) {
      return {
        ok: false,
        response: worksErrorRedirect(GITHUB_INSTALL_ADMIN_REQUIRED),
      };
    }

    const orgAlreadyHasActiveInstallation = await set(
      hasActiveGithubInstallationForOrg$,
      args.orgId,
      signal,
    );
    signal.throwIfAborted();

    return { ok: true, orgAlreadyHasActiveInstallation };
  },
);

async function githubInstallationAdmin(
  args: {
    readonly accessToken: string;
    readonly githubUserId: string;
    readonly installation: Awaited<
      ReturnType<typeof getGithubInstallationInfo>
    >;
  },
  signal: AbortSignal,
): Promise<boolean> {
  if (args.installation.targetType === "User") {
    return args.installation.targetId === args.githubUserId;
  }
  if (args.installation.targetType !== "Organization") {
    return false;
  }
  // The list endpoint supports GitHub App user tokens without extra permissions.
  // Repository access alone does not authorize attaching an organization's install.
  for (let page = 1; page <= 10; page++) {
    const response = await accept(
      fetch(
        `https://api.github.com/user/memberships/orgs?state=active&per_page=100&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${args.accessToken}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal,
        },
      ),
      [200],
    );
    const memberships = array(
      object({
        state: string(),
        role: string(),
        organization: object({ id: number() }),
      }),
    ).parse(await response.json());
    signal.throwIfAborted();
    const membership = memberships.find((entry) => {
      return String(entry.organization.id) === args.installation.targetId;
    });
    if (membership) {
      return membership.state === "active" && membership.role === "admin";
    }
    if (memberships.length < 100) {
      return false;
    }
  }
  throw new Error(
    "GitHub organization verification exceeded its page limit. Please contact support.",
  );
}

const prepareGithubSetupUserIdentity$ = command(
  async (
    { set },
    args: {
      readonly code: string;
      readonly installationId: string;
      readonly appId: string;
      readonly privateKey: string;
      readonly state: ParsedGithubOauthState;
    },
    signal: AbortSignal,
  ) => {
    const credentials = githubAppUserOauthCredentials();
    if (!credentials) {
      return {
        ok: false as const,
        response: worksErrorRedirect("GitHub App OAuth is not configured"),
      };
    }
    const resolver = await set(readConnectorResolver$, [GITHUB_CONNECTOR_SLUG]);
    signal.throwIfAborted();
    const method = await resolveGithubOauthMethod(resolver);
    signal.throwIfAborted();
    if (!method || method.method.grant.kind !== "auth-code") {
      return {
        ok: false as const,
        response: worksErrorRedirect("GitHub OAuth is not available"),
      };
    }
    const oauthRequestedScopes =
      args.state.oauthRequestedScopes ??
      connectorGrantScopes(method.method.grant);
    const grant = { ...method.method.grant, scopes: [...oauthRequestedScopes] };
    const exchanged = await settle(
      (async () => {
        const { accessToken, scopes } = await exchangeGitHubCode(
          grant,
          credentials.clientId,
          credentials.clientSecret,
          args.code,
        );
        signal.throwIfAborted();
        const userInfo = await fetchGitHubUserInfo(accessToken);
        signal.throwIfAborted();
        const installInfo = await getGithubInstallationInfo(
          {
            appId: args.appId,
            privateKey: args.privateKey,
            installationId: args.installationId,
          },
          signal,
        );
        const authorized = await githubInstallationAdmin(
          { accessToken, githubUserId: userInfo.id, installation: installInfo },
          signal,
        );
        if (!authorized) {
          throw new Error(
            "Only the GitHub account owner or an active organization administrator can connect this installation.",
          );
        }
        return {
          accessToken,
          scopes,
          userInfo,
          method,
          installInfo,
          oauthRequestedScopes,
        } satisfies GithubSetupUserIdentity;
      })(),
      signal,
    );
    return exchanged.ok
      ? { ok: true as const, identity: exchanged.value }
      : {
          ok: false as const,
          response: worksErrorRedirect(
            errorMessageFromUnknown(exchanged.error),
          ),
        };
  },
);

const connectGithubUserAfterSetup$ = command(
  async (
    { set },
    args: GithubSetupUserConnectionArgs,
    signal: AbortSignal,
  ): Promise<GithubSetupUserConnectionResolution> => {
    const userId = args.state.userId;
    if (!userId) {
      return githubSetupUserConnectionError(
        "Invalid GitHub installation identity",
      );
    }
    const identity = args.identity;
    const connected = await set(
      writeGithubConnectorConnection$,
      {
        orgId: args.orgId,
        userId,
        method: identity.method,
        outputs: { accessToken: identity.accessToken },
        userInfo: identity.userInfo,
        oauthRequestedScopes: identity.oauthRequestedScopes,
        oauthGrantedScopes: identity.scopes,
        account: { intent: "add" },
      },
      signal,
    );
    if (!connected) {
      return githubSetupUserConnectionError(
        "Connector account could not be selected",
      );
    }
    const linked = await set(
      linkGithubUser$,
      {
        installRecordId: args.installRecordId,
        userId,
        knownGithubUserId: identity.userInfo.id,
      },
      signal,
    );
    if (!linked) {
      return githubSetupUserConnectionError(
        "This GitHub account is already linked to the installation",
      );
    }
    await publishUserSignal([userId], "github:changed");
    signal.throwIfAborted();
    return { ok: true, connected: true };
  },
);

function githubSetupCompleteRedirect(connected: boolean): Response {
  if (connected) {
    return redirectResponse(appUrl("/workflows"));
  }
  return redirectResponse(appUrl("/workflows"));
}

const connectExistingGithubInstallation$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly installationId: string;
      readonly state: ParsedGithubOauthState;
      readonly identity: GithubSetupUserIdentity;
      readonly connectUser: boolean;
    },
    signal: AbortSignal,
  ): Promise<Response | null> => {
    const existing = await set(
      findGithubInstallationByInstallationId$,
      {
        installationId: args.installationId,
        orgId: args.orgId,
      },
      signal,
    );
    if (!existing) {
      return null;
    }
    if (!args.connectUser) {
      return githubSetupCompleteRedirect(false);
    }
    const connection = await set(
      connectGithubUserAfterSetup$,
      {
        orgId: args.orgId,
        installRecordId: existing.id,
        state: args.state,
        identity: args.identity,
      },
      signal,
    );
    return connection.ok
      ? githubSetupCompleteRedirect(connection.connected)
      : connection.response;
  },
);

const installGithubOauth$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const request = get(request$).raw;
    const callbackOrigin = githubApiOrigin(request);
    const providerCallbackOrigin = githubApiOrigin(request);
    const appSlug = optionalEnv("GITHUB_APP_SLUG");
    if (!appSlug) {
      return jsonErrorResponse("GitHub App integration is not configured", 503);
    }

    const query = get(queryOf(githubOauthContract.install));
    const auth = await set(
      requiredAuthContext$,
      { requireOrganization: true },
      signal,
    );
    if ("status" in auth) {
      return auth.status === 401
        ? signInRedirect(request.url)
        : worksErrorRedirect(auth.body.error.message);
    }
    if (!auth.orgId || auth.orgRole !== "admin") {
      return worksErrorRedirect(GITHUB_INSTALL_ADMIN_REQUIRED);
    }
    if (
      (query.userId && query.userId !== auth.userId) ||
      (query.orgId && query.orgId !== auth.orgId)
    ) {
      return worksErrorRedirect(
        "The installation link belongs to a different account or organization. Please reconnect from settings.",
      );
    }
    const userId = auth.userId;
    const db = get(db$);
    const [metadata] = await db
      .select({ defaultAgentId: orgMetadata.defaultAgentId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, auth.orgId))
      .limit(1);
    signal.throwIfAborted();
    const composeId = query.composeId ?? metadata?.defaultAgentId;
    if (!composeId) {
      return worksErrorRedirect(
        "Finish workspace setup to initialize Okou before connecting GitHub.",
      );
    }
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, composeId), eq(agents.orgId, auth.orgId)))
      .limit(1);
    signal.throwIfAborted();
    if (!agent) {
      return worksErrorRedirect(
        "The selected agent does not belong to your organization.",
      );
    }
    const linkedFromLocal = await set(
      tryLinkGithubFromLocalRecord$,
      { orgId: auth.orgId, userId },
      signal,
    );
    if (linkedFromLocal) {
      return redirectResponse(appUrl("/workflows"));
    }

    const oauthRequestedScopes =
      userId && githubAppUserOauthCredentials()
        ? await githubAppInstallRequestedScopes(
            set(readConnectorResolver$, [GITHUB_CONNECTOR_SLUG]),
            signal,
          )
        : undefined;
    signal.throwIfAborted();
    const installUrl = await set(
      buildGithubAppInstallUrl$,
      {
        appSlug,
        userId,
        orgId: auth.orgId,
        composeId,
        callbackOrigin,
        providerCallbackOrigin,
        oauthRequestedScopes,
        secretsEncryptionKey: env("SECRETS_ENCRYPTION_KEY"),
      },
      signal,
    );

    return noStoreRedirect(installUrl);
  },
);

function invalidGithubConnectLinkRedirect(): Response {
  return worksErrorRedirect(
    "Invalid or expired GitHub connect link. Ask the bot for a new link.",
  );
}

function signInRedirect(requestUrl: string): Response {
  const signInUrl = new URL("/sign-in", env("APP_URL"));
  signInUrl.searchParams.set("redirect_url", requestUrl);
  return noStoreRedirect(signInUrl.toString());
}

const connectGithubUserOauth$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const request = get(request$).raw;
    const query = get(queryOf(githubOauthContract.connect));
    const auth = await set(
      requiredAuthContext$,
      { requireOrganization: true },
      signal,
    );
    signal.throwIfAborted();
    if ("status" in auth) {
      return auth.status === 401
        ? signInRedirect(request.url)
        : worksErrorRedirect(auth.body.error.message);
    }
    if (!auth.orgId) {
      return worksErrorRedirect("Explicit org context required");
    }
    const orgId = auth.orgId;

    if (hasGithubConnectSignatureQuery(query)) {
      if (!query.installation || !query.ghUser || !query.ts || !query.sig) {
        return invalidGithubConnectLinkRedirect();
      }

      if (
        !verifyGithubConnectSignature({
          installationId: query.installation,
          githubUserId: query.ghUser,
          githubUsername: query.ghLogin,
          timestamp: query.ts,
          signature: query.sig,
          secretsEncryptionKey: env("SECRETS_ENCRYPTION_KEY"),
        })
      ) {
        return invalidGithubConnectLinkRedirect();
      }

      set(writeDb$);
      const installation = await set(
        findGithubInstallationByInstallationId$,
        {
          installationId: query.installation,
          orgId,
        },
        signal,
      );
      signal.throwIfAborted();

      if (!installation) {
        return worksErrorRedirect(
          "No GitHub installation found for this workspace",
        );
      }

      const githubUserId = await set(
        linkGithubUser$,
        {
          installRecordId: installation.id,
          userId: auth.userId,
          knownGithubUserId: query.ghUser,
        },
        signal,
      );
      signal.throwIfAborted();

      if (!githubUserId) {
        return worksErrorRedirect(
          "This GitHub account is already linked to the installation",
        );
      }

      await publishUserSignal([auth.userId], "github:changed");
      signal.throwIfAborted();

      return redirectResponse(appUrl("/workflows"));
    }

    const origin = githubApiOrigin(request);
    // Preserve database availability preflight before catalog resolution.
    set(writeDb$);
    const resolver = await set(readConnectorResolver$, [GITHUB_CONNECTOR_SLUG]);
    signal.throwIfAborted();
    const resolvedMethod = await resolveGithubOauthMethodForNewAction(resolver);
    signal.throwIfAborted();
    if (!resolvedMethod) {
      return worksErrorRedirect("GitHub OAuth is not available");
    }
    const authorizationUrl = await set(
      startGithubUserOAuth$,
      {
        userId: auth.userId,
        orgId,
        origin,
        authMethodId: resolvedMethod.authMethodId,
        method: resolvedMethod.method,
        readEnv: optionalEnv,
      },
      signal,
    );
    signal.throwIfAborted();

    if (!authorizationUrl) {
      return worksErrorRedirect("GitHub OAuth is not configured");
    }

    return noStoreRedirect(authorizationUrl);
  },
);

const requestGithubInstallationUserAuthorization$ = command(
  async (
    { set },
    args: {
      readonly state: ParsedGithubOauthState;
      readonly orgId: string;
      readonly composeId: string;
      readonly installationId: string;
    },
    signal: AbortSignal,
  ): Promise<Response> => {
    const credentials = githubAppUserOauthCredentials();
    const appSlug = optionalEnv("GITHUB_APP_SLUG");
    if (
      !credentials ||
      !appSlug ||
      !args.state.userId ||
      !args.state.callbackRedirectUri
    ) {
      return worksErrorRedirect(
        "Please authorize your GitHub account and reconnect this installation from settings.",
      );
    }
    const origin = new URL(args.state.callbackRedirectUri).origin;
    const authorizationUrl = await set(
      buildGithubAppInstallUrl$,
      {
        appSlug,
        userId: args.state.userId,
        orgId: args.orgId,
        composeId: args.composeId,
        callbackOrigin: origin,
        providerCallbackOrigin: origin,
        secretsEncryptionKey: env("SECRETS_ENCRYPTION_KEY"),
        oauthRequestedScopes: args.state.oauthRequestedScopes ?? undefined,
        userAuthorization: {
          clientId: credentials.clientId,
          installationId: args.installationId,
        },
      },
      signal,
    );
    return noStoreRedirect(authorizationUrl);
  },
);

const completeGithubAppInstallationCallback$ = command(
  async (
    { set },
    args: {
      readonly appId: string;
      readonly privateKey: string;
      readonly query: GithubAppSetupCallbackQuery;
      readonly state: ParsedGithubOauthState;
      readonly composeId: string;
      readonly connectUser: boolean;
    },
    signal: AbortSignal,
  ): Promise<Response> => {
    set(writeDb$);
    const orgId = await set(
      resolveGithubOauthOrgId$,
      {
        orgId: args.state.orgId,
        composeId: args.composeId,
      },
      signal,
    );
    signal.throwIfAborted();

    const access = await set(
      resolveGithubCallbackAccess$,
      { state: args.state, orgId },
      signal,
    );
    if (!access.ok) {
      return access.response;
    }

    if (args.query.setup_action === "request") {
      return worksErrorRedirect(GITHUB_INSTALL_GITHUB_ADMIN_REQUIRED);
    }

    const installationId = args.query.installation_id;
    if (!installationId) {
      return worksErrorRedirect("Missing installation ID from GitHub");
    }

    if (!args.query.code) {
      return await set(
        requestGithubInstallationUserAuthorization$,
        { state: args.state, orgId, composeId: args.composeId, installationId },
        signal,
      );
    }
    const prepared = await set(
      prepareGithubSetupUserIdentity$,
      {
        code: args.query.code,
        installationId,
        state: args.state,
        appId: args.appId,
        privateKey: args.privateKey,
      },
      signal,
    );
    if (!prepared.ok) {
      return prepared.response;
    }

    const existingResponse = await set(
      connectExistingGithubInstallation$,
      {
        installationId,
        orgId,
        state: args.state,
        identity: prepared.identity,
        connectUser: args.connectUser,
      },
      signal,
    );
    if (existingResponse) {
      return existingResponse;
    }

    if (access.orgAlreadyHasActiveInstallation) {
      return worksErrorRedirect(GITHUB_SINGLE_INSTALLATION_REQUIRED);
    }

    const installInfo = prepared.identity.installInfo;
    const { token } = await getGithubInstallationAccessToken(
      { appId: args.appId, privateKey: args.privateKey, installationId },
      signal,
    );
    const adminGithubUserId =
      installInfo.targetType === "User" ? installInfo.targetId : null;
    const featureSwitchContext = await set(
      loadComposeFeatureSwitchContext$,
      { composeId: args.composeId, userId: args.state.userId },
      signal,
    );
    const installRecordId = await set(
      createOrActivateGithubInstallation$,
      {
        orgId,
        installationId,
        installInfo,
        encryptedAccessToken: await encryptPersistentSecretValue(
          token,
          featureSwitchContext,
        ),
        adminGithubUserId,
        composeId: args.composeId,
      },
      signal,
    );
    signal.throwIfAborted();

    if (!args.connectUser) {
      return githubSetupCompleteRedirect(false);
    }
    const connection = await set(
      connectGithubUserAfterSetup$,
      {
        orgId,
        installRecordId,
        state: args.state,
        identity: prepared.identity,
      },
      signal,
    );
    return connection.ok
      ? githubSetupCompleteRedirect(connection.connected)
      : connection.response;
  },
);

const claimGithubInstallationCallback$ = command(
  async (
    { set },
    args: {
      readonly query: GithubAppSetupCallbackQuery;
      readonly state: ParsedGithubOauthState;
    },
    signal: AbortSignal,
  ) => {
    if (!args.query.state) {
      return {
        ok: false as const,
        response: worksErrorRedirect(
          "Please reconnect GitHub from settings to authorize this installation.",
        ),
      };
    }
    const claimed = await set(
      claimBuiltinConnectorOAuthState$,
      { state: args.query.state!, connectorSlug: "github" },
      signal,
    );
    if (
      claimed.kind !== "usable" ||
      claimed.state.authMethod !== "github-app-install" ||
      claimed.state.userId !== args.state.userId ||
      claimed.state.orgId !== args.state.orgId ||
      claimed.state.agentId !== args.state.composeId ||
      claimed.state.redirectUri !== args.state.callbackRedirectUri
    ) {
      return {
        ok: false as const,
        response: worksErrorRedirect(
          "This installation authorization has expired or was already used. Please reconnect GitHub from settings.",
        ),
      };
    }
    const composeId = args.state.composeId;
    const actorError = await set(
      checkOAuthCallbackActor$,
      { userId: claimed.state.userId, orgId: claimed.state.orgId },
      signal,
    );
    if (actorError) {
      return { ok: false as const, response: worksErrorRedirect(actorError) };
    }
    if (!composeId) {
      return {
        ok: false as const,
        response: worksErrorRedirect(
          "Missing default agent. Please select an agent before connecting GitHub.",
        ),
      };
    }
    const continuation =
      claimed.state.oauthContext === null
        ? null
        : object({ installationId: string().regex(/^\d+$/) }).parse(
            safeJsonParse(claimed.state.oauthContext),
          );
    if (
      continuation &&
      args.query.installation_id &&
      args.query.installation_id !== continuation.installationId
    ) {
      return {
        ok: false as const,
        response: worksErrorRedirect(
          "The GitHub installation does not match this authorization.",
        ),
      };
    }
    if (continuation && !args.query.code) {
      return {
        ok: false as const,
        response: worksErrorRedirect(
          "GitHub authorization was not completed. Please reconnect from settings.",
        ),
      };
    }
    return {
      ok: true as const,
      composeId,
      query: {
        ...args.query,
        installation_id:
          continuation?.installationId ?? args.query.installation_id,
      },
      connectUser: continuation === null,
    };
  },
);

const completeCallbackGithubOauth$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const request = get(request$).raw;
    const query = get(queryOf(githubOauthContract.setupCallback));
    const secretsEncryptionKey = env("SECRETS_ENCRYPTION_KEY");
    const stateResolution = await resolveGithubCallbackState({
      stateString: query.state,
      secretsEncryptionKey,
    });
    signal.throwIfAborted();
    const replayResponse = signedGithubCallbackReplayResponse({
      request,
      stateString: query.state,
      stateResolution,
    });
    if (replayResponse) {
      return replayResponse;
    }

    const appId = optionalEnv("GITHUB_APP_ID");
    const privateKey = optionalEnv("GITHUB_APP_PRIVATE_KEY");

    if (!appId || !privateKey) {
      return worksErrorRedirect("GitHub App integration is not configured");
    }

    if (query.error && (!query.state || !stateResolution.ok)) {
      return worksErrorRedirect(query.error_description || query.error);
    }
    if (
      query.setup_action === "update" &&
      (!query.state || !stateResolution.ok)
    ) {
      set(writeDb$);
      return await set(
        githubAppUpdateCallbackResponse$,
        {
          request,
          installationId: query.installation_id,
          replayPersistedSetup: !query.state || !stateResolution.ok,
        },
        signal,
      );
    }

    signal.throwIfAborted();
    if (!stateResolution.ok) {
      return stateResolution.response;
    }
    const claimed = await set(
      claimGithubInstallationCallback$,
      { query, state: stateResolution.state },
      signal,
    );
    if (!claimed.ok) {
      return claimed.response;
    }
    if (query.error) {
      return worksErrorRedirect(
        query.error_description || query.error || "GitHub authorization failed",
      );
    }
    return await set(
      completeGithubAppInstallationCallback$,
      {
        appId,
        privateKey,
        query: claimed.query,
        state: stateResolution.state,
        composeId: claimed.composeId,
        connectUser: claimed.connectUser,
      },
      signal,
    );
  },
);

const callbackGithubAuthenticated$ = authRoute(
  { requireOrganization: true, missingOrganizationStatus: 401 },
  command(async ({ get, set }, signal: AbortSignal) => {
    const response = await set(completeCallbackGithubOauth$, signal);
    return integrationOAuthCallbackResponse(
      response,
      get(queryOf(githubOauthContract.setupCallback)).responseMode,
    );
  }),
);

const callbackGithubOauth$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(setIntegrationOAuthCallbackHeaders$);
    const query = get(queryOf(githubOauthContract.setupCallback));
    if (query.responseMode === "json") {
      return await set(callbackGithubAuthenticated$, signal);
    }
    const stateResolution = await resolveGithubCallbackState({
      stateString: query.state,
      secretsEncryptionKey: env("SECRETS_ENCRYPTION_KEY"),
    });
    signal.throwIfAborted();
    const replay = signedGithubCallbackReplayResponse({
      request: get(request$).raw,
      stateString: query.state,
      stateResolution,
    });
    if (replay) {
      return replay;
    }
    if (
      query.state &&
      stateResolution.ok &&
      stateResolution.state.userId &&
      stateResolution.state.orgId
    ) {
      if (get(authorization$)) {
        return await set(callbackGithubAuthenticated$, signal);
      }
      return integrationOAuthAppRedirect("github", query);
    }
    // Stateless updates only navigate; they never create an Okou association.
    return await set(completeCallbackGithubOauth$, signal);
  },
);

export const githubOauthRoutes: readonly RouteEntry[] = [
  {
    route: githubOauthContract.install,
    handler: installGithubOauth$,
  },
  {
    route: githubOauthContract.connect,
    handler: connectGithubUserOauth$,
  },
  {
    route: githubOauthContract.setupCallback,
    handler: callbackGithubOauth$,
  },
];
