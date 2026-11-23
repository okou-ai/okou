import type { StoredBuiltinOAuthState } from "../services/connector-oauth-state.service";
import type { AuthUrlResult } from "@okouai/connectors/auth-providers/provider-flow-types";

// Strava's public mobile OAuth protocol retains the registered HTTPS callback,
// confidential client, state, scopes and server-owned rotating refresh token.
const STRAVA_IOS_AUTHORIZATION_CONTEXT = JSON.stringify({
  iosConnectorAppAuthorization: "strava-v1",
});
const NATIVE_ATTEMPT_HEADER = "X-Okou-Native-Connector-Attempt";

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
  state: StoredBuiltinOAuthState,
): Response {
  if (isStravaIosAuthorization(state)) {
    response.headers.set(NATIVE_ATTEMPT_HEADER, state.id);
  }
  return response;
}

export function nativeConnectorReturn(response: Response):
  | {
      readonly platform: "ios";
      readonly attemptId: string;
    }
  | undefined {
  const attemptId = response.headers.get(NATIVE_ATTEMPT_HEADER);
  return attemptId ? { platform: "ios", attemptId } : undefined;
}
