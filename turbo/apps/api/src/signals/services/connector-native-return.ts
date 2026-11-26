import type { StoredBuiltinOAuthState } from "./connector-oauth-state.service";
import type { ConnectorOauthCallbackResult } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import {
  connectorNativeAppReturnUrl,
  connectorNativeHttpsReturnHostSchema,
  type ConnectorNativeAppReturn,
} from "@okouai/api-contracts/validators/connectors";
import { env } from "../../lib/env";

// Keep provider context and registered redirect URIs unchanged. The random state
// remains opaque to providers and can still be consumed by an older API.
const IOS_HTTPS_STATE_PREFIX = "ios-https-v1:";

export function connectorHttpsReturnState(args: {
  readonly state: string;
  readonly nativeCallback: "ios-https" | undefined;
}): string {
  return args.nativeCallback === "ios-https" &&
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
  state: Pick<StoredBuiltinOAuthState, "id" | "state">,
): ConnectorNativeAppReturn | undefined {
  const httpsHost = connectorHttpsReturnHost();
  return state.state.startsWith(IOS_HTTPS_STATE_PREFIX) && httpsHost
    ? { platform: "ios", attemptId: state.id, httpsHost }
    : undefined;
}

/** Browser callbacks keep their result visible if the OS cannot open the app. */
export function connectorCallbackResultUrl(
  connectorSlug: string,
  result: ConnectorOauthCallbackResult,
): string {
  const url = new URL(
    `/connectors/${encodeURIComponent(connectorSlug)}/callback/${result.status}`,
    env("APP_URL"),
  );
  if (result.status === "error") {
    url.searchParams.set("message", result.message);
  } else if (result.username) {
    url.searchParams.set("username", result.username);
  }
  if (result.nativeAppReturn) {
    url.searchParams.set(
      "nativeAppAttemptId",
      result.nativeAppReturn.attemptId,
    );
    if (result.nativeAppReturn.httpsHost) {
      url.searchParams.set(
        "nativeAppHttpsHost",
        result.nativeAppReturn.httpsHost,
      );
    }
  }
  return url.toString();
}
