import { isIntegrationManagedCustomConnectorProviderAdapter as isManagedAdapter } from "@okouai/api-contracts/contracts/custom-connectors";
import { CUSTOM_CONNECTOR_GET_STARTED_SOURCE_KEY } from "../services/get-started-rewards.service";
import {
  completedGetStartedQuestSql,
  memberRewardWalletQuery,
} from "../services/get-started-member-reward";
import { slackRewardWalletEntitlement } from "../services/slack-installation-reward";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import { secrets } from "@okouai/db/schema/secret";
import { variables } from "@okouai/db/schema/variable";
import { builtinConnectorAccountOauthBindings } from "@okouai/db/schema/connector-account-oauth-binding";
import { customConnectorAccountOauthBindings } from "@okouai/db/schema/custom-connector-account-oauth-binding";
import { userCustomConnectors } from "@okouai/db/schema/user-custom-connector";
import {
  ConnectorConnectionWriteLostError,
  connectorConnectionSelection,
  existingConnectorConnectionSelection,
} from "../services/connector-connection-write.service";
import { FEISHU_CUSTOM_CONNECTOR_PERMISSION_BUNDLE_REF } from "../services/feishu-custom-connector-permissions";
import { decryptPersistentSecretValue } from "../services/crypto.utils";
import {
  FEISHU_PLATFORMS,
  feishuPlatformFromTokenUrl,
  type FeishuPlatform,
} from "@okouai/core/feishu-platform";
import { command, computed } from "ccstate";
import { and, eq, ne, sql } from "drizzle-orm";
import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import { feishuOauthContract } from "@okouai/api-contracts/contracts/feishu-oauth";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { connectors } from "@okouai/db/schema/connector";
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
import { nowDate } from "../../lib/time";
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
  customConnectorOAuth2CredentialContractReadPlan,
  customConnectorOAuth2CredentialContractFromRows as contractFromRows,
  parseValidCustomConnectorOAuthState,
  startCustomConnectorOAuth2$,
  encryptTokenValues,
  connectionTokenRows,
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
import {
  customConnectorDefinitionSelection,
  customConnectorDefinitionJoin,
  customConnectorDefinitionWhere,
  customConnectorDefinitions,
  userCustomConnectorGrantAgentReadPlan,
} from "../services/user-connectors.service";
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
const members = feishuOrgConnections;
const accounts = connectors;
const grants = userCustomConnectors;
const definitions = orgCustomConnectors;
const configs = orgCustomConnectorOauthConfigs;
const wallets = orgMetadataCanonicalWrites;
const entitlements = orgPlanEntitlements;
const bindings = customConnectorAccountOauthBindings;
const builtinBindings = builtinConnectorAccountOauthBindings;
const installations = feishuOrgInstallations;

type FeishuOAuthMember = Pick<
  typeof members.$inferSelect,
  "id" | "userId" | "dmWelcomeSent" | "connectorId"
>;
function feishuOAuthPlan(args: PersistFeishuOAuthConnectionArgs) {
  const scope = {
    orgId: args.state.orgId,
    userId: args.state.userId,
    agentId: args.installation.defaultAgentId,
  };
  const ref = {
    orgId: scope.orgId,
    connectorId: args.connector.id,
    storageVersion: args.connector.storageVersion,
    authMode: "oauth" as const,
  };
  const grantScope = and(
    eq(grants.orgId, scope.orgId),
    eq(grants.userId, scope.userId),
    eq(grants.agentId, scope.agentId),
  );
  return {
    scope,
    ref,
    agent: userCustomConnectorGrantAgentReadPlan(scope),
    contract: customConnectorOAuth2CredentialContractReadPlan(ref),
    memberColumns: {
      id: members.id,
      userId: members.userId,
      dmWelcomeSent: members.dmWelcomeSent,
      connectorId: members.connectorId,
    },
    memberWhere: and(
      eq(members.installationId, args.state.installationId),
      eq(members.feishuOpenId, args.userInfo.openId),
    ),
    memberValues: {
      installationId: args.state.installationId,
      feishuOpenId: args.userInfo.openId,
      userId: scope.userId,
      feishuUserName: args.userInfo.name,
    },
    memberConflict: { target: [members.feishuOpenId, members.installationId] },
    memberReturn: { id: members.id, dmWelcomeSent: members.dmWelcomeSent },
    oldMembers: and(
      eq(members.installationId, args.state.installationId),
      eq(members.userId, scope.userId),
      ne(members.feishuOpenId, args.userInfo.openId),
    ),
    installationWhere: eq(installations.id, args.state.installationId),
    wallet: { orgId: scope.orgId },
    walletReturn: { orgId: orgMetadata.orgId },
    entitlement() {
      return slackRewardWalletEntitlement(scope.orgId);
    },
    entitlementConflict: { target: entitlements.orgId },
    grantScope,
    grantColumns: {
      customConnectorId: grants.customConnectorId,
      permissionNames: grants.permissionNames,
    },
    definitionColumns: customConnectorDefinitionSelection(),
    definitionJoin: customConnectorDefinitionJoin(),
    definitionWhere: customConnectorDefinitionWhere({
      orgId: scope.orgId,
      connectorIds: [args.connector.id],
    }),
    grantConflict: {
      target: [
        grants.orgId,
        grants.userId,
        grants.agentId,
        grants.customConnectorId,
      ],
      set: { permissionNames: sql`excluded.permission_names` },
    },
  };
}
function feishuMemberIdentity(args: PersistFeishuOAuthConnectionArgs) {
  return { feishuUserName: args.userInfo.name, updatedAt: nowDate() };
}
function feishuPersistedMember(
  row: Pick<FeishuOAuthMember, "id" | "dmWelcomeSent"> | undefined,
  connectorId: string | null,
) {
  return row
    ? {
        connected: true as const,
        connectionId: row.id,
        memberConnectorId: connectorId,
        shouldNotify: !row.dmWelcomeSent,
      }
    : { connected: false as const };
}
function requireFeishuGrantAgent(agent: unknown) {
  if (!agent) {
    throw new Error(
      "Failed to authorize Feishu custom connector: agentNotFound",
    );
  }
}
function feishuOAuthAccountPlan(
  args: PersistFeishuOAuthConnectionArgs,
  memberConnectorId: string | null,
) {
  const account = memberConnectorId
    ? { intent: "reconnect" as const, connectionId: memberConnectorId }
    : args.state.accountMutation;
  const owner = and(
    eq(accounts.orgId, args.state.orgId),
    eq(accounts.userId, args.state.userId),
    eq(accounts.customConnectorId, args.connector.id),
  );
  return {
    account,
    owner,
    columns: existingConnectorConnectionSelection(),
    condition:
      account.intent === "reconnect"
        ? and(eq(accounts.id, account.connectionId), owner)
        : owner,
  };
}
function feishuOAuthAccountWrite(
  args: PersistFeishuOAuthConnectionArgs,
  plan: ReturnType<typeof feishuOAuthAccountPlan>,
  existing: { readonly id: string } | undefined,
  allowSiblings: boolean,
) {
  if (
    (plan.account.intent === "reconnect" && !existing) ||
    (plan.account.intent !== "reconnect" && existing && !allowSiblings)
  ) {
    throw new Error("Feishu connector account could not be selected");
  }
  const values = {
    authMethod: "oauth",
    automaticAuthType: null,
    storageVersion: args.connector.storageVersion,
    externalId: args.token.userInfo?.id ?? null,
    externalUsername: args.token.userInfo?.username ?? null,
    externalEmail: args.token.userInfo?.email ?? null,
    oauthScopes:
      args.token.scopes === null ? null : JSON.stringify(args.token.scopes),
    oauthGrantedScopes: null,
    tokenExpiresAt: args.token.expiresAt,
    needsReconnect: false,
    reconnectReason: null,
  };
  return {
    update: { ...values, updatedAt: sql`clock_timestamp()` },
    insert: {
      orgId: args.state.orgId,
      userId: args.state.userId,
      displayName:
        plan.account.intent === "add"
          ? (plan.account.displayName ?? null)
          : null,
      connectorSlug: null,
      customConnectorId: args.connector.id,
      ...values,
    },
    conflict: {
      target: [accounts.orgId, accounts.userId, accounts.customConnectorId],
      where: sql`${accounts.customConnectorId} IS NOT NULL AND ${accounts.isDefault} = true`,
    },
    columns: connectorConnectionSelection(),
    updateWhere: existing
      ? and(plan.owner, eq(accounts.id, existing.id))
      : plan.owner,
  };
}
function requireFeishuAccount<T>(
  row: T | undefined,
  reason: "missing" | "sibling-disabled" | "insert",
): T {
  if (row) {
    return row;
  }
  if (reason === "insert") {
    throw new Error("Failed to write Custom connector connection");
  }
  throw new ConnectorConnectionWriteLostError(reason);
}
function feishuTokenRows(
  args: PersistFeishuOAuthConnectionArgs,
  connectionId: string,
  prepared: PreparedFeishuTokens,
) {
  if (!prepared.ok) {
    throw prepared.error;
  }
  return connectionTokenRows({
    ...args.state,
    connectionId,
    encrypted: prepared.value,
  });
}
function feishuGrantValues(
  args: PersistFeishuOAuthConnectionArgs,
  previous: readonly {
    readonly customConnectorId: string;
    readonly permissionNames: readonly string[];
  }[],
  rows: Parameters<typeof customConnectorDefinitions>[0],
) {
  const id = args.connector.id;
  const definitions = customConnectorDefinitions(rows, [id]);
  if (definitions.missingIds.length > 0) {
    throw new Error(
      "Failed to authorize Feishu custom connector: customConnectorsNotFound",
    );
  }
  const existing = previous.find((row) => {
    return row.customConnectorId === id;
  });
  const bundle = definitions.permissionBundleRefs.get(id) ?? null;
  if (
    !existing &&
    bundle !== null &&
    bundle !== FEISHU_CUSTOM_CONNECTOR_PERMISSION_BUNDLE_REF
  ) {
    throw new Error(
      "Failed to authorize Feishu custom connector: customConnectorPermissionSelectionRequired",
    );
  }
  return {
    orgId: args.state.orgId,
    userId: args.state.userId,
    agentId: args.installation.defaultAgentId,
    customConnectorId: id,
    permissionNames: [...(existing?.permissionNames ?? [])],
  };
}
function feishuLinkedAccountValues(args: PersistFeishuOAuthConnectionArgs) {
  return {
    externalId: args.userInfo.openId,
    externalUsername: args.userInfo.name,
    updatedAt: nowDate(),
  };
}
function feishuConnectionQuest(args: PersistFeishuOAuthConnectionArgs) {
  return completedGetStartedQuestSql(
    {
      orgId: args.state.orgId,
      userId: args.state.userId,
      questKey: "connector",
      sourceKey: CUSTOM_CONNECTOR_GET_STARTED_SOURCE_KEY,
    },
    nowDate(),
  );
}
function feishuTenantValues(args: PersistFeishuOAuthConnectionArgs) {
  return { feishuTenantKey: args.userInfo.tenantKey, updatedAt: nowDate() };
}

function accountInsertValues(
  write: ReturnType<typeof feishuOAuthAccountWrite>,
  isDefault: boolean,
) {
  return { ...write.insert, isDefault };
}

const persistFeishuOAuthConnection$ = command(
  async function persistFeishuOAuthConnection(
    { set },
    args: PersistFeishuOAuthConnectionArgs,
    prepared: PreparedFeishuTokens,
    signal: AbortSignal,
  ): Promise<PersistFeishuOAuthConnectionResult> {
    const p = feishuOAuthPlan(args);
    // Identity ownership, wallet/quest initialization, credentials and agent
    // grants must commit together; validation failures roll back every write.
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0018; new non-billing transactions are prohibited.
    return await set(writeDb$).transaction(async (tx) => {
      const a = p.agent;
      const aq = tx.select(a.columns).from(a.from).where(a.where);
      const [agent] = await aq.for("update").limit(1);
      signal.throwIfAborted();
      requireFeishuGrantAgent(agent);
      const c = p.contract;
      const cq = tx
        .select(c.columns)
        .from(c.from)
        .leftJoin(c.join.table, c.join.on);
      const contractQuery = cq
        .where(c.where)
        .for("update", { of: c.from })
        .limit(1);
      contractFromRows(await contractQuery, p.ref);
      signal.throwIfAborted();
      const mq = tx.select(p.memberColumns).from(members).where(p.memberWhere);
      const [existing] = await mq.limit(1);
      signal.throwIfAborted();
      if (existing && existing.userId !== args.state.userId) {
        return { connected: false };
      }
      let member;
      if (existing) {
        const values = feishuMemberIdentity(args);
        await tx.update(members).set(values).where(eq(members.id, existing.id));
        member = feishuPersistedMember(existing, existing.connectorId);
      } else {
        const insert = tx.insert(members).values(p.memberValues);
        const [created] = await insert
          .onConflictDoNothing(p.memberConflict)
          .returning(p.memberReturn);
        signal.throwIfAborted();
        member = feishuPersistedMember(created, null);
      }
      if (!member.connected) {
        return member;
      }
      await tx.delete(members).where(p.oldMembers);
      signal.throwIfAborted();
      if (!prepared.ok) {
        throw prepared.error;
      }
      const wq = tx.insert(wallets).values(p.wallet).onConflictDoNothing();
      const [insertedWallet] = await wq.returning(p.walletReturn);
      await tx.select().from(memberRewardWalletQuery(args.state.orgId));
      if (insertedWallet) {
        const ent = tx.insert(entitlements).values(p.entitlement());
        await ent.onConflictDoNothing(p.entitlementConflict);
      }
      const contract = contractFromRows(await contractQuery, p.ref);
      signal.throwIfAborted();
      const ap = feishuOAuthAccountPlan(args, member.memberConnectorId);
      const q = tx.select(ap.columns).from(accounts).where(ap.condition);
      const rows =
        ap.account.intent === "reconnect"
          ? await q.limit(1)
          : await q.orderBy(accounts.id).limit(2);
      signal.throwIfAborted();
      const siblings = !isManagedAdapter(contract.providerAdapter);
      const w = feishuOAuthAccountWrite(args, ap, rows[0], siblings);
      let stored;
      if (ap.account.intent === "reconnect") {
        const update = tx.update(accounts).set(w.update).where(w.updateWhere);
        const [updated] = await update.returning(w.columns);
        stored = requireFeishuAccount(updated, "missing");
      } else {
        const insert = tx.insert(accounts).values(accountInsertValues(w, true));
        const [created] = await insert
          .onConflictDoNothing(w.conflict)
          .returning(w.columns);
        if (created || !siblings) {
          stored = requireFeishuAccount(created, "sibling-disabled");
        } else {
          const sibling = tx
            .insert(accounts)
            .values(accountInsertValues(w, false));
          const [createdSibling] = await sibling.returning(w.columns);
          stored = requireFeishuAccount(createdSibling, "insert");
        }
      }
      signal.throwIfAborted();
      const id = stored.id;
      await tx.delete(secrets).where(eq(secrets.connectorId, id));
      signal.throwIfAborted();
      await tx.delete(variables).where(eq(variables.connectorId, id));
      signal.throwIfAborted();
      const builtin = eq(builtinBindings.connectorAccountId, id);
      await tx.delete(builtinBindings).where(builtin);
      await tx.insert(secrets).values(feishuTokenRows(args, id, prepared));
      await tx.delete(bindings).where(eq(bindings.connectorAccountId, id));
      signal.throwIfAborted();
      await tx.execute(feishuConnectionQuest(args));
      signal.throwIfAborted();
      const linked = { connectorId: id, updatedAt: nowDate() };
      const memberWhere = eq(members.id, member.connectionId);
      await tx.update(members).set(linked).where(memberWhere);
      const identity = feishuLinkedAccountValues(args);
      await tx.update(accounts).set(identity).where(eq(accounts.id, id));
      signal.throwIfAborted();
      if (!args.installation.tenantKey && args.userInfo.tenantKey) {
        const tq = tx.update(installations).set(feishuTenantValues(args));
        await tq.where(p.installationWhere);
      }
      const agentRead = tx.select(a.columns).from(a.from).where(a.where);
      const [grantAgent] = await agentRead.limit(1);
      requireFeishuGrantAgent(grantAgent);
      const gq = tx.select(p.grantColumns).from(grants);
      const previous = await gq.where(p.grantScope);
      const dq = tx.select(p.definitionColumns).from(definitions);
      const definitionsRows = await dq
        .leftJoin(configs, p.definitionJoin)
        .where(p.definitionWhere);
      const values = feishuGrantValues(args, previous, definitionsRows);
      const grant = tx.insert(grants).values(values);
      await grant.onConflictDoUpdate(p.grantConflict);
      signal.throwIfAborted();
      return member;
    });
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
