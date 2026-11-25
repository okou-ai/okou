import {
  connectorNativeAppReturnSchema,
  type ConnectorNativeAppReturn,
} from "@okouai/api-contracts/validators/connectors";
import { connectorHttpsReturn } from "../services/connector-native-return";
import type {
  StoredBuiltinOAuthState,
  StoredCustomConnectorOAuthState,
} from "../services/connector-oauth-state.service";
import type { AuthUrlResult } from "@okouai/connectors/auth-providers/provider-flow-types";

// Strava's public mobile OAuth protocol retains the registered HTTPS callback,
// confidential client, state, scopes and server-owned rotating refresh token.
const STRAVA_IOS_AUTHORIZATION_CONTEXT = JSON.stringify({
  iosConnectorAppAuthorization: "strava-v1",
});
const NATIVE_ATTEMPT_HEADER = "X-Okou-Native-Connector-Attempt";
const NATIVE_HTTPS_HOST_HEADER = "X-Okou-Native-Connector-Https-Host";

export function connectorNativeAppAuthorization(args: {
  readonly authorization: AuthUrlResult;
  readonly platform: "ios" | undefined;
  readonly callbackTarget: "app" | undefined;
  readonly connectorSlug: string;
  readonly authMethodId: string;
}): AuthUrlResult & {
  readonly nativeAppAuthorization?: { readonly provider: "strava" };
} {
  if (
    args.platform !== "ios" ||
    args.callbackTarget !== "app" ||
    args.connectorSlug !== "strava" ||
    args.authMethodId !== "oauth"
  ) {
    return args.authorization;
  }
  return {
    ...args.authorization,
    url: stravaMobileAuthorizationUrl(args.authorization.url),
    oauthContext: STRAVA_IOS_AUTHORIZATION_CONTEXT,
    nativeAppAuthorization: { provider: "strava" },
  };
}

function stravaMobileAuthorizationUrl(authorizationUrl: string): string {
  const url = new URL(authorizationUrl);
  if (
    url.origin !== "https://www.strava.com" ||
    url.pathname !== "/oauth/authorize"
  ) {
    throw new Error("Unexpected Strava authorization endpoint");
  }
  url.pathname = "/oauth/mobile/authorize";
  return url.toString();
}

export function isStravaIosAuthorization(
  state: StoredBuiltinOAuthState,
): boolean {
  return (
    state.connectorSlug === "strava" &&
    state.authMethod === "oauth" &&
    state.oauthContext === STRAVA_IOS_AUTHORIZATION_CONTEXT
  );
}

export function nativeConnectorCallbackResponse(
  response: Response,
  state: StoredBuiltinOAuthState | StoredCustomConnectorOAuthState,
): Response {
  const httpsReturn = connectorHttpsReturn(state);
  if (
    httpsReturn ||
    (state.connectorSlug !== null && isStravaIosAuthorization(state))
  ) {
    response.headers.set(NATIVE_ATTEMPT_HEADER, state.id);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
  }
  if (httpsReturn?.httpsHost) {
    response.headers.set(NATIVE_HTTPS_HOST_HEADER, httpsReturn.httpsHost);
  }
  return response;
}

export function nativeConnectorReturn(
  response: Response,
): ConnectorNativeAppReturn | undefined {
  const attemptId = response.headers.get(NATIVE_ATTEMPT_HEADER);
  return attemptId
    ? connectorNativeAppReturnSchema.parse({
        platform: "ios",
        attemptId,
        httpsHost: response.headers.get(NATIVE_HTTPS_HOST_HEADER) ?? undefined,
      })
    : undefined;
}
