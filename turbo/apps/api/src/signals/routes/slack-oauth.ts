import { INTEGRATION_SETTINGS_PATHS } from "@okouai/core/integration-routes";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { command } from "ccstate";
import { slackOauthContract } from "@okouai/api-contracts/contracts/slack-oauth";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { eq } from "drizzle-orm";

import { request$ } from "../context/hono";
import { queryOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { now } from "../../lib/time";
import { exchangeSlackOAuthCode } from "../external/slack-oauth-client";
import { logger } from "../../lib/log";
import { env, optionalEnv } from "../../lib/env";
import { safeJsonParse, tapError } from "../utils";
import { encryptPersistentSecretValue } from "../services/crypto.utils";
import { persistSlackInstallation$ } from "../services/slack-installation-write.service";
import { SLACK_BOT_SCOPES } from "../services/slack-data.service";
import type { RouteEntry } from "../route-entry";
import { getOAuthApiOrigin } from "../../lib/oauth-origin";
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

interface AnonymousOAuthState {
  readonly issuedAt: number;
  readonly redirectUri: string;
}

function redirectResponse(url: string): Response {
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
    appUrl(
      `${INTEGRATION_SETTINGS_PATHS.slack}?error=${encodeURIComponent(message)}`,
    ),
  );
}

function signOAuthState(encodedPayload: string): string {
  return createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(`slack-oauth-state-v2:${encodedPayload}`)
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

function createAnonymousOAuthState(redirectUri: string): string {
  const encodedPayload = Buffer.from(
    JSON.stringify({
      flow: "install",
      orgId: null,
      userId: null,
      issuedAt: Math.floor(now() / 1000),
      redirectUri,
      nonce: randomBytes(32).toString("hex"),
    }),
  ).toString("base64url");
  return `${encodedPayload}.${signOAuthState(encodedPayload)}`;
}

function parseAnonymousOAuthState(state: string): AnonymousOAuthState | null {
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
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const redirectUri = record.redirectUri;
  const issuedAt = record.issuedAt;
  // Only anonymous bot installs use this state format. A previously issued
  // named authorization must restart through the authenticated connector flow.
  if (
    record.flow !== "install" ||
    record.orgId !== null ||
    record.userId !== null ||
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
  return { issuedAt, redirectUri };
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
  // Old named links must not silently become anonymous bot installations.
  const params = new URL(request.url).searchParams;
  if (params.has("orgId") || params.has("userId")) {
    return redirectResponse(appUrl(INTEGRATION_SETTINGS_PATHS.slack));
  }
  const redirectUri = callbackRedirectUri(origin);
  const state = createAnonymousOAuthState(redirectUri);
  const authUrl = new URL(SLACK_OAUTH_URL);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);

  return redirectResponse(authUrl.toString());
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
  return redirectResponse(appUrl(INTEGRATION_SETTINGS_PATHS.slack));
});

const handleAnonymousInstallCallback$ = command(
  async (
    { set },
    args: {
      readonly code: string;
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
    const encryptedBotToken = await encryptPersistentSecretValue(
      oauthResult.accessToken,
      {},
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

    await set(
      persistSlackInstallation$,
      {
        fields: {
          encryptedBotToken,
          botUserId: oauthResult.botUserId,
          slackWorkspaceName: oauthResult.teamName,
          botScopes,
        },
        workspaceId: oauthResult.teamId,
        orgId: null,
        userId: null,
        mode: existing ? "reinstall" : "install",
      },
      signal,
    );
    signal.throwIfAborted();

    return redirectResponse(
      appUrl(
        `${INTEGRATION_SETTINGS_PATHS.slack}?w=${encodeURIComponent(oauthResult.teamId)}&u=${encodeURIComponent(oauthResult.authedUserId)}`,
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
  if (query.error) {
    return failedRedirect(query.error);
  }
  if (!query.code) {
    return jsonErrorResponse("Missing authorization code", 400);
  }
  const state = query.state ? parseAnonymousOAuthState(query.state) : null;
  if (!state) {
    return failedRedirect(
      "Invalid OAuth state. Please reconnect Slack from settings.",
    );
  }
  return await set(
    handleAnonymousInstallCallback$,
    {
      code: query.code,
      credentials,
      redirectUri: state.redirectUri,
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
