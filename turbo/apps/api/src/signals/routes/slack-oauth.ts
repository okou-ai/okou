import { createHmac, timingSafeEqual } from "node:crypto";

import { command } from "ccstate";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { slackOauthContract } from "@okouai/api-contracts/contracts/slack-oauth";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { eq } from "drizzle-orm";

import { request$ } from "../context/hono";
import { queryOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { db$, writeDb$ } from "../external/db";
import { now, nowDate } from "../../lib/time";
import {
  exchangeSlackOAuthCode,
  exchangeSlackOAuthCodeForUser,
} from "../external/slack-oauth-client";
import { logger } from "../../lib/log";
import { env, optionalEnv } from "../../lib/env";
import { safeJsonParse, tapError } from "../utils";
import { encryptPersistentSecretValue } from "../services/crypto.utils";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import { getMemberRoleAndUpdateCache$ } from "../services/auth.service";
import {
  connectSlackWorkspace$,
  notifySlackConnect$,
  publishSlackAdminSignal$,
} from "../services/slack-connect.service";
import { SLACK_BOT_SCOPES } from "../services/slack-data.service";
import type { RouteEntry } from "../route-entry";
import { getOAuthApiOrigin } from "../../lib/oauth-origin";
import { OFFICIAL_SLACK_PUBLIC_BRAND } from "../../lib/slack-official-app";
import { PUBLIC_BRAND } from "@okouai/core/public-brand";
import {
  completeSlackConnectorOAuth$,
  startSlackConnectorOAuth$,
} from "../services/slack-connector-oauth.service";
import { SLACK_CONNECTOR_OAUTH_STATE_PREFIX } from "../services/slack-connector-oauth-state";

const L = logger("SlackOAuth");
const SLACK_OAUTH_URL = "https://slack.com/oauth/v2/authorize";
const SLACK_OAUTH_CALLBACK_PATH = "/api/integrations/slack/oauth/callback";
const SLACK_OAUTH_STATE_MAX_AGE_SECONDS = 15 * 60;
const REDIRECT_STATUS = 307;
const MAX_PROMPT_STATE_LENGTH = 500;

type SlackInstallation = typeof slackOrgInstallations.$inferSelect;

interface OAuthState {
  readonly orgId: string | null;
  readonly userId: string | null;
  readonly flow: "install" | "connect";
  readonly reinstall: boolean;
  readonly prompt: string | null;
  readonly publicBrand: PublicBrand;
}

interface SignedOAuthState extends OAuthState {
  readonly issuedAt: number;
  readonly redirectUri: string;
}

interface ParsedOAuthState {
  readonly redirectUri: string;
  readonly state: OAuthState;
}

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

function failedRedirect(message: string): Response {
  return redirectResponse(
    appUrl(`/slack/failed?error=${encodeURIComponent(message)}`),
  );
}

function settingsErrorRedirect(message: string): Response {
  return redirectResponse(
    appUrl(`/settings/slack?error=${encodeURIComponent(message)}`),
  );
}

function truncatePrompt(prompt: string): string {
  return [...prompt].slice(0, MAX_PROMPT_STATE_LENGTH).join("");
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optionalBoolean(value: unknown): boolean {
  return value === true;
}

function parseOAuthStateValue(parsed: unknown): OAuthState | null {
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const publicBrand = record.publicBrand;
  if (publicBrand !== "vm0" && publicBrand !== "okou") {
    return null;
  }
  return {
    orgId: optionalString(record.orgId),
    userId: optionalString(record.userId),
    flow: record.flow === "connect" ? "connect" : "install",
    reinstall: optionalBoolean(record.reinstall),
    prompt: optionalString(record.prompt),
    publicBrand,
  };
}

function signOAuthState(encodedPayload: string): string {
  return createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(`slack-oauth-state-v1:${encodedPayload}`)
    .digest("base64url");
}

function isSlackOAuthRedirectUri(value: string): boolean {
  if (!URL.canParse(value)) {
    return false;
  }
  const url = new URL(value);
  const isLocalHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (
    (url.protocol !== "https:" && !isLocalHttp) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== SLACK_OAUTH_CALLBACK_PATH ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return false;
  }
  return true;
}

function createOAuthState(state: OAuthState, redirectUri: string): string {
  const payload: SignedOAuthState = {
    ...state,
    issuedAt: Math.floor(now() / 1000),
    redirectUri,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url",
  );
  return `${encodedPayload}.${signOAuthState(encodedPayload)}`;
}

function parseSignedOAuthState(state: string): SignedOAuthState | null {
  const [encodedPayload, signature, extra] = state.split(".");
  if (!encodedPayload || !signature || extra) {
    return null;
  }
  const expected = Buffer.from(signOAuthState(encodedPayload), "utf8");
  const actual = Buffer.from(signature, "utf8");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return null;
  }

  const parsed = safeJsonParse(
    Buffer.from(encodedPayload, "base64url").toString(),
  );
  const oauthState = parseOAuthStateValue(parsed);
  if (!oauthState || typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const redirectUri = record.redirectUri;
  const issuedAt = record.issuedAt;
  if (
    typeof redirectUri !== "string" ||
    !isSlackOAuthRedirectUri(redirectUri) ||
    typeof issuedAt !== "number" ||
    !Number.isInteger(issuedAt)
  ) {
    return null;
  }
  const currentTimestamp = Math.floor(now() / 1000);
  if (
    issuedAt > currentTimestamp + 60 ||
    currentTimestamp - issuedAt > SLACK_OAUTH_STATE_MAX_AGE_SECONDS
  ) {
    return null;
  }
  return { ...oauthState, issuedAt, redirectUri };
}

function parseOAuthState(state: string | undefined): ParsedOAuthState | null {
  if (!state) {
    return null;
  }

  const signedState = parseSignedOAuthState(state);
  return signedState
    ? { state: signedState, redirectUri: signedState.redirectUri }
    : null;
}

function callbackRedirectUri(origin: string): string {
  return `${origin}${SLACK_OAUTH_CALLBACK_PATH}`;
}

function slackCredentials(): {
  readonly clientId: string;
  readonly clientSecret: string;
} | null {
  const clientId = env("SLACK_OAUTH_CLIENT_ID");
  const clientSecret = optionalEnv("SLACK_OAUTH_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return null;
  }
  return { clientId, clientSecret };
}

const installOauth$ = command(async ({ get, set }, signal: AbortSignal) => {
  const request = get(request$).raw;
  const origin = getOAuthApiOrigin(request);
  const clientId = env("SLACK_OAUTH_CLIENT_ID");
  if (!clientId) {
    return jsonErrorResponse("Slack integration is not configured", 503);
  }

  const query = get(queryOf(slackOauthContract.install));
  if (query.connectorState) {
    return await set(
      startSlackConnectorOAuth$,
      {
        flow: "install",
        connectorState: query.connectorState,
        redirectUri: callbackRedirectUri(origin),
      },
      signal,
    );
  }
  const publicBrand = PUBLIC_BRAND;
  const userId = query.userId;
  const redirectUri = callbackRedirectUri(origin);
  const state = createOAuthState(
    {
      orgId: query.orgId ?? null,
      userId: userId ?? null,
      flow: "install",
      reinstall: query.reinstall === "1",
      prompt: query.prompt ? truncatePrompt(query.prompt) : null,
      publicBrand,
    },
    redirectUri,
  );

  const authUrl = new URL(SLACK_OAUTH_URL);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);

  return noStoreRedirect(authUrl.toString());
});

const connectOauth$ = command(async ({ get, set }, signal: AbortSignal) => {
  const request = get(request$).raw;
  const origin = getOAuthApiOrigin(request);
  const clientId = env("SLACK_OAUTH_CLIENT_ID");
  if (!clientId) {
    return jsonErrorResponse("Slack integration is not configured", 503);
  }

  const query = get(queryOf(slackOauthContract.connect));
  if (query.connectorState) {
    return await set(
      startSlackConnectorOAuth$,
      {
        flow: "connect",
        connectorState: query.connectorState,
        redirectUri: callbackRedirectUri(origin),
      },
      signal,
    );
  }
  const publicBrand = PUBLIC_BRAND;
  const userId = query.userId;
  if (!query.orgId || !userId) {
    return jsonErrorResponse("Missing orgId or userId", 400);
  }

  const db = get(db$);
  const [installation] = await db
    .select({ slackWorkspaceId: slackOrgInstallations.slackWorkspaceId })
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.orgId, query.orgId))
    .limit(1);
  signal.throwIfAborted();

  if (!installation) {
    return jsonErrorResponse(
      "No Slack workspace installed for this organization",
      404,
    );
  }

  const redirectUri = callbackRedirectUri(origin);
  const state = createOAuthState(
    {
      orgId: query.orgId,
      userId,
      flow: "connect",
      reinstall: false,
      prompt: query.prompt ? truncatePrompt(query.prompt) : null,
      publicBrand,
    },
    redirectUri,
  );

  const authUrl = new URL(SLACK_OAUTH_URL);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("user_scope", "identity.basic");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("team", installation.slackWorkspaceId);

  return noStoreRedirect(authUrl.toString());
});

const notifyAfterConnect$ = command(
  (
    { set },
    args: {
      readonly installation: SlackInstallation;
      readonly slackUserId: string;
      readonly orgId: string;
      readonly userId: string;
      readonly pendingPrompt: string | null;
    },
    signal: AbortSignal,
  ): void => {
    waitUntil(
      tapError(
        Promise.resolve(
          set(
            notifySlackConnect$,
            {
              installation: args.installation,
              slackUserId: args.slackUserId,
              orgId: args.orgId,
              userId: args.userId,
              ...(args.pendingPrompt
                ? { pendingPrompt: args.pendingPrompt }
                : {}),
            },
            signal,
          ),
        ),
        (error) => {
          L.warn("Failed to notify connect success", { error });
        },
      ),
    );
  },
);

const handlePlatformInstall$ = command(
  async (
    { set },
    args: {
      readonly installation: SlackInstallation;
      readonly authedUserId: string;
      readonly teamName: string;
      readonly state: OAuthState;
      readonly isReinstall: boolean;
    },
    signal: AbortSignal,
  ): Promise<Response> => {
    if (!args.state.orgId || !args.state.userId) {
      return redirectResponse(
        appUrl(
          `/settings/slack?w=${encodeURIComponent(args.installation.slackWorkspaceId)}&u=${encodeURIComponent(args.authedUserId)}`,
        ),
      );
    }

    const member = await set(
      getMemberRoleAndUpdateCache$,
      args.state.orgId,
      args.state.userId,
      signal,
    );
    signal.throwIfAborted();

    if (member.kind !== "member") {
      throw new Error("You are not a member of this organization");
    }

    if (member.role !== "admin") {
      return failedRedirect(
        "Only org admins can install Slack for an organization.",
      );
    }

    const writeDb = set(writeDb$);
    await writeDb
      .insert(slackOrgConnections)
      .values({
        slackUserId: args.authedUserId,
        slackWorkspaceId: args.installation.slackWorkspaceId,
        userId: args.state.userId,
      })
      .onConflictDoNothing();
    signal.throwIfAborted();

    set(
      notifyAfterConnect$,
      {
        installation: args.installation,
        slackUserId: args.authedUserId,
        orgId: args.state.orgId,
        userId: args.state.userId,
        pendingPrompt: args.state.prompt,
      },
      signal,
    );

    if (args.isReinstall && args.state.reinstall) {
      return redirectResponse(appUrl("/?tab=works&updated=1"));
    }

    return redirectResponse(
      appUrl(
        `/settings/slack?status=connected&workspace=${encodeURIComponent(args.teamName)}`,
      ),
    );
  },
);

const handleInstallCallback$ = command(
  async (
    { set },
    args: {
      readonly code: string;
      readonly state: OAuthState;
      readonly credentials: {
        readonly clientId: string;
        readonly clientSecret: string;
      };
      readonly redirectUri: string;
    },
    signal: AbortSignal,
  ): Promise<Response> => {
    const oauthResult = await tapError(
      exchangeSlackOAuthCode(
        args.credentials.clientId,
        args.credentials.clientSecret,
        args.code,
        args.redirectUri,
      ),
      (error) => {
        L.error("Slack OAuth exchange failed", { error });
      },
    );
    signal.throwIfAborted();

    if (!oauthResult) {
      return failedRedirect(
        "Failed to complete Slack installation. Please try again.",
      );
    }

    const writeDb = set(writeDb$);
    const featureSwitchContext =
      args.state.orgId && args.state.userId
        ? await loadUserFeatureSwitchContext(
            writeDb,
            args.state.orgId,
            args.state.userId,
          )
        : {};
    const encryptedBotToken = await encryptPersistentSecretValue(
      oauthResult.accessToken,
      featureSwitchContext,
    );
    signal.throwIfAborted();
    const botScopes = oauthResult.scope
      ? JSON.stringify(oauthResult.scope.split(",").filter(Boolean))
      : null;

    const [existing] = await writeDb
      .select()
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.slackWorkspaceId, oauthResult.teamId))
      .limit(1);
    signal.throwIfAborted();

    const isReinstall = existing !== undefined;
    if (existing) {
      if (
        existing.orgId &&
        args.state.orgId &&
        existing.orgId !== args.state.orgId
      ) {
        L.warn("Install rejected: workspace already bound to another org", {
          workspaceId: oauthResult.teamId,
          existingOrgId: existing.orgId,
          requestedOrgId: args.state.orgId,
        });
        return settingsErrorRedirect(
          "This Slack workspace is already installed by another organization. Please contact the workspace admin to uninstall first.",
        );
      }

      await writeDb
        .update(slackOrgInstallations)
        .set({
          encryptedBotToken,
          botUserId: oauthResult.botUserId,
          slackWorkspaceName: oauthResult.teamName,
          botScopes,
          publicBrand: OFFICIAL_SLACK_PUBLIC_BRAND,
          updatedAt: nowDate(),
        })
        .where(eq(slackOrgInstallations.slackWorkspaceId, oauthResult.teamId));
      signal.throwIfAborted();
    } else {
      const isPlatformFlow = Boolean(args.state.orgId && args.state.userId);
      await writeDb.insert(slackOrgInstallations).values({
        slackWorkspaceId: oauthResult.teamId,
        slackWorkspaceName: oauthResult.teamName,
        orgId: isPlatformFlow ? args.state.orgId : null,
        encryptedBotToken,
        botUserId: oauthResult.botUserId,
        installedByUserId: isPlatformFlow ? args.state.userId : null,
        botScopes,
        publicBrand: OFFICIAL_SLACK_PUBLIC_BRAND,
      });
      signal.throwIfAborted();
    }

    const [installation] = await writeDb
      .select()
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.slackWorkspaceId, oauthResult.teamId))
      .limit(1);
    signal.throwIfAborted();

    if (!installation) {
      throw new Error("Slack installation upsert did not return a row");
    }

    if (args.state.orgId && args.state.userId) {
      return await set(
        handlePlatformInstall$,
        {
          installation,
          authedUserId: oauthResult.authedUserId,
          teamName: oauthResult.teamName,
          state: args.state,
          isReinstall,
        },
        signal,
      );
    }

    return redirectResponse(
      appUrl(
        `/settings/slack?w=${encodeURIComponent(oauthResult.teamId)}&u=${encodeURIComponent(oauthResult.authedUserId)}`,
      ),
    );
  },
);

const handleConnectCallback$ = command(
  async (
    { set },
    args: {
      readonly code: string;
      readonly state: OAuthState;
      readonly credentials: {
        readonly clientId: string;
        readonly clientSecret: string;
      };
      readonly redirectUri: string;
    },
    signal: AbortSignal,
  ): Promise<Response> => {
    if (!args.state.orgId || !args.state.userId) {
      return settingsErrorRedirect("Invalid connect state.");
    }

    const oauthResult = await tapError(
      exchangeSlackOAuthCodeForUser(
        args.credentials.clientId,
        args.credentials.clientSecret,
        args.code,
        args.redirectUri,
      ),
      (error) => {
        L.error("Slack OAuth exchange failed (connect flow)", { error });
      },
    );
    signal.throwIfAborted();

    if (!oauthResult) {
      return settingsErrorRedirect(
        "Failed to connect Slack account. Please try again.",
      );
    }

    const writeDb = set(writeDb$);
    const [installation] = await writeDb
      .select()
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.orgId, args.state.orgId))
      .limit(1);
    signal.throwIfAborted();

    if (!installation) {
      return settingsErrorRedirect(
        "No Slack workspace installed for this organization.",
      );
    }

    if (oauthResult.teamId !== installation.slackWorkspaceId) {
      return settingsErrorRedirect(
        "You authenticated with a different Slack workspace. Please use the workspace connected to your organization.",
      );
    }

    const member = await set(
      getMemberRoleAndUpdateCache$,
      args.state.orgId,
      args.state.userId,
      signal,
    );
    signal.throwIfAborted();

    if (member.kind !== "member") {
      throw new Error("You are not a member of this organization");
    }

    const connectionResult = await set(
      connectSlackWorkspace$,
      {
        userId: args.state.userId,
        orgId: args.state.orgId,
        orgRole: member.role,
        workspaceId: installation.slackWorkspaceId,
        slackUserId: oauthResult.authedUserId,
      },
      signal,
    );
    signal.throwIfAborted();

    if (connectionResult.kind !== "ok") {
      return settingsErrorRedirect(connectionResult.message);
    }

    await set(
      publishSlackAdminSignal$,
      { orgId: args.state.orgId, topic: "slack:changed" },
      signal,
    );
    signal.throwIfAborted();

    set(
      notifyAfterConnect$,
      {
        installation: connectionResult.installation,
        slackUserId: oauthResult.authedUserId,
        orgId: args.state.orgId,
        userId: args.state.userId,
        pendingPrompt: args.state.prompt,
      },
      signal,
    );

    return redirectResponse(
      appUrl(
        `/settings/slack?status=connected&workspace=${encodeURIComponent(installation.slackWorkspaceName ?? "")}`,
      ),
    );
  },
);

const callbackOauth$ = command(async ({ get, set }, signal: AbortSignal) => {
  const query = get(queryOf(slackOauthContract.callback));
  if (query.state?.startsWith(SLACK_CONNECTOR_OAUTH_STATE_PREFIX)) {
    return await set(
      completeSlackConnectorOAuth$,
      {
        state: query.state,
        code: query.code,
        error: query.error,
      },
      signal,
    );
  }
  const credentials = slackCredentials();
  if (!credentials) {
    return jsonErrorResponse("Slack integration is not configured", 503);
  }

  const parsedState = parseOAuthState(query.state);

  if (query.error) {
    return failedRedirect(query.error);
  }

  if (!query.code) {
    return jsonErrorResponse("Missing authorization code", 400);
  }

  if (!parsedState) {
    return failedRedirect("Invalid OAuth state.");
  }
  const { state, redirectUri } = parsedState;
  if (state.flow === "connect") {
    return await set(
      handleConnectCallback$,
      {
        code: query.code,
        state,
        credentials,
        redirectUri,
      },
      signal,
    );
  }

  return await set(
    handleInstallCallback$,
    {
      code: query.code,
      state,
      credentials,
      redirectUri,
    },
    signal,
  );
});

export const slackOauthRoutes: readonly RouteEntry[] = [
  {
    route: slackOauthContract.install,
    handler: installOauth$,
  },
  {
    route: slackOauthContract.connect,
    handler: connectOauth$,
  },
  {
    route: slackOauthContract.callback,
    handler: callbackOauth$,
  },
];
