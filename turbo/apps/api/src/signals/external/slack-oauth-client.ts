import { WebClient } from "@slack/web-api";

interface SlackInstallOAuthResult {
  readonly accessToken: string;
  readonly botUserId: string;
  readonly teamId: string;
  readonly teamName: string;
  readonly authedUserId: string;
  readonly scope: string;
}

interface SlackUserOAuthResult {
  readonly teamId: string;
  readonly authedUserId: string;
}

function buildWebClient(): WebClient {
  return new WebClient();
}

export async function exchangeSlackOAuthCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<SlackInstallOAuthResult> {
  const client = buildWebClient();
  const result = await client.oauth.v2.access({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });

  if (
    !result.ok ||
    !result.access_token ||
    !result.bot_user_id ||
    !result.team
  ) {
    throw new Error(
      `OAuth exchange failed: ${result.error ?? "unknown error"}`,
    );
  }
  if (!result.team.id) {
    throw new Error(
      "OAuth exchange failed: Slack response omitted workspace ID",
    );
  }
  if (!result.authed_user?.id) {
    throw new Error(
      "OAuth exchange failed: Slack response omitted authenticated user ID",
    );
  }

  return {
    accessToken: result.access_token,
    botUserId: result.bot_user_id,
    teamId: result.team.id,
    teamName: result.team.name ?? "",
    authedUserId: result.authed_user.id,
    scope: typeof result.scope === "string" ? result.scope : "",
  };
}

export async function exchangeSlackOAuthCodeForUser(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<SlackUserOAuthResult> {
  const client = buildWebClient();
  const result = await client.oauth.v2.access({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });

  if (!result.ok || !result.authed_user?.id || !result.team?.id) {
    throw new Error(
      `OAuth user exchange failed: ${result.error ?? "unknown error"}`,
    );
  }

  return {
    teamId: result.team.id,
    authedUserId: result.authed_user.id,
  };
}

/** One code exchange supplies both installation and connector credentials. */
export async function exchangeSlackOAuthCodeForConnector(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
) {
  const result = await buildWebClient().oauth.v2.access({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });
  if (
    !result.ok ||
    !result.team?.id ||
    !result.authed_user?.id ||
    !result.authed_user.access_token ||
    !result.authed_user.scope
  ) {
    throw new Error(
      "Slack OAuth did not return the requested user credentials",
    );
  }
  return {
    teamId: result.team.id,
    teamName: result.team.name ?? "",
    userId: result.authed_user.id,
    userToken: result.authed_user.access_token,
    userScopes: result.authed_user.scope.split(",").filter(Boolean),
    botToken: result.access_token,
    botUserId: result.bot_user_id,
    botScopes: result.scope,
  };
}

export async function fetchSlackConnectorUserInfo(
  accessToken: string,
  userId: string,
) {
  const result = await new WebClient(accessToken).users.info({ user: userId });
  if (!result.ok || result.user?.id !== userId) {
    throw new Error("Slack did not return the authorized user profile");
  }
  return {
    id: userId,
    username: result.user.real_name ?? result.user.name ?? null,
    email: result.user.profile?.email ?? null,
  };
}
