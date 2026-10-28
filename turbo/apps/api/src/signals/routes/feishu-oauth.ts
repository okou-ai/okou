import {
  feishuOAuthPublicationRow,
  feishuOAuthPublicationSql,
} from "./feishu-oauth-publication";
import { parseRawRows } from "../../lib/db-raw-rows";
import { decryptPersistentSecretValue } from "../services/crypto.utils";
import {
  FEISHU_PLATFORMS,
  feishuPlatformFromTokenUrl,
  type FeishuPlatform,
} from "@okouai/core/feishu-platform";
import { command, computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import { feishuOauthContract } from "@okouai/api-contracts/contracts/feishu-oauth";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { feishuOrgConnections } from "@okouai/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { queryOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { db$, writeDb$ } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import {
  fetchFeishuUserInfo,
  type FeishuUserInfo,
} from "../external/feishu-client";
import type { RouteEntry } from "../route-entry";
import {
  claimCustomConnectorOAuthState$,
  customConnectorOAuthStateByState,
  customConnectorOAuthStatePreview,
  type StoredCustomConnectorOAuthState,
} from "../services/connector-oauth-state.service";
import {
  customConnectorOAuthStateMatchesDefinition,
  isCustomConnectorCustomOAuthStateContext,
  decryptCustomConnectorOAuth2Credentials,
  exchangeCustomConnectorOAuth2Code,
  parseValidCustomConnectorOAuthState,
  startCustomConnectorOAuth2$,
  encryptTokenValues,
  type CustomConnectorCustomOAuthStateContext,
  type CustomConnectorOAuthTokenResult,
} from "../services/custom-connector-oauth2.service";
import {
  ensureManagedFeishuConnector$,
  feishuConnectorAccountMutationReadPlan,
  feishuConnectorAccountMutationFromRows,
} from "../services/feishu-custom-connector.service";
import {
  feishuInstallationAvailabilityReadPlan,
  feishuInstallationEnabledFromRows,
  feishuBotOpenUrl,
  feishuOAuthAppCallbackUrl,
  feishuOAuthCallbackUrl,
  legacyFeishuOAuthAppCallbackUrl,
  feishuInstallationConfigReadPlan,
  feishuInstallationConfigFromSecrets,
} from "../services/feishu-config";
import {
  type FeishuOAuthState,
  verifyFeishuOAuthState,
} from "../services/feishu-oauth-state";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import { publishConnectorRuntimeSyncWakeups$ } from "../services/connector-runtime-wakeup.service";
import {
  getCustomConnectorById,
  type CustomConnectorHttpRow,
  type CustomConnectorRow,
} from "../services/custom-connector.service";
import {
  feishuOrgChangedAdminReadPlan,
  feishuOrgChangedUserIds,
} from "../services/feishu-realtime.service";
import { notifyFeishuConnect$ } from "../services/feishu-welcome.service";
import { tapError, settleIncludingAbort } from "../utils";

const L = logger("FeishuOAuth");
const REDIRECT_STATUS = 307;

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

const loadInstallationForConnector$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly appId: string;
      readonly installationId?: string;
    },
  ): Promise<
    (FeishuInstallationOAuthRow & { readonly installationId: string }) | null
  > => {
    const db = get(db$);
    const conditions = [
      eq(feishuOrgInstallations.orgId, args.orgId),
      eq(feishuOrgInstallations.appId, args.appId),
    ];
    if (args.installationId) {
      conditions.push(eq(feishuOrgInstallations.id, args.installationId));
    }
    const [installation] = await db
      .select({
        installationId: feishuOrgInstallations.id,
        appId: feishuOrgInstallations.appId,
        platform: feishuOrgInstallations.platform,
        tenantKey: feishuOrgInstallations.feishuTenantKey,
        setupCompletedAt: feishuOrgInstallations.setupCompletedAt,
        ownerUserId: feishuOrgInstallations.ownerUserId,
        defaultAgentId: orgMetadata.defaultAgentId,
      })
      .from(feishuOrgInstallations)
      .leftJoin(
        orgMetadata,
        eq(orgMetadata.orgId, feishuOrgInstallations.orgId),
      )
      .where(and(...conditions))
      .limit(1);
    if (!installation?.defaultAgentId) {
      return null;
    }
    return { ...installation, defaultAgentId: installation.defaultAgentId };
  },
);

interface PersistFeishuOAuthConnectionArgs {
  readonly state: FeishuConnectionState;
  readonly installation: FeishuInstallationOAuthRow;
  readonly connector: CustomConnectorHttpRow;
  readonly token: CustomConnectorOAuthTokenResult;
  readonly userInfo: FeishuUserInfo;
  readonly featureContext: FeatureSwitchContext;
}

type PersistFeishuOAuthConnectionResult =
  | { readonly connected: false }
  | {
      readonly connected: true;
      readonly connectionId: string;
      readonly shouldNotify: boolean;
    };

type PreparedFeishuTokens = Awaited<ReturnType<typeof prepareFeishuTokens>>;
function prepareFeishuTokens(args: PersistFeishuOAuthConnectionArgs) {
  return settleIncludingAbort(encryptTokenValues(args));
}
const persistFeishuOAuthConnection$ = command(
  async function persistFeishuOAuthConnection(
    { set },
    args: PersistFeishuOAuthConnectionArgs,
    prepared: PreparedFeishuTokens,
    signal: AbortSignal,
  ): Promise<PersistFeishuOAuthConnectionResult> {
    const db = set(writeDb$);
    signal.throwIfAborted();
    const [result] = parseRawRows(
      feishuOAuthPublicationRow,
      await db.execute(
        feishuOAuthPublicationSql(args, prepared.ok ? prepared.value : null),
      ),
    );
    signal.throwIfAborted();
    if (!result?.agent) {
      throw new Error(
        "Failed to authorize Feishu custom connector: agentNotFound",
      );
    }
    if (!result.credentialContract) {
      throw new Error(
        "Custom connector credential contract changed during OAuth connection",
      );
    }
    if (result.foreignOwner) {
      return { connected: false };
    }
    if (!prepared.ok) {
      throw prepared.error;
    }
    if (!result.definitionEnabled) {
      throw new Error(
        "Failed to authorize Feishu custom connector: customConnectorsNotFound",
      );
    }
    return result.member
      ? { connected: true, ...result.member }
      : { connected: false };
  },
);

type FeishuConnectionCompletionResult =
  "account_in_use" | "connected" | "identity_mismatch" | "tenant_mismatch";

const finishFeishuOAuthConnection$ = command(
  async (
    { set },
    args: {
      readonly state: FeishuConnectionState;
      readonly installation: FeishuInstallationOAuthRow;
      readonly connector: CustomConnectorHttpRow;
      readonly token: CustomConnectorOAuthTokenResult;
      readonly userInfo: FeishuUserInfo;
      readonly expectedOpenId?: string;
      readonly featureContext: FeatureSwitchContext;
    },
    signal: AbortSignal,
  ): Promise<FeishuConnectionCompletionResult> => {
    const db = set(writeDb$);
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
    const prepared = await prepareFeishuTokens(args);
    signal.throwIfAborted();
    const connectionPersistence = set(
      persistFeishuOAuthConnection$,
      args,
      prepared,
      signal,
    );
    const connection = await (async () => {
      const result = await connectionPersistence;
      if (result.connected) {
        await set(
          publishConnectorRuntimeSyncWakeups$,
          {
            scope: { orgId: args.state.orgId, userId: args.state.userId },
            targets: [{ kind: "custom", customConnectorId: args.connector.id }],
          },
          signal,
        );
      }
      return result;
    })();
    // A committed connection must invalidate clients before surfacing abort.
    if (signal.aborted) {
      if (!connection.connected) {
        signal.throwIfAborted();
      }
    }
    if (!connection.connected) {
      return "account_in_use";
    }

    signal.throwIfAborted();
    await publishUserSignal(
      [args.state.userId],
      "composerAgentConnectorsChanged",
      { agentId: args.installation.defaultAgentId },
    );
    signal.throwIfAborted();

    await (async () => {
      const plan = feishuOrgChangedAdminReadPlan(args.state.orgId);
      const admins = await db
        .select(plan.columns)
        .from(orgMembersCache)
        .where(plan.condition);
      const userIds = feishuOrgChangedUserIds(
        admins,
        args.installation.ownerUserId,
        [args.state.userId],
      );
      if (userIds.length === 0) {
        return;
      }
      await publishUserSignal(userIds, "feishu:changed");
    })();
    signal.throwIfAborted();
    if (connection.shouldNotify) {
      const backgroundSignal = new AbortController().signal;
      waitUntil(
        tapError(
          set(
            notifyFeishuConnect$,
            {
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
  },
);

function connectionErrorMessage(
  result: Exclude<FeishuConnectionCompletionResult, "connected">,
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

function feishuConnectionCompletionResponse(
  completed: FeishuConnectionCompletionResult,
  platform: FeishuPlatform,
  installation: Pick<FeishuInstallationOAuthRow, "appId" | "platform">,
  responseMode: FeishuOAuthCallbackQuery["responseMode"],
): ReturnType<typeof callbackRedirectResponse> {
  if (completed !== "connected") {
    return completionErrorResponse(
      connectionErrorMessage(completed, platform),
      responseMode,
      platform,
    );
  }
  return callbackRedirectResponse(
    feishuBotOpenUrl(installation.appId, installation.platform),
    responseMode,
  );
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
  if (
    !(await (async () => {
      const plan = feishuInstallationAvailabilityReadPlan(installation);
      if (plan.kind === "resolved") {
        return plan.enabled;
      }
      const rows = await db
        .select(plan.columns)
        .from(userFeatureSwitches)
        .where(plan.condition);
      return feishuInstallationEnabledFromRows(plan.scope, rows);
    })())
  ) {
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
    ensureManagedFeishuConnector$,
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
  const accountPlan = feishuConnectorAccountMutationReadPlan({
    installationId: state.installationId,
    userId: state.userId,
  });
  const account = feishuConnectorAccountMutationFromRows(
    await db
      .select(accountPlan.columns)
      .from(feishuOrgConnections)
      .where(accountPlan.condition)
      .limit(2),
  );
  signal.throwIfAborted();
  const result = await set(
    startCustomConnectorOAuth2$,
    {
      orgId: state.orgId,
      userId: state.userId,
      connectorId,
      redirectUri: state.redirectUri,
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

function legacyFeishuOAuthInput(
  query: FeishuOAuthCallbackQuery,
  platform: FeishuPlatform,
) {
  if (query.error) {
    return {
      response: completionErrorResponse(
        query.error_description ?? query.error,
        query.responseMode,
        platform,
      ),
    };
  }
  if (!query.code) {
    return { response: jsonErrorResponse("Missing authorization code") };
  }
  return { code: query.code };
}

function legacyFeishuOAuthFailure(
  reason: "bot" | "setup" | "connector" | "unavailable" | "exchange",
  query: FeishuOAuthCallbackQuery,
  platform: FeishuPlatform,
) {
  const name = FEISHU_PLATFORMS[platform].name;
  const messages = {
    bot: `${name} bot not found.`,
    setup: `Finish setting up this ${name} bot before connecting.`,
    connector: `${name} connector not found.`,
    unavailable: `${name} connector is unavailable.`,
    exchange: `Failed to connect ${name} account. Please try again.`,
  };
  return completionErrorResponse(
    messages[reason],
    query.responseMode,
    platform,
  );
}

function legacyTokenInput(
  connector: CustomConnectorHttpRow,
  clientSecret: string,
  code: string,
  state: FeishuOAuthState,
) {
  return {
    connector,
    clientSecret,
    code,
    codeVerifier: null,
    redirectUri: legacyOAuthRedirectUri(state.oauthRedirectTarget),
    installationId: state.installationId,
  };
}

function legacyConnectionState(
  state: FeishuOAuthState,
  accountMutation: ConnectorAccountMutationIntent,
) {
  return { ...state, accountMutation };
}

const completeLegacyFeishuOAuth$ = command(
  async (
    { get, set },
    args: {
      readonly query: FeishuOAuthCallbackQuery;
      readonly state: FeishuOAuthState;
    },
    signal: AbortSignal,
  ) => {
    const { query, state } = args;
    const db = set(writeDb$);
    const platform = callbackPlatform(state.redirectUri);
    const input = legacyFeishuOAuthInput(query, platform);
    if (input.response) {
      return input.response;
    }
    const config = await (async () => {
      const plan = feishuInstallationConfigReadPlan(state.installationId);
      const [installation] = await db
        .select(plan.columns)
        .from(feishuOrgInstallations)
        .where(plan.condition)
        .limit(1);
      if (
        !installation ||
        !(await (async () => {
          const availability =
            feishuInstallationAvailabilityReadPlan(installation);
          if (availability.kind === "resolved") {
            return availability.enabled;
          }
          const rows = await db
            .select(availability.columns)
            .from(userFeatureSwitches)
            .where(availability.condition);
          return feishuInstallationEnabledFromRows(availability.scope, rows);
        })())
      ) {
        return null;
      }
      const context = { orgId: installation.orgId };
      const secrets = await Promise.all([
        decryptPersistentSecretValue(installation.encryptedAppSecret, context),
        decryptPersistentSecretValue(
          installation.encryptedVerificationToken,
          context,
        ),
        decryptPersistentSecretValue(installation.encryptedEncryptKey, context),
      ]);
      return feishuInstallationConfigFromSecrets(installation, secrets);
    })();
    signal.throwIfAborted();
    if (!config || config.orgId !== state.orgId) {
      return legacyFeishuOAuthFailure("bot", query, platform);
    }
    const installation = await set(loadInstallationForConnector$, {
      orgId: state.orgId,
      appId: config.appId,
      installationId: state.installationId,
    });
    signal.throwIfAborted();
    if (!installation?.setupCompletedAt) {
      return legacyFeishuOAuthFailure("setup", query, platform);
    }
    const connectorId = await set(
      ensureManagedFeishuConnector$,
      {
        orgId: state.orgId,
        userId: state.userId,
        installationId: state.installationId,
      },
      signal,
    );
    if (!connectorId) {
      return legacyFeishuOAuthFailure("connector", query, platform);
    }
    const connector = await get(
      getCustomConnectorById({
        orgId: state.orgId,
        connectorId,
      }),
    );
    signal.throwIfAborted();
    if (!isFeishuCustomOAuthConnector(connector)) {
      return legacyFeishuOAuthFailure("unavailable", query, platform);
    }
    const accountPlan = feishuConnectorAccountMutationReadPlan(state);
    const accountMutation = feishuConnectorAccountMutationFromRows(
      await db
        .select(accountPlan.columns)
        .from(feishuOrgConnections)
        .where(accountPlan.condition)
        .limit(2),
    );
    signal.throwIfAborted();
    const exchanged = await exchangeOAuthTokenAndUserInfo(
      legacyTokenInput(connector, config.appSecret, input.code, state),
      signal,
    );
    signal.throwIfAborted();
    if (!exchanged) {
      return legacyFeishuOAuthFailure("exchange", query, platform);
    }
    const featureContext = await get(
      userFeatureSwitchContext(state.orgId, state.userId),
    );
    signal.throwIfAborted();
    const completed = await set(
      finishFeishuOAuthConnection$,
      {
        state: legacyConnectionState(state, accountMutation),
        installation,
        connector,
        ...exchanged,
        featureContext,
      },
      signal,
    );
    return feishuConnectionCompletionResponse(
      completed,
      platform,
      installation,
      query.responseMode,
    );
  },
);

interface CompleteClaimedFeishuOAuthArgs {
  readonly query: FeishuOAuthCallbackQuery & { readonly state: string };
  readonly state: StoredCustomConnectorOAuthState;
  readonly context: FeishuCustomConnectorOAuthContext;
}

const completeClaimedCustomFeishuOAuth$ = command(
  async (
    { get, set },
    args: CompleteClaimedFeishuOAuthArgs,
    signal: AbortSignal,
  ) => {
    const { context, query, state } = args;
    const db = get(db$);
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
    const installation = await set(loadInstallationForConnector$, {
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
      !(await (async () => {
        const plan = feishuInstallationAvailabilityReadPlan({
          ...installation,
          orgId: state.orgId,
        });
        if (plan.kind === "resolved") {
          return plan.enabled;
        }
        const rows = await db
          .select(plan.columns)
          .from(userFeatureSwitches)
          .where(plan.condition);
        return feishuInstallationEnabledFromRows(plan.scope, rows);
      })())
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
      accountMutation: args.state.accountMutation,
    };
    const completed = await set(
      finishFeishuOAuthConnection$,
      {
        state: connectionState,
        installation,
        connector,
        ...exchanged,
        expectedOpenId: context.providerContext.expectedOpenId,
        featureContext,
      },
      signal,
    );
    return feishuConnectionCompletionResponse(
      completed,
      platform,
      installation,
      query.responseMode,
    );
  },
);

const customConnectorOAuthState$ = customConnectorOAuthStateByState(
  computed((get) => {
    return get(queryOf(feishuOauthContract.callback)).state;
  }),
);

const completeCustomFeishuOAuth$ = command(
  async (
    { get, set },
    args: {
      readonly query: FeishuOAuthCallbackQuery & { readonly state: string };
    },
    signal: AbortSignal,
  ) => {
    const { query } = args;
    const storedState = await get(customConnectorOAuthState$);
    signal.throwIfAborted();
    const preview = customConnectorOAuthStatePreview(storedState);
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

    const claimed = await set(
      claimCustomConnectorOAuthState$,
      query.state,
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
      { query, state: claimed.state, context },
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

  if (legacyState) {
    return await set(
      completeLegacyFeishuOAuth$,
      { query, state: legacyState },
      signal,
    );
  }
  return await set(
    completeCustomFeishuOAuth$,
    { query: { ...query, state: query.state } },
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
