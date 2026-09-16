import { randomBytes } from "node:crypto";

import { command } from "ccstate";
import { and, eq, isNull, or } from "drizzle-orm";
import {
  isStaticConfidentialConnectorAuthClient,
  resolveConnectorAuthClient,
} from "@okouai/connectors/connector-auth-method";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { awardCompletedGetStartedQuest } from "./get-started-rewards.service";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";

import { env, optionalEnv } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { logger } from "../../lib/log";
import { OFFICIAL_SLACK_PUBLIC_BRAND } from "../../lib/slack-official-app";
import { writeDb$ } from "../external/db";
import {
  exchangeSlackOAuthCodeForConnector,
  fetchSlackConnectorUserInfo,
} from "../external/slack-oauth-client";
import { waitUntil } from "../context/wait-until";
import { safeJsonParse, tapError } from "../utils";
import { connectorActionResolver } from "./connector-action-resolver.service";
import {
  connectorConnectionWriteFailureMessage,
  upsertConnectorTokenConnection$,
} from "./connector-data.service";
import {
  claimConnectorOAuthState,
  insertConnectorOAuthState,
} from "./connector-oauth-state.service";
import { getMemberRoleAndUpdateCache$ } from "./auth.service";
import { userFeatureSwitchContext } from "./feature-switches.service";
import { encryptPersistentSecretValue } from "./crypto.utils";
import { SLACK_BOT_SCOPES } from "./slack-data.service";
import {
  connectSlackWorkspace$,
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

const L = logger("SlackConnectorOAuth");

function redirect(url: string): Response {
  return new Response(null, {
    status: 307,
    headers: { location: url, "Cache-Control": "no-store" },
  });
}

function failed(message: string): Response {
  const url = new URL("/settings/slack", env("APP_URL"));
  url.searchParams.set("error", message);
  return redirect(url.toString());
}

const resolveSlackOAuthMethod$ = command(
  async ({ get }, starting: boolean, signal: AbortSignal) => {
    const resolver = await get(connectorActionResolver());
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
    const context = verifySlackConnectorOAuthStart(args.connectorState);
    if (!context || context.flow !== args.flow) {
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
    await insertConnectorOAuthState(set(writeDb$), {
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
    });
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
    const values = {
      slackWorkspaceName: oauth.teamName,
      orgId: context.orgId,
      encryptedBotToken,
      botUserId: oauth.botUserId,
      installedByUserId: context.userId,
      botScopes: JSON.stringify(oauth.botScopes.split(",").filter(Boolean)),
      publicBrand: OFFICIAL_SLACK_PUBLIC_BRAND,
    } as const;
    const installation = await set(writeDb$).transaction(async (tx) => {
      const [stored] = await tx
        .insert(slackOrgInstallations)
        .values({ slackWorkspaceId: oauth.teamId, ...values })
        .onConflictDoUpdate({
          target: slackOrgInstallations.slackWorkspaceId,
          set: { ...values, updatedAt: nowDate() },
          setWhere: or(
            eq(slackOrgInstallations.orgId, context.orgId),
            isNull(slackOrgInstallations.orgId),
          ),
        })
        .returning({ id: slackOrgInstallations.slackWorkspaceId });
      if (stored) {
        await awardCompletedGetStartedQuest(tx, {
          orgId: context.orgId,
          userId: context.userId,
          questKey: "slack",
          sourceKey: stored.id,
        });
      }
      return stored;
    });
    signal.throwIfAborted();
    if (!installation) {
      throw new Error(
        "This Slack workspace is already connected to another organization",
      );
    }
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
    const db = set(writeDb$);
    const claimed = await claimConnectorOAuthState(
      db,
      {
        state: args.state,
        target: { kind: "builtin", connectorSlug: "slack" },
      },
      signal,
    );
    if (claimed.kind !== "usable") {
      return failed(
        "This Slack authorization has expired or was already used. Please start again.",
      );
    }
    if (args.error || !args.code) {
      return failed("Slack authorization was not completed. Please try again.");
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
    if (context.workspaceId && context.workspaceId !== oauth.teamId) {
      return failed("Use the Slack workspace that opened this connection.");
    }
    if (context.slackUserId && context.slackUserId !== oauth.userId) {
      return failed("Use the Slack account that opened this connection.");
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
    const db = set(writeDb$);
    const [installation] = await db
      .select({ orgId: slackOrgInstallations.orgId })
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.slackWorkspaceId, args.workspaceId))
      .limit(1);
    signal.throwIfAborted();
    if (
      (installation?.orgId && installation.orgId !== context.orgId) ||
      (context.flow === "connect" &&
        (!installation ||
          (installation.orgId === null && args.role !== "admin")))
    ) {
      return failed(
        "This Slack workspace is unavailable for your organization.",
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
      return failed("This Slack account is already connected to another user.");
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
      upsertConnectorTokenConnection$,
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
      return failed(connectorConnectionWriteFailureMessage(connector.status));
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
      },
      signal,
    );
    if (connection.kind !== "ok") {
      return failed(connection.message);
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
          },
          signal,
        ),
        (error) => {
          return L.warn("Failed to notify Slack connection", { error });
        },
      ),
    );
    if (context.reinstall) {
      return redirect(
        new URL("/?tab=works&updated=1", env("APP_URL")).toString(),
      );
    }
    const url = new URL("/settings/slack", env("APP_URL"));
    url.searchParams.set("status", "connected");
    url.searchParams.set("workspace", oauth.teamName);
    return redirect(url.toString());
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
