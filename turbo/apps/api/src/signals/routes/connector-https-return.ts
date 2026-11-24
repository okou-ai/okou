import type { StoredBuiltinOAuthState } from "../services/connector-oauth-state.service";
import {
  connectorNativeAppReturnUrl,
  connectorNativeHttpsReturnHostSchema,
  type ConnectorNativeAppReturn,
} from "@okouai/api-contracts/validators/connectors";
import { env } from "../../lib/env";

// Keep provider context and registered redirect URIs unchanged. The random state
// remains opaque to providers and can still be consumed by an older API.
const IOS_HTTPS_STATE_PREFIX = "ios-https-v1:";
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
    connectorHttpsReturnHost() !== undefined
    ? `${IOS_HTTPS_STATE_PREFIX}${args.state}`
    : args.state;
}

function connectorHttpsReturnHost(): ConnectorNativeAppReturn["httpsHost"] {
  const url = new URL(env("APP_URL"));
  const host = connectorNativeHttpsReturnHostSchema.safeParse(url.hostname);
  return url.protocol === "https:" && url.port === "" && host.success
    ? host.data
    : undefined;
}

export function connectorHttpsCallbackUrl(
  state: string,
  attemptId: string,
): string | undefined {
  const httpsHost = connectorHttpsReturnHost();
  return state.startsWith(IOS_HTTPS_STATE_PREFIX) && httpsHost
    ? connectorNativeAppReturnUrl({
        platform: "ios",
        attemptId,
        httpsHost,
      })
    : undefined;
}

/** Only a claimed, unexpired state may opt a callback into a native return. */
export function connectorHttpsReturn(
  state: StoredBuiltinOAuthState,
): ConnectorNativeAppReturn | undefined {
  const httpsHost = connectorHttpsReturnHost();
  return IOS_HTTPS_CONNECTORS.includes(state.connectorSlug) &&
    state.state.startsWith(IOS_HTTPS_STATE_PREFIX) &&
    httpsHost
    ? { platform: "ios", attemptId: state.id, httpsHost }
    : undefined;
}
