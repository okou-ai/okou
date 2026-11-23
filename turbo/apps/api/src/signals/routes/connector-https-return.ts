import type { StoredBuiltinOAuthState } from "../services/connector-oauth-state.service";
import { env } from "../../lib/env";

// Keep provider context and registered redirect URIs unchanged. The random state
// remains opaque to providers and can still be consumed by an older API.
const IOS_HTTPS_STATE_PREFIX = "ios-https-v1:";
const HTTPS_RETURN_HEADER = "X-Okou-Connector-Https-Return";
// These hosts have a signed iOS Associated Domains entitlement. Arbitrary PR
// origins keep the existing receipt-based flow until tested on shared staging.
const IOS_ASSOCIATED_HOSTS = Object.freeze([
  "app.okou.ai",
  "staging-app-okou-app-preview.vm0.workers.dev",
]);
const IOS_HTTPS_CONNECTORS = Object.freeze([
  "gmail",
  "google-docs",
  "google-drive",
  "google-sheets",
  "google-calendar",
  "google-ads",
  "github",
  "notion",
]);

export function connectorHttpsReturnState(args: {
  readonly state: string;
  readonly connectorSlug: string;
  readonly nativeCallback: "ios-https" | undefined;
}): string {
  return args.nativeCallback === "ios-https" &&
    IOS_HTTPS_CONNECTORS.includes(args.connectorSlug) &&
    connectorHttpsReturnOrigin() !== undefined
    ? `${IOS_HTTPS_STATE_PREFIX}${args.state}`
    : args.state;
}

function connectorHttpsReturnOrigin(): string | undefined {
  const url = new URL(env("APP_URL"));
  return url.protocol === "https:" &&
    url.port === "" &&
    IOS_ASSOCIATED_HOSTS.includes(url.hostname)
    ? url.origin
    : undefined;
}

function connectorHttpsReturnUrl(attemptId: string): string | undefined {
  const origin = connectorHttpsReturnOrigin();
  if (!origin) {
    return undefined;
  }
  const url = new URL("/native/connector-authorization", origin);
  url.searchParams.set("attemptId", attemptId);
  return url.toString();
}

export function connectorHttpsReturnFromResponse(
  response: Response,
): string | undefined {
  const attemptId = response.headers.get(HTTPS_RETURN_HEADER);
  return attemptId ? connectorHttpsReturnUrl(attemptId) : undefined;
}

export function connectorHttpsCallbackUrl(args: {
  readonly state: string;
  readonly attemptId: string;
}): string | undefined {
  return args.state.startsWith(IOS_HTTPS_STATE_PREFIX)
    ? connectorHttpsReturnUrl(args.attemptId)
    : undefined;
}

/** Only a claimed, unexpired state may opt a callback into a native return. */
export function connectorHttpsReturnResponse(
  response: Response,
  state: StoredBuiltinOAuthState,
): Response {
  if (
    !IOS_HTTPS_CONNECTORS.includes(state.connectorSlug) ||
    !state.state.startsWith(IOS_HTTPS_STATE_PREFIX)
  ) {
    return response;
  }
  response.headers.set(HTTPS_RETURN_HEADER, state.id);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
