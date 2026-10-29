import { ROUTES } from "./route-paths.ts";
import { integrationOAuthCallbackProvider } from "@okouai/core/integration-routes";

// Match the Router's case-insensitive paths and optional trailing slash.
function integrationPath(pathname: string): string {
  return pathname.toLowerCase().replace(/\/$/u, "");
}

// Old API callbacks and saved links still use Works (#40196). Retire only
// after no serving/retained API emits them and the public URL contract,
// including supported in-flight/browser/saved links, is explicitly retired.
export function isLegacyDiscordCallback(
  pathname: string,
  searchParams: URLSearchParams,
): boolean {
  const marker = searchParams.get("discord");
  return (
    integrationPath(pathname) === ROUTES.works &&
    (marker === "pending" || marker === "error" || marker === "connected")
  );
}

/** Public continuation only; bootstrap has already consumed Discord's proof. */
export function isIntegrationAuthContinuation(url: URL): boolean {
  return (
    integrationOAuthCallbackProvider(url.pathname, url.searchParams) !== null ||
    [
      ROUTES.settingsAgentPhone,
      ROUTES.settingsSlack,
      ROUTES.settingsDiscord,
      ROUTES.settingsDiscordInstall,
      ROUTES.settingsTeams,
      ROUTES.settingsTelegram,
      ROUTES.telegramConnect,
    ].some((path) => {
      return integrationPath(url.pathname) === path;
    }) ||
    isLegacyDiscordCallback(url.pathname, url.searchParams)
  );
}
