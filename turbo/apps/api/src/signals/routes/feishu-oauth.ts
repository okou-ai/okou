import {
  FEISHU_PLATFORMS,
  feishuPlatformFromTokenUrl,
  type FeishuPlatform,
} from "@okouai/core/feishu-platform";
import { command } from "ccstate";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import { feishuOauthContract } from "@okouai/api-contracts/contracts/feishu-oauth";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { connectors } from "@okouai/db/schema/connector";
import { feishuOrgConnections } from "@okouai/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { testOverride } from "../../lib/singleton";
import { queryOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { writeDb$, type Db } from "../external/db";
import {
  fetchFeishuUserInfo,
  type FeishuUserInfo,
} from "../external/feishu-client";
import { nowDate } from "../../lib/time";
import type { RouteEntry } from "../route-entry";
import {
  claimConnectorOAuthState,
  readCustomConnectorOAuthState,
  type StoredCustomConnectorOAuthState,
} from "../services/connector-oauth-state.service";
import {
  customConnectorOAuthStateMatchesDefinition,
  isCustomConnectorCustomOAuthStateContext,
  decryptCustomConnectorOAuth2Credentials,
  exchangeCustomConnectorOAuth2Code,
  lockCustomConnectorOAuth2CredentialContract,
  parseValidCustomConnectorOAuthState,
  startCustomConnectorOAuth2$,
  storeCustomConnectorOAuth2Connection,
  type CustomConnectorCustomOAuthStateContext,
  type CustomConnectorOAuthTokenResult,
} from "../services/custom-connector-oauth2.service";
import {
  ensureFeishuCustomConnector$,
  resolveFeishuConnectorAccountMutation as resolveFeishuAccountMutation,
} from "../services/feishu-custom-connector.service";
import {
  isFeishuInstallationEnabled,
  feishuBotOpenUrl,
  feishuOAuthAppCallbackUrl,
  feishuOAuthCallbackUrl,
  legacyFeishuOAuthAppCallbackUrl,
  loadFeishuInstallationConfig,
} from "../services/feishu-config";
import {
  type FeishuOAuthState,
  verifyFeishuOAuthState,
} from "../services/feishu-oauth-state";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import { admitPiStableContextSubjects } from "../services/pi-stable-context-erasure.service";
import {
  addUserCustomConnector,
  lockUserCustomConnectorGrantScope,
} from "../services/user-connectors.service";
import { commitConnectorRuntimeMutation } from "../services/connector-runtime-wakeup.service";
import { publishCustomConnectorUserInvalidationAfterCommit } from "../services/connector-client-invalidation.service";
import {
  getCustomConnectorById,
  type CustomConnectorHttpRow,
  type CustomConnectorRow,
} from "../services/custom-connector.service";
import { publishFeishuOrgChanged } from "../services/feishu-realtime.service";
import { notifyFeishuConnect } from "../services/feishu-welcome.service";
import { tapError } from "../utils";
import { PUBLIC_BRAND } from "@okouai/core/public-brand";

const L = logger("FeishuOAuth");
const REDIRECT_STATUS = 307;

interface FeishuOAuthPersistenceHooks {
  readonly beforeErasureAdmission?: () => Promise<void>;
}

const feishuOAuthPersistenceHooks = testOverride<FeishuOAuthPersistenceHooks>(
  () => {
    return {};
  },
);

export function setFeishuOAuthPersistenceHooksForTest(
  hooks: FeishuOAuthPersistenceHooks,
): void {
  feishuOAuthPersistenceHooks.set(hooks);
}

export function clearFeishuOAuthPersistenceHooksForTest(): void {
  feishuOAuthPersistenceHooks.clear();
}

interface FeishuOAuthCallbackQuery {
  readonly code?: string;
  readonly error?: string;
  readonly error_description?: string;
  readonly responseMode?: "json";
  readonly state?: string;
}

interface FeishuConnectionState {
  readonly installationId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly publicBrand: PublicBrand;
  readonly accountMutation: ConnectorAccountMutationIntent;
}

interface FeishuInstallationOAuthRow {
  readonly appId: string;
  readonly platform: FeishuPlatform;
  readonly tenantKey: string | null;
  readonly setupCompletedAt: Date | null;
  readonly ownerUserId: string | null;
  readonly defaultAgentId: string;
}

type FeishuCustomConnectorOAuthContext = Omit<
  CustomConnectorCustomOAuthStateContext,
  "providerContext"
> & {
  readonly providerContext: Omit<
    NonNullable<CustomConnectorCustomOAuthStateContext["providerContext"]>,
    "completionTarget"
  > & {
    readonly completionTarget: "feishu";
  };
};

function redirectResponse(url: string): Response {
  return new Response(null, {
    status: REDIRECT_STATUS,
    headers: { location: url, "Cache-Control": "no-store" },
  });
}

function jsonErrorResponse(error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

function settingsUrl(
  params: Readonly<Record<string, string>>,
  platform: FeishuPlatform = "feishu",
): string {
  const url = new URL(FEISHU_PLATFORMS[platform].settingsPath, env("APP_URL"));
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function settingsRedirect(
  params: Readonly<Record<string, string>>,
  platform: FeishuPlatform = "feishu",
): Response {
  return redirectResponse(settingsUrl(params, platform));
}

function completionErrorUrl(
  message: string,
  platform: FeishuPlatform = "feishu",
): string {
  return settingsUrl({ error: message }, platform);
}

function callbackPlatform(redirectUri: string): FeishuPlatform {
  return redirectUri === feishuOAuthAppCallbackUrl("lark") ? "lark" : "feishu";
}

function appCallbackUrl(
  query: FeishuOAuthCallbackQuery,
  platform: FeishuPlatform = "feishu",
): string {
  const url = new URL(feishuOAuthAppCallbackUrl(platform));
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

function legacyOAuthRedirectUri(target: "app" | undefined): string {
  return target === "app"
    ? legacyFeishuOAuthAppCallbackUrl()
    : feishuOAuthCallbackUrl();
}

function callbackRedirectResponse(
  url: string,
  responseMode: "json" | undefined,
):
  | Response
  | {
      readonly status: 200;
      readonly body: { readonly redirectUrl: string };
    } {
  if (responseMode === "json") {
    return {
      status: 200,
      body: { redirectUrl: url },
    };
  }
  return redirectResponse(url);
}

function completionErrorResponse(
  message: string,
  responseMode: "json" | undefined,
  platform: FeishuPlatform = "feishu",
): ReturnType<typeof callbackRedirectResponse> {
  return callbackRedirectResponse(
    completionErrorUrl(message, platform),
    responseMode,
  );
}

function validCustomFeishuState(
  storedState: StoredCustomConnectorOAuthState,
): FeishuCustomConnectorOAuthContext | null {
  const context = parseValidCustomConnectorOAuthState(storedState);
  if (
    !context ||
    !isCustomConnectorCustomOAuthStateContext(context) ||
    !context.providerContext ||
    context.providerContext.provider !== "feishu" ||
    context.providerContext.completionTarget !== "feishu"
  ) {
    return null;
  }
  return {
    ...context,
    providerContext: {
      ...context.providerContext,
      completionTarget: "feishu",
    },
  };
}

function isFeishuCustomOAuthConnector(
  connector: CustomConnectorRow | null,
): connector is CustomConnectorHttpRow & {
  readonly oauthConfig: NonNullable<CustomConnectorHttpRow["oauthConfig"]>;
} {
  return (
    connector?.kind === "http" &&
    connector.authMode === "oauth" &&
    connector.oauthConfig?.providerAdapter === "feishu"
  );
}

async function exchangeOAuthTokenAndUserInfo(
  args: {
    readonly connector: CustomConnectorHttpRow;
    readonly clientSecret: string;
    readonly code: string;
    readonly codeVerifier: string | null;
    readonly redirectUri: string;
    readonly installationId: string;
  },
  signal: AbortSignal,
): Promise<
  | {
      readonly token: CustomConnectorOAuthTokenResult;
      readonly userInfo: FeishuUserInfo;
    }
  | undefined
> {
  const oauthConfig = args.connector.oauthConfig;
  if (!oauthConfig) {
    return undefined;
  }
  return await tapError(
    (async () => {
      const token = await exchangeCustomConnectorOAuth2Code(
        {
          config: oauthConfig,
          clientSecret: args.clientSecret,
          code: args.code,
          codeVerifier: args.codeVerifier,
          redirectUri: args.redirectUri,
        },
        signal,
      );
      signal.throwIfAborted();
      const userInfo = await fetchFeishuUserInfo(
        {
          userAccessToken: token.accessToken,
          platform: feishuPlatformFromTokenUrl(oauthConfig.tokenUrl),
        },
        signal,
      );
      return { token, userInfo };
    })(),
    (error) => {
      L.error("Feishu OAuth exchange failed", {
        error,
        installationId: args.installationId,
      });
    },
  );
}

async function upsertFeishuConnection(
  args: {
    readonly db: Db;
    readonly state: FeishuConnectionState;
    readonly userInfo: FeishuUserInfo;
  },
  signal: AbortSignal,
): Promise<
  | { readonly connected: false }
  | {
      readonly connected: true;
      readonly connectionId: string;
      readonly memberConnectorId: string | null;
      readonly shouldNotify: boolean;
    }
> {
  const [existing] = await args.db
    .select({
      id: feishuOrgConnections.id,
      userId: feishuOrgConnections.userId,
      dmWelcomeSent: feishuOrgConnections.dmWelcomeSent,
      connectorId: feishuOrgConnections.connectorId,
    })
    .from(feishuOrgConnections)
    .where(
      and(
        eq(feishuOrgConnections.installationId, args.state.installationId),
        eq(feishuOrgConnections.feishuOpenId, args.userInfo.openId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (existing && existing.userId !== args.state.userId) {
    return { connected: false };
  }

  let connectionId: string;
  let memberConnectorId: string | null;
  let shouldNotify: boolean;
  if (existing) {
    await args.db
      .update(feishuOrgConnections)
      .set({
        feishuUserName: args.userInfo.name,
        publicBrand: args.state.publicBrand,
        updatedAt: nowDate(),
      })
      .where(eq(feishuOrgConnections.id, existing.id));
    connectionId = existing.id;
    memberConnectorId = existing.connectorId;
    shouldNotify = !existing.dmWelcomeSent;
  } else {
    const [inserted] = await args.db
      .insert(feishuOrgConnections)
      .values({
        installationId: args.state.installationId,
        feishuOpenId: args.userInfo.openId,
        userId: args.state.userId,
        feishuUserName: args.userInfo.name,
        publicBrand: args.state.publicBrand,
      })
      .onConflictDoNothing({
        target: [
          feishuOrgConnections.feishuOpenId,
          feishuOrgConnections.installationId,
        ],
      })
      .returning({
        id: feishuOrgConnections.id,
        dmWelcomeSent: feishuOrgConnections.dmWelcomeSent,
      });
    signal.throwIfAborted();
    if (!inserted) {
      return { connected: false };
    }
    connectionId = inserted.id;
    memberConnectorId = null;
    shouldNotify = !inserted.dmWelcomeSent;
  }

  await args.db
    .delete(feishuOrgConnections)
    .where(
      and(
        eq(feishuOrgConnections.installationId, args.state.installationId),
        eq(feishuOrgConnections.userId, args.state.userId),
        ne(feishuOrgConnections.feishuOpenId, args.userInfo.openId),
      ),
    );
  signal.throwIfAborted();
  return { connected: true, connectionId, memberConnectorId, shouldNotify };
}

async function loadInstallationForConnector(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly appId: string;
  readonly installationId?: string;
}): Promise<
  (FeishuInstallationOAuthRow & { readonly installationId: string }) | null
> {
  const conditions = [
    eq(feishuOrgInstallations.orgId, args.orgId),
    eq(feishuOrgInstallations.appId, args.appId),
    isNotNull(feishuOrgInstallations.defaultAgentId),
  ];
  if (args.installationId) {
    conditions.push(eq(feishuOrgInstallations.id, args.installationId));
  }
  const [installation] = await args.db
    .select({
      installationId: feishuOrgInstallations.id,
      appId: feishuOrgInstallations.appId,
      platform: feishuOrgInstallations.platform,
      tenantKey: feishuOrgInstallations.feishuTenantKey,
      setupCompletedAt: feishuOrgInstallations.setupCompletedAt,
      ownerUserId: feishuOrgInstallations.ownerUserId,
      defaultAgentId: feishuOrgInstallations.defaultAgentId,
    })
    .from(feishuOrgInstallations)
    .where(and(...conditions))
    .limit(1);
  if (!installation?.defaultAgentId) {
    return null;
  }
  return { ...installation, defaultAgentId: installation.defaultAgentId };
}

async function persistFeishuOAuthConnection(
  args: {
    readonly db: Db;
    readonly state: FeishuConnectionState;
    readonly installation: FeishuInstallationOAuthRow;
    readonly connector: CustomConnectorHttpRow;
    readonly token: CustomConnectorOAuthTokenResult;
    readonly userInfo: FeishuUserInfo;
    readonly featureContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
): Promise<
  | { readonly connected: false }
  | {
      readonly connected: true;
      readonly connectionId: string;
      readonly shouldNotify: boolean;
    }
> {
  return await args.db.transaction(async (tx) => {
    await feishuOAuthPersistenceHooks.get().beforeErasureAdmission?.();
    if (
      !(await admitPiStableContextSubjects(tx, [
        { subjectKind: "organization", subjectId: args.state.orgId },
        { subjectKind: "user", subjectId: args.state.userId },
      ]))
    ) {
      throw new Error(
        "Failed to authorize Feishu custom connector: agentNotFound",
      );
    }
    const agentLocked = await lockUserCustomConnectorGrantScope(tx, {
      orgId: args.state.orgId,
      userId: args.state.userId,
      agentId: args.installation.defaultAgentId,
    });
    signal.throwIfAborted();
    if (!agentLocked) {
      throw new Error(
        "Failed to authorize Feishu custom connector: agentNotFound",
      );
    }
    await lockCustomConnectorOAuth2CredentialContract({
      db: tx,
      orgId: args.state.orgId,
      connectorId: args.connector.id,
      storageVersion: args.connector.storageVersion,
      authMode: "oauth",
    });
    signal.throwIfAborted();
    const connection = await upsertFeishuConnection(
      {
        db: tx,
        state: args.state,
        userInfo: args.userInfo,
      },
      signal,
    );
    if (!connection.connected) {
      return connection;
    }
    const storedConnection = await storeCustomConnectorOAuth2Connection(
      {
        db: tx,
        orgId: args.state.orgId,
        userId: args.state.userId,
        connectorId: args.connector.id,
        storageVersion: args.connector.storageVersion,
        token: args.token,
        featureContext: args.featureContext,
        account: connection.memberConnectorId
          ? {
              intent: "reconnect",
              connectionId: connection.memberConnectorId,
            }
          : args.state.accountMutation,
      },
      signal,
    );
    if (storedConnection.kind !== "stored") {
      throw new Error("Feishu connector account could not be selected");
    }
    const memberConnectorId = storedConnection.connectionId;
    signal.throwIfAborted();
    await tx
      .update(feishuOrgConnections)
      .set({ connectorId: memberConnectorId, updatedAt: nowDate() })
      .where(eq(feishuOrgConnections.id, connection.connectionId));
    await tx
      .update(connectors)
      .set({
        externalId: args.userInfo.openId,
        externalUsername: args.userInfo.name,
        updatedAt: nowDate(),
      })
      .where(eq(connectors.id, memberConnectorId));
    signal.throwIfAborted();
    if (!args.installation.tenantKey && args.userInfo.tenantKey) {
      await tx
        .update(feishuOrgInstallations)
        .set({
          feishuTenantKey: args.userInfo.tenantKey,
          updatedAt: nowDate(),
        })
        .where(eq(feishuOrgInstallations.id, args.state.installationId));
    }
    const grant = await addUserCustomConnector(
      tx,
      {
        orgId: args.state.orgId,
        userId: args.state.userId,
        agentId: args.installation.defaultAgentId,
        customConnectorId: args.connector.id,
      },
      {
        deferRuntimeWakeupUntilOuterCommit: true,
        erasureAdmissionAlreadyHeld: true,
      },
    );
    if (grant.status !== "added") {
      throw new Error(
        `Failed to authorize Feishu custom connector: ${grant.status}`,
      );
    }
    signal.throwIfAborted();
    return connection;
  });
}

async function finishFeishuOAuthConnection(
  args: {
    readonly db: Db;
    readonly state: FeishuConnectionState;
    readonly installation: FeishuInstallationOAuthRow;
    readonly connector: CustomConnectorHttpRow;
    readonly token: CustomConnectorOAuthTokenResult;
    readonly userInfo: FeishuUserInfo;
    readonly expectedOpenId?: string;
    readonly featureContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
): Promise<
  "account_in_use" | "connected" | "identity_mismatch" | "tenant_mismatch"
> {
  if (args.expectedOpenId && args.expectedOpenId !== args.userInfo.openId) {
    return "identity_mismatch";
  }
  if (
    args.installation.tenantKey &&
    args.userInfo.tenantKey &&
    args.installation.tenantKey !== args.userInfo.tenantKey
  ) {
    return "tenant_mismatch";
  }
  const connectionPersistence = persistFeishuOAuthConnection(args, signal);
  const connection = await commitConnectorRuntimeMutation(
    connectionPersistence,
    (result) => {
      return result.connected
        ? {
            db: args.db,
            scope: { orgId: args.state.orgId, userId: args.state.userId },
            targets: [{ kind: "custom", customConnectorId: args.connector.id }],
          }
        : undefined;
    },
  );
  if (!connection.connected) {
    signal.throwIfAborted();
    return "account_in_use";
  }

  await publishCustomConnectorUserInvalidationAfterCommit(
    args.state.userId,
    signal,
  );

  await publishFeishuOrgChanged(
    args.db,
    args.state.orgId,
    args.installation.ownerUserId,
    [args.state.userId],
  );
  signal.throwIfAborted();
  if (connection.shouldNotify) {
    const backgroundSignal = new AbortController().signal;
    waitUntil(
      tapError(
        notifyFeishuConnect(
          {
            db: args.db,
            installationId: args.state.installationId,
            connectionId: connection.connectionId,
            openId: args.userInfo.openId,
          },
          backgroundSignal,
        ),
        (error) => {
          L.warn("Failed to send Feishu connect welcome", {
            error,
            installationId: args.state.installationId,
            openId: args.userInfo.openId,
          });
        },
      ),
    );
  }
  return "connected";
}

function connectionErrorMessage(
  result: Exclude<
    Awaited<ReturnType<typeof finishFeishuOAuthConnection>>,
    "connected"
  >,
  platform: FeishuPlatform,
): string {
  switch (result) {
    case "account_in_use": {
      return `This ${FEISHU_PLATFORMS[platform].name} account is already connected.`;
    }
    case "identity_mismatch": {
      return `Use the ${FEISHU_PLATFORMS[platform].name} account that opened this connect link.`;
    }
    case "tenant_mismatch": {
      return `Use an account from the ${FEISHU_PLATFORMS[platform].name} tenant connected to this workspace.`;
    }
  }
}

const connect$ = command(async ({ get, set }, signal: AbortSignal) => {
  const query = get(queryOf(feishuOauthContract.connect));
  const state = query.state ? verifyFeishuOAuthState(query.state) : null;
  if (!state) {
    return jsonErrorResponse("Invalid or expired connect state");
  }
  const db = set(writeDb$);
  const [installation] = await db
    .select({
      setupCompletedAt: feishuOrgInstallations.setupCompletedAt,
      platform: feishuOrgInstallations.platform,
      orgId: feishuOrgInstallations.orgId,
      ownerUserId: feishuOrgInstallations.ownerUserId,
    })
    .from(feishuOrgInstallations)
    .where(
      and(
        eq(feishuOrgInstallations.id, state.installationId),
        eq(feishuOrgInstallations.orgId, state.orgId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!installation) {
    return jsonErrorResponse(
      `${FEISHU_PLATFORMS[callbackPlatform(state.redirectUri)].name} bot not found`,
    );
  }
  if (!(await isFeishuInstallationEnabled(db, installation))) {
    return jsonErrorResponse("Lark integration is not enabled");
  }
  if (!installation.setupCompletedAt) {
    return settingsRedirect(
      {
        error: `Finish setting up this ${FEISHU_PLATFORMS[installation.platform].name} bot before connecting.`,
      },
      installation.platform,
    );
  }
  const connectorId = await set(
    ensureFeishuCustomConnector$,
    {
      orgId: state.orgId,
      userId: state.userId,
      installationId: state.installationId,
    },
    signal,
  );
  signal.throwIfAborted();
  if (!connectorId) {
    return jsonErrorResponse(
      `${FEISHU_PLATFORMS[installation.platform].name} connector not found`,
    );
  }
  const account = await resolveFeishuAccountMutation(db, {
    installationId: state.installationId,
    userId: state.userId,
  });
  signal.throwIfAborted();
  const result = await set(
    startCustomConnectorOAuth2$,
    {
      orgId: state.orgId,
      userId: state.userId,
      connectorId,
      redirectUri: state.redirectUri,
      publicBrand: state.publicBrand,
      account,
      feishuContext: {
        installationId: state.installationId,
      },
    },
    signal,
  );
  signal.throwIfAborted();
  if ("status" in result) {
    return jsonErrorResponse(result.body.error.message);
  }
  if (result.result !== "authorization") {
    throw new Error("Feishu Custom OAuth unexpectedly completed without OAuth");
  }
  return redirectResponse(result.authorizationUrl);
});

const completeLegacyFeishuOAuth$ = command(
  async (
    { get, set },
    args: {
      readonly db: Db;
      readonly query: FeishuOAuthCallbackQuery;
      readonly state: FeishuOAuthState;
    },
    signal: AbortSignal,
  ) => {
    const { db, query, state } = args;
    const platform = callbackPlatform(state.redirectUri);
    if (query.error) {
      return completionErrorResponse(
        query.error_description ?? query.error,
        query.responseMode,
        platform,
      );
    }
    if (!query.code) {
      return jsonErrorResponse("Missing authorization code");
    }
    const config = await loadFeishuInstallationConfig(db, state.installationId);
    signal.throwIfAborted();
    if (!config || config.orgId !== state.orgId) {
      return completionErrorResponse(
        `${FEISHU_PLATFORMS[platform].name} bot not found.`,
        query.responseMode,
        platform,
      );
    }
    const installation = await loadInstallationForConnector({
      db,
      orgId: state.orgId,
      appId: config.appId,
      installationId: state.installationId,
    });
    signal.throwIfAborted();
    if (!installation?.setupCompletedAt) {
      return completionErrorResponse(
        `Finish setting up this ${FEISHU_PLATFORMS[platform].name} bot before connecting.`,
        query.responseMode,
        platform,
      );
    }
    const connectorId = await set(
      ensureFeishuCustomConnector$,
      {
        orgId: state.orgId,
        userId: state.userId,
        installationId: state.installationId,
      },
      signal,
    );
    if (!connectorId) {
      return completionErrorResponse(
        `${FEISHU_PLATFORMS[platform].name} connector not found.`,
        query.responseMode,
        platform,
      );
    }
    const connector = await get(
      getCustomConnectorById({
        orgId: state.orgId,
        connectorId,
      }),
    );
    signal.throwIfAborted();
    if (!isFeishuCustomOAuthConnector(connector)) {
      return completionErrorResponse(
        `${FEISHU_PLATFORMS[platform].name} connector is unavailable.`,
        query.responseMode,
        platform,
      );
    }
    const accountMutation = await resolveFeishuAccountMutation(db, state);
    signal.throwIfAborted();
    const exchanged = await exchangeOAuthTokenAndUserInfo(
      {
        connector,
        clientSecret: config.appSecret,
        code: query.code,
        codeVerifier: null,
        redirectUri: legacyOAuthRedirectUri(state.oauthRedirectTarget),
        installationId: state.installationId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!exchanged) {
      return completionErrorResponse(
        `Failed to connect ${FEISHU_PLATFORMS[platform].name} account. Please try again.`,
        query.responseMode,
        platform,
      );
    }
    const featureContext = await get(
      userFeatureSwitchContext(state.orgId, state.userId),
    );
    signal.throwIfAborted();
    const completed = await finishFeishuOAuthConnection(
      {
        db,
        state: {
          ...state,
          accountMutation,
        },
        installation,
        connector,
        ...exchanged,
        featureContext,
      },
      signal,
    );
    if (completed !== "connected") {
      return completionErrorResponse(
        connectionErrorMessage(completed, platform),
        query.responseMode,
        platform,
      );
    }
    return callbackRedirectResponse(
      feishuBotOpenUrl(installation.appId, installation.platform),
      query.responseMode,
    );
  },
);

const completeClaimedCustomFeishuOAuth$ = command(
  async (
    { get },
    args: {
      readonly db: Db;
      readonly query: FeishuOAuthCallbackQuery & { readonly state: string };
      readonly state: StoredCustomConnectorOAuthState;
      readonly context: FeishuCustomConnectorOAuthContext;
    },
    signal: AbortSignal,
  ) => {
    const { context, db, query, state } = args;
    const platform = callbackPlatform(state.redirectUri);
    if (query.error) {
      return completionErrorResponse(
        query.error_description ?? query.error,
        query.responseMode,
        platform,
      );
    }
    if (!query.code) {
      return jsonErrorResponse("Missing authorization code");
    }

    const connector = await get(
      getCustomConnectorById({
        orgId: state.orgId,
        connectorId: context.connectorId,
      }),
    );
    signal.throwIfAborted();
    if (
      connector?.kind !== "http" ||
      !connector.oauthConfig ||
      connector.oauthConfig.providerAdapter !== "feishu" ||
      !customConnectorOAuthStateMatchesDefinition(context, connector)
    ) {
      return completionErrorResponse(
        `${FEISHU_PLATFORMS[platform].name} connector configuration changed. Please try again.`,
        query.responseMode,
        platform,
      );
    }
    const installation = await loadInstallationForConnector({
      db,
      orgId: state.orgId,
      appId: connector.oauthConfig.clientId,
      installationId: context.providerContext.installationId,
    });
    signal.throwIfAborted();
    if (!installation?.setupCompletedAt) {
      return completionErrorResponse(
        `Finish setting up this ${FEISHU_PLATFORMS[platform].name} bot before connecting.`,
        query.responseMode,
        platform,
      );
    }
    if (
      !(await isFeishuInstallationEnabled(db, {
        ...installation,
        orgId: state.orgId,
      }))
    ) {
      return jsonErrorResponse("Lark integration is not enabled");
    }
    const featureContext = await get(
      userFeatureSwitchContext(state.orgId, state.userId),
    );
    signal.throwIfAborted();
    const credentials = await tapError(
      decryptCustomConnectorOAuth2Credentials(connector, featureContext),
    );
    signal.throwIfAborted();
    if (!credentials) {
      return completionErrorResponse(
        `Could not read ${FEISHU_PLATFORMS[platform].name} OAuth client credentials.`,
        query.responseMode,
        platform,
      );
    }
    const exchanged = await exchangeOAuthTokenAndUserInfo(
      {
        connector,
        clientSecret: credentials.clientSecret,
        code: query.code,
        codeVerifier: state.codeVerifier,
        redirectUri: state.redirectUri,
        installationId: installation.installationId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!exchanged) {
      return completionErrorResponse(
        `Failed to connect ${FEISHU_PLATFORMS[platform].name} account. Please try again.`,
        query.responseMode,
        platform,
      );
    }
    const connectionState: FeishuConnectionState = {
      installationId: installation.installationId,
      orgId: args.state.orgId,
      userId: args.state.userId,
      publicBrand: PUBLIC_BRAND,
      accountMutation: args.state.accountMutation,
    };
    const completed = await finishFeishuOAuthConnection(
      {
        db,
        state: connectionState,
        installation,
        connector,
        ...exchanged,
        expectedOpenId: context.providerContext.expectedOpenId,
        featureContext,
      },
      signal,
    );
    if (completed !== "connected") {
      return completionErrorResponse(
        connectionErrorMessage(completed, platform),
        query.responseMode,
        platform,
      );
    }
    return callbackRedirectResponse(
      feishuBotOpenUrl(installation.appId, installation.platform),
      query.responseMode,
    );
  },
);

const completeCustomFeishuOAuth$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly query: FeishuOAuthCallbackQuery & { readonly state: string };
    },
    signal: AbortSignal,
  ) => {
    const { db, query } = args;
    const preview = await readCustomConnectorOAuthState(
      db,
      { state: query.state },
      signal,
    );
    if (preview.kind !== "usable") {
      return jsonErrorResponse("Invalid or expired connect state");
    }
    const previewContext = validCustomFeishuState(preview.state);
    if (!previewContext) {
      return jsonErrorResponse("Invalid or expired connect state");
    }
    if (
      Object.values(FEISHU_PLATFORMS).some((platform) => {
        return (
          preview.state.redirectUri ===
          new URL(platform.callbackPath, env("APP_URL")).toString()
        );
      }) &&
      query.responseMode !== "json"
    ) {
      return redirectResponse(
        appCallbackUrl(
          query,
          preview.state.redirectUri === feishuOAuthAppCallbackUrl("lark")
            ? "lark"
            : "feishu",
        ),
      );
    }

    const claimed = await claimConnectorOAuthState(
      db,
      { state: query.state, target: { kind: "custom" } },
      signal,
    );
    signal.throwIfAborted();
    if (claimed.kind !== "usable") {
      return jsonErrorResponse("Invalid or expired connect state");
    }
    const context = validCustomFeishuState(claimed.state);
    if (!context) {
      return jsonErrorResponse("Invalid or expired connect state");
    }
    return await set(
      completeClaimedCustomFeishuOAuth$,
      { db, query, state: claimed.state, context },
      signal,
    );
  },
);

const callback$ = command(async ({ get, set }, signal: AbortSignal) => {
  const query = get(queryOf(feishuOauthContract.callback));
  if (!query.state) {
    return jsonErrorResponse("Invalid or expired connect state");
  }

  const legacyState = verifyFeishuOAuthState(query.state);
  if (legacyState?.callbackTarget === "app" && query.responseMode !== "json") {
    return redirectResponse(
      appCallbackUrl(
        query,
        legacyState.redirectUri === feishuOAuthAppCallbackUrl("lark")
          ? "lark"
          : "feishu",
      ),
    );
  }

  const db = set(writeDb$);
  if (legacyState) {
    return await set(
      completeLegacyFeishuOAuth$,
      { db, query, state: legacyState },
      signal,
    );
  }
  return await set(
    completeCustomFeishuOAuth$,
    { db, query: { ...query, state: query.state } },
    signal,
  );
});

export const feishuOauthRoutes: readonly RouteEntry[] = [
  {
    route: feishuOauthContract.connect,
    handler: connect$,
  },
  {
    route: feishuOauthContract.callback,
    handler: callback$,
  },
];
