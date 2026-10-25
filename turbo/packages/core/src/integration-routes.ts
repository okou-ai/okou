/** Public App destinations; each provider owns its query and authorization state. */
export const INTEGRATION_SETTINGS_PATHS = {
  slack: "/settings/slack",
  discord: "/settings/discord",
  teams: "/settings/teams",
  telegram: "/settings/telegram",
  wechat: "/settings/wechat",
} as const;

export const INTEGRATION_OAUTH_CALLBACK_PATHS = {
  slack: "/connectors/slack/callback",
  teams: "/connectors/microsoft-365/callback",
  github: "/connectors/github/callback",
} as const;

export type IntegrationOAuthProvider =
  keyof typeof INTEGRATION_OAUTH_CALLBACK_PATHS;

export function integrationOAuthCallbackProvider(
  pathname: string,
  searchParams: URLSearchParams,
): IntegrationOAuthProvider | null {
  const integration = searchParams.get("integration");
  if (
    integration !== "slack" &&
    integration !== "teams" &&
    integration !== "github"
  ) {
    return null;
  }
  return pathname.toLowerCase().replace(/\/$/u, "") ===
    INTEGRATION_OAUTH_CALLBACK_PATHS[integration]
    ? integration
    : null;
}
