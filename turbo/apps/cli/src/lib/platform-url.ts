import { getApiUrl } from "./api/config";
import { getOkouAppUrl } from "./okou-env";

/**
 * Transform the API host to the platform (app) host.
 *
 *   api.okou.ai                   → app.okou.ai
 *   www.okou.ai                   → app.okou.ai
 *   platform.okou.ai              → app.okou.ai
 *   staging-api.vm6.ai            → staging-app.omby.ai
 *   pr-123-api.vm6.ai             → pr-123-app.omby.ai
 *   tunnel-user-host-www.vm7.ai   → tunnel-user-host-app.vm7.ai
 *   localhost:3000                → localhost:3000
 *   custom.example.com            → app.custom.example.com
 */
export function toPlatformUrl(apiUrl: string): URL {
  const parsed = new URL(apiUrl);
  const parts = parsed.hostname.split(".");
  const serviceLabel = parts[0]!;
  if (serviceLabel.endsWith("-www")) {
    parts[0] = serviceLabel.slice(0, -"-www".length) + "-app";
  } else if (serviceLabel.endsWith("-api")) {
    parts[0] = serviceLabel.slice(0, -"-api".length) + "-app";
  } else if (
    serviceLabel === "api" ||
    serviceLabel === "www" ||
    serviceLabel === "platform"
  ) {
    parts[0] = "app";
  } else if (
    serviceLabel !== "app" &&
    !serviceLabel.endsWith("-app") &&
    serviceLabel !== "localhost"
  ) {
    parts.unshift("app");
  }
  parsed.hostname = parts.join(".");
  if (
    parts.length === 3 &&
    parts[1] === "vm6" &&
    parts[2] === "ai" &&
    /^(?:staging|pr-[0-9]+)-api$/.test(serviceLabel)
  ) {
    parsed.hostname = `${parts[0]}.omby.ai`;
  }
  return parsed;
}

export async function getPlatformOrigin(): Promise<string> {
  const appUrl = getOkouAppUrl();
  if (appUrl) {
    return new URL(appUrl).origin;
  }

  const apiUrl = await getApiUrl();
  return toPlatformUrl(apiUrl).origin;
}
