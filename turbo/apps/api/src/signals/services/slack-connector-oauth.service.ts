import { INTEGRATION_SETTINGS_PATHS } from "@okouai/core/integration-routes";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { connectSlackWorkspace$ } from "./slack-workspace-write.service";
import { randomBytes } from "node:crypto";

import { command } from "ccstate";
import { checkOAuthCallbackActor$ } from "./oauth-callback-actor";
import { and, eq } from "drizzle-orm";
import { persistSlackInstallation$ } from "./slack-installation-write.service";
import {
  isStaticConfidentialConnectorAuthClient,
  resolveConnectorAuthClient,
} from "@okouai/connectors/connector-auth-method";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";

import { env, optionalEnv } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { logger } from "../../lib/log";
import { db$, writeDb$ } from "../external/db";
import {
  exchangeSlackOAuthCodeForConnector,
  fetchSlackConnectorUserInfo,
} from "../external/slack-oauth-client";
import { waitUntil } from "../context/wait-until";
import { safeJsonParse, tapError } from "../utils";
import { connectorActionResolver } from "./connector-action-resolver.service";
import {
  connectorConnectionWriteFailureMessage,
  upsertBuiltinConnectorTokenConnection$,
} from "./connector-data.service";
import {
  claimBuiltinConnectorOAuthState$,
  insertConnectorOAuthState$,
} from "./connector-oauth-state.service";
import { getMemberRoleAndUpdateCache$ } from "./auth.service";
import {
  loadUserFeatureSwitchContext$,
  userFeatureSwitchContext,
} from "./feature-switches.service";
import {
  decryptPersistentSecretValue,
  encryptPersistentSecretValue,
} from "./crypto.utils";
import { SLACK_BOT_SCOPES } from "./slack-data.service";
import {
  notifySlackConnect$,
  publishSlackAdminSignal$,
} from "./slack-connect.service";
import {
  slackConnectorOAuthContextSchema,
  SLACK_CONNECTOR_OAUTH_STATE_PREFIX,
  verifySlackConnectorOAuthStart,
  type SlackConnectorOAuthContext,
} from "./slack-connector-oauth-state";
import { resolveOAuthRequestedScopeSnapshot } from "./connector-oauth-scope-snapshot.service";
import { connectSlackAccount$ } from "./slack-workspace-identity.service";
import { createSlackClient } from "../external/slack-message-client";

const L = logger("SlackConnectorOAuth");
const slackOAuthResolver$ = connectorActionResolver(["slack"]);

function redirect(url: string): Response {
  return new Response(null, {
    status: 307,
    headers: { location: url, "Cache-Control": "no-store" },
  });
}

function failed(
  message: string,
  context?: SlackConnectorOAuthContext,
): Response {
  const url = new URL(INTEGRATION_SETTINGS_PATHS.slack, env("APP_URL"));
  url.searchParams.set("error", message);
  if (context?.workspaceId) {
    url.searchParams.set("w", context.workspaceId);
  }
  if (context?.slackUserId) {
    url.searchParams.set("u", context.slackUserId);
  }
  if (context?.channelId) {
    url.searchParams.set("c", context.channelId);
  }
  if (context?.threadTs) {
    url.searchParams.set("t", context.threadTs);
  }
  return redirect(url.toString());
}

const resolveSlackOAuthMethod$ = command(
  async ({ get }, starting: boolean, signal: AbortSignal) => {
    const resolver = await get(slackOAuthResolver$);
    signal.throwIfAborted();
    const args = {
      connectorSlug: "slack",
      authMethodId: "oauth",
      expectedGrantKind: "auth-code",
    } as const;
    const resolved = starting
      ? resolver.resolveNewActionMethod(args)
      : resolver.resolveMethod(args);
    if (
      !resolved.ok ||
      resolved.method.grant.kind !== "auth-code" ||
      !resolved.method.client
    ) {
      throw new Error("Slack OAuth connector is unavailable");
    }
    const client = resolveConnectorAuthClient(
      resolved.method.client,
      optionalEnv,
    );
    if (!client || !isStaticConfidentialConnectorAuthClient(client)) {
      throw new Error("Slack OAuth connector is not configured");
    }
    return { resolved, client, scopes: resolved.method.grant.scopes };
  },
);

export const startSlackConnectorOAuth$ = command(
  async (
    { set },
    args: {
      readonly flow: "install" | "connect";
      readonly connectorState: string;
      readonly redirectUri: string;
    },
    signal: AbortSignal,
  ): Promise<Response> => {
    const signedContext = verifySlackConnectorOAuthStart(args.connectorState);
    const featureContext = signedContext
      ? await set(
          loadUserFeatureSwitchContext$,
          signedContext.orgId,
          signedContext.userId,
          signal,
        )
      : undefined;
    signal.throwIfAborted();
    const accountEnabled =
      featureContext &&
      isFeatureEnabled(FeatureSwitchKey.SlackWorkspaceIdentity, featureContext);
    const context =
      signedContext && signedContext.flow !== "install" && accountEnabled
        ? { ...signedContext, accountConnection: true }
        : signedContext;
    if (context?.accountConnection && !accountEnabled) {
      return failed("Slack workspace identity is not enabled.", context);
    }
    const routeFlow = context?.flow === "switch" ? "connect" : context?.flow;
    if (!context || routeFlow !== args.flow) {
      return failed(
        "This Slack connection link is invalid or expired. Please start again.",
      );
    }
    const member = await set(
      getMemberRoleAndUpdateCache$,
      context.orgId,
      context.userId,
      signal,
    );
    if (
      member.kind !== "member" ||
      (context.flow === "install" && member.role !== "admin")
    ) {
      return failed(
        "You do not have permission to connect this Slack workspace.",
        context,
      );
    }
    const { resolved, client, scopes } = await set(
      resolveSlackOAuthMethod$,
      true,
      signal,
    );
    signal.throwIfAborted();
    const state = `${SLACK_CONNECTOR_OAUTH_STATE_PREFIX}${randomBytes(32).toString("hex")}`;
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("redirect_uri", args.redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("user_scope", scopes.join(","));
    if (context.flow === "install") {
      url.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));
    }
    if (context.workspaceId) {
      url.searchParams.set("team", context.workspaceId);
    }
    await set(
      insertConnectorOAuthState$,
      {
        state,
        connectorSlug: "slack",
        authMethod: resolved.authMethodId,
        orgId: context.orgId,
        userId: context.userId,
        redirectUri: args.redirectUri,
        authorizationUrl: url.toString(),
        oauthRequestedScopes: JSON.stringify(scopes),
        oauthContext: JSON.stringify(context),
        accountMutation: { intent: "add" },
        expiresAt: new Date(nowDate().getTime() + 15 * 60 * 1000),
      },
      signal,
    );
    signal.throwIfAborted();
    return redirect(url.toString());
  },
);

const storeInstallation$ = command(
  async (
    { get, set },
    args: {
      readonly context: SlackConnectorOAuthContext;
      readonly oauth: Awaited<
        ReturnType<typeof exchangeSlackOAuthCodeForConnector>
      >;
    },
    signal: AbortSignal,
  ) => {
    const { context, oauth } = args;
    if (!oauth.botToken || !oauth.botUserId || !oauth.botScopes) {
      throw new Error(
        "Slack OAuth did not return the requested bot credentials",
      );
    }
    const featureContext = await get(
      userFeatureSwitchContext(context.orgId, context.userId),
    );
    signal.throwIfAborted();
    const encryptedBotToken = await encryptPersistentSecretValue(
      oauth.botToken,
      featureContext,
    );
    signal.throwIfAborted();
    await set(
      persistSlackInstallation$,
      {
        mode: "connect",
        workspaceId: oauth.teamId,
        orgId: context.orgId,
        userId: context.userId,
        fields: {
          slackWorkspaceName: oauth.teamName,
          encryptedBotToken,
          botUserId: oauth.botUserId,
          botScopes: JSON.stringify(oauth.botScopes.split(",").filter(Boolean)),
        },
      },
      signal,
    );
    signal.throwIfAborted();
  },
);

const resolveSlackConnectorCallback$ = command(
  async (
    { set },
    args: {
      readonly code?: string;
      readonly state: string;
      readonly error?: string;
    },
    signal: AbortSignal,
  ) => {
    const claimed = await set(
      claimBuiltinConnectorOAuthState$,
      {
        state: args.state,
        connectorSlug: "slack",
      },
      signal,
    );
    if (claimed.kind !== "usable") {
      return failed(
        "This Slack authorization has expired or was already used. Please start again.",
      );
    }
    const stored = claimed.state;
    const parsed = slackConnectorOAuthContextSchema.safeParse(
      safeJsonParse(stored.oauthContext ?? ""),
    );
    if (
      !parsed.success ||
      parsed.data.orgId !== stored.orgId ||
      parsed.data.userId !== stored.userId ||
      stored.authMethod !== "oauth"
    ) {
      return failed("Invalid Slack authorization context.");
    }
    const context = parsed.data;
    const actorError = await set(checkOAuthCallbackActor$, context, signal);
    if (actorError) {
      return failed(actorError, context);
    }
    if (args.error || !args.code) {
      return failed(
        "Slack authorization was not completed. Please try again.",
        context,
      );
    }
    const member = await set(
      getMemberRoleAndUpdateCache$,
      context.orgId,
      context.userId,
      signal,
    );
    if (
      member.kind !== "member" ||
      (context.flow === "install" && member.role !== "admin")
    ) {
      return failed(
        "You do not have permission to connect this Slack workspace.",
        context,
      );
    }
    const { resolved, client, scopes } = await set(
      resolveSlackOAuthMethod$,
      false,
      signal,
    );
    signal.throwIfAborted();
    const oauth = await exchangeSlackOAuthCodeForConnector(
      client.clientId,
      client.clientSecret,
      args.code,
      stored.redirectUri,
    );
    signal.throwIfAborted();
    if (context.accountConnection) {
      const features = await set(
        loadUserFeatureSwitchContext$,
        context.orgId,
        context.userId,
        signal,
      );
      signal.throwIfAborted();
      if (
        !isFeatureEnabled(FeatureSwitchKey.SlackWorkspaceIdentity, features)
      ) {
        return failed("Slack workspace identity is not enabled.", context);
      }
    }
    if (context.workspaceId && context.workspaceId !== oauth.teamId) {
      return failed(
        "Use the Slack workspace that opened this connection.",
        context,
      );
    }
    if (context.slackUserId && context.slackUserId !== oauth.userId) {
      return failed(
        "Use the Slack account that opened this connection.",
        context,
      );
    }
    const requestedScopes = resolveOAuthRequestedScopeSnapshot(
      stored.oauthRequestedScopes,
      scopes,
    );
    if (
      !requestedScopes.every((scope) => {
        return oauth.userScopes.includes(scope);
      })
    ) {
      return failed(
        "Slack did not grant all requested connector permissions. Please authorize again.",
        context,
      );
    }
    return {
      context,
      member,
      resolved,
      oauth,
      requestedScopes,
      storedId: stored.id,
    };
  },
);

const validateSlackWorkspace$ = command(
  async (
    { set },
    args: {
      readonly context: SlackConnectorOAuthContext;
      readonly workspaceId: string;
      readonly slackUserId: string;
      readonly role: "admin" | "member";
    },
    signal: AbortSignal,
  ): Promise<Response | null> => {
    const { context } = args;
    if (context.accountConnection) {
      return null;
    }
    const db = set(writeDb$);
    const [installation] = await db
      .select({ orgId: slackOrgInstallations.orgId })
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.slackWorkspaceId, args.workspaceId))
      .limit(1);
    signal.throwIfAborted();
    if (
      (installation?.orgId && installation.orgId !== context.orgId) ||
      (context.flow !== "install" &&
        (!installation ||
          (installation.orgId === null && args.role !== "admin")))
    ) {
      return failed(
        "This Slack workspace is unavailable for your organization.",
        context,
      );
    }
    const [otherInstallation] = await db
      .select({ id: slackOrgInstallations.slackWorkspaceId })
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.orgId, context.orgId))
      .limit(1);
    signal.throwIfAborted();
    if (otherInstallation && otherInstallation.id !== args.workspaceId) {
      return failed(
        "Your organization is connected to a different Slack workspace.",
        context,
      );
    }
    const [connection] = await db
      .select({ userId: slackOrgConnections.userId })
      .from(slackOrgConnections)
      .where(
        and(
          eq(slackOrgConnections.slackWorkspaceId, args.workspaceId),
          eq(slackOrgConnections.slackUserId, args.slackUserId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (connection && connection.userId !== context.userId) {
      return failed(
        "This Slack account is already connected to another user.",
        context,
      );
    }
    const [currentConnection] = await db
      .select({ slackUserId: slackOrgConnections.slackUserId })
      .from(slackOrgConnections)
      .where(
        and(
          eq(slackOrgConnections.slackWorkspaceId, args.workspaceId),
          eq(slackOrgConnections.userId, context.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (
      currentConnection &&
      currentConnection.slackUserId !== args.slackUserId &&
      context.flow !== "switch"
    ) {
      return failed(
        "Your Okou account is connected to a different Slack account in this workspace.",
        context,
      );
    }
    return null;
  },
);

const notifySlackAccountConnected$ = command(
  async ({ get }, context: SlackConnectorOAuthContext, signal: AbortSignal) => {
    if (
      !context.sourceWorkspaceId ||
      !context.channelId ||
      !context.slackUserId
    ) {
      return;
    }
    const [installation] = await get(db$)
      .select()
      .from(slackOrgInstallations)
      .where(
        eq(slackOrgInstallations.slackWorkspaceId, context.sourceWorkspaceId),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!installation) {
      return;
    }
    const token = await decryptPersistentSecretValue(
      installation.encryptedBotToken,
      installation.orgId ? { orgId: installation.orgId } : {},
    );
    signal.throwIfAborted();
    await createSlackClient(token).postEphemeral({
      channel: context.channelId,
      user: context.slackUserId,
      threadTs: context.threadTs,
      text: "Your Slack account is connected. Bot tools use your own workspace's Okou installation.",
    });
    signal.throwIfAborted();
  },
);

function slackConnectionSuccess(
  context: SlackConnectorOAuthContext,
  oauth: Awaited<ReturnType<typeof exchangeSlackOAuthCodeForConnector>>,
): Response {
  const url = new URL(INTEGRATION_SETTINGS_PATHS.slack, env("APP_URL"));
  url.searchParams.set("status", "connected");
  url.searchParams.set("workspace", oauth.teamName);
  url.searchParams.set("w", oauth.teamId);
  url.searchParams.set("u", oauth.userId);
  if (context.channelId) {
    url.searchParams.set("c", context.channelId);
  }
  if (context.threadTs) {
    url.searchParams.set("t", context.threadTs);
  }
  if (context.reinstall) {
    url.searchParams.set("updated", "1");
  }
  return redirect(url.toString());
}

const finishSlackAccountConnection$ = command(
  async (
    { set },
    args: {
      readonly context: SlackConnectorOAuthContext;
      readonly oauth: Awaited<
        ReturnType<typeof exchangeSlackOAuthCodeForConnector>
      >;
    },
    signal: AbortSignal,
  ): Promise<Response> => {
    const { context, oauth } = args;
    const account = await set(
      connectSlackAccount$,
      {
        orgId: context.orgId,
        userId: context.userId,
        workspaceId: oauth.teamId,
        workspaceName: oauth.teamName,
        slackUserId: oauth.userId,
        replace: context.flow === "switch",
      },
      signal,
    );
    if (account.kind !== "ok") {
      return failed(account.message, context);
    }
    await set(
      publishSlackAdminSignal$,
      { orgId: context.orgId, topic: "slack:changed" },
      signal,
    );
    if (context.sourceWorkspaceId && context.channelId) {
      waitUntil(
        tapError(
          set(notifySlackAccountConnected$, context, signal),
          (error) => {
            return L.warn("Failed to notify Slack connection", { error });
          },
        ),
      );
    }
    return slackConnectionSuccess(context, oauth);
  },
);

const promoteSlackAccountConnection$ = command(
  async (
    { set },
    args: {
      readonly context: SlackConnectorOAuthContext;
      readonly oauth: Awaited<
        ReturnType<typeof exchangeSlackOAuthCodeForConnector>
      >;
    },
    signal: AbortSignal,
  ): Promise<Response | null> => {
    const { context, oauth } = args;
    const accountFeatures = await set(
      loadUserFeatureSwitchContext$,
      context.orgId,
      context.userId,
      signal,
    );
    if (
      isFeatureEnabled(FeatureSwitchKey.SlackWorkspaceIdentity, accountFeatures)
    ) {
      const account = await set(
        connectSlackAccount$,
        {
          orgId: context.orgId,
          userId: context.userId,
          workspaceId: oauth.teamId,
          workspaceName: oauth.teamName,
          slackUserId: oauth.userId,
          replace: context.flow === "switch",
        },
        signal,
      );
      if (account.kind !== "ok") {
        return failed(account.message, context);
      }
    }
    return null;
  },
);

const finishSlackConnectorOAuth$ = command(
  async (
    { set },
    args: {
      readonly code?: string;
      readonly state: string;
      readonly error?: string;
    },
    signal: AbortSignal,
  ): Promise<Response> => {
    const authorization = await set(
      resolveSlackConnectorCallback$,
      args,
      signal,
    );
    if (authorization instanceof Response) {
      return authorization;
    }
    const { context, member, resolved, oauth, requestedScopes, storedId } =
      authorization;
    const validationError = await set(
      validateSlackWorkspace$,
      {
        context,
        workspaceId: oauth.teamId,
        slackUserId: oauth.userId,
        role: member.role,
      },
      signal,
    );
    if (validationError) {
      return validationError;
    }
    const userInfo = await fetchSlackConnectorUserInfo(
      oauth.userToken,
      oauth.userId,
    );
    signal.throwIfAborted();
    if (context.flow === "install") {
      await set(storeInstallation$, { context, oauth }, signal);
    }
    const connector = await set(
      upsertBuiltinConnectorTokenConnection$,
      {
        orgId: context.orgId,
        userId: context.userId,
        runtimeMethod: resolved.runtimeMethod,
        snapshot: resolved.snapshot,
        outputs: { accessToken: oauth.userToken },
        userInfo,
        oauthRequestedScopes: requestedScopes,
        oauthGrantedScopes: oauth.userScopes,
        account: { intent: "add" },
        matchExistingExternalIdentity: true,
        insertConnectionId: storedId,
      },
      signal,
    );
    if (connector.status !== "connected") {
      return failed(
        connectorConnectionWriteFailureMessage(connector.status),
        context,
      );
    }
    if (context.accountConnection) {
      return await set(
        finishSlackAccountConnection$,
        { context, oauth },
        signal,
      );
    }
    const connection = await set(
      connectSlackWorkspace$,
      {
        orgId: context.orgId,
        userId: context.userId,
        orgRole: member.role,
        workspaceId: oauth.teamId,
        slackUserId: oauth.userId,
        channelId: context.channelId,
        threadTs: context.threadTs,
        pendingPrompt: context.prompt,
        connectionIntent: context.flow === "switch" ? "switch" : "connect",
      },
      signal,
    );
    if (connection.kind !== "ok") {
      return failed(connection.message, context);
    }
    const accountError = await set(
      promoteSlackAccountConnection$,
      { context, oauth },
      signal,
    );
    if (accountError) {
      return accountError;
    }
    await set(
      publishSlackAdminSignal$,
      { orgId: context.orgId, topic: "slack:changed" },
      signal,
    );
    waitUntil(
      tapError(
        set(
          notifySlackConnect$,
          {
            installation: connection.installation,
            slackUserId: oauth.userId,
            orgId: context.orgId,
            userId: context.userId,
            channelId: context.channelId,
            threadTs: context.threadTs,
            pendingPrompt: context.prompt,
            replacedSlackUserIds: connection.replacedSlackUserIds,
          },
          signal,
        ),
        (error) => {
          return L.warn("Failed to notify Slack connection", { error });
        },
      ),
    );
    return slackConnectionSuccess(context, oauth);
  },
);

export const completeSlackConnectorOAuth$ = command(
  async (
    { set },
    args: {
      readonly code?: string;
      readonly state: string;
      readonly error?: string;
    },
    signal: AbortSignal,
  ): Promise<Response> => {
    const result = await tapError(
      set(finishSlackConnectorOAuth$, args, signal),
      (error) => {
        L.error("Slack connector authorization failed", { error });
      },
    );
    signal.throwIfAborted();
    return (
      result ??
      failed(
        "Could not finish connecting Slack and its OAuth connector. Please try again.",
      )
    );
  },
);
