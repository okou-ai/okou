import { createHash, randomBytes } from "node:crypto";
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

type NativeAuthorizationResult = AuthUrlResult & {
  readonly redirectUri?: string;
  readonly state?: string;
  readonly nativeAppAuthorization?: {
    readonly provider: "strava" | "tiktok" | "dropbox" | "spotify";
    readonly callbackUrl?: string;
    readonly exchangeUrl?: string;
  };
};

export function connectorNativeAppAuthorization(args: {
  readonly authorization: AuthUrlResult;
  readonly platform: "ios" | undefined;
  readonly callbackTarget: "app" | undefined;
  readonly connectorSlug: string;
  readonly authMethodId: string;
  readonly appAuthorizationEnabled?: boolean;
  readonly nativeAppClientId?: string;
}): NativeAuthorizationResult {
  if (
    args.platform !== "ios" ||
    args.callbackTarget !== "app" ||
    args.authMethodId !== "oauth"
  ) {
    return args.authorization;
  }
  if (args.connectorSlug === "strava") {
    return {
      ...args.authorization,
      url: stravaMobileAuthorizationUrl(args.authorization.url),
      oauthContext: STRAVA_IOS_AUTHORIZATION_CONTEXT,
      nativeAppAuthorization: { provider: "strava" },
    };
  }
  if (!args.appAuthorizationEnabled) {
    return args.authorization;
  }
  const provider = args.connectorSlug;
  if (
    provider !== "tiktok" &&
    provider !== "dropbox" &&
    provider !== "spotify"
  ) {
    return args.authorization;
  }
  return providerAuthorization(
    args.authorization,
    provider,
    args.nativeAppClientId,
  );
}

function providerAuthorization(
  authorization: AuthUrlResult,
  provider: "tiktok" | "dropbox" | "spotify",
  nativeAppClientId: string | undefined,
): NativeAuthorizationResult {
  const endpoints = {
    tiktok: "https://www.tiktok.com/v2/auth/authorize/",
    dropbox: "https://www.dropbox.com/oauth2/authorize",
    spotify: "https://accounts.spotify.com/authorize",
  };
  const url = new URL(authorization.url);
  if (url.origin + url.pathname !== endpoints[provider]) {
    throw new Error(`Unexpected ${provider} authorization endpoint`);
  }
  const exchangeUrl = url.searchParams.get("redirect_uri");
  if (!exchangeUrl) {
    throw new Error("Missing connector OAuth redirect");
  }
  const clientId = url.searchParams.get(
    provider === "tiktok" ? "client_key" : "client_id",
  );
  if (!clientId) {
    throw new Error("Missing connector OAuth client");
  }
  // iOS URL schemes are fixed at build time. A different environment's public
  // app key must retain its normal HTTPS authorization rather than lose its return.
  if (provider === "dropbox" && nativeAppClientId !== clientId) {
    return authorization;
  }
  const originalState = url.searchParams.get("state");
  if (provider === "tiktok" && !originalState?.startsWith("ios-https-v1:")) {
    return authorization;
  }
  // Claim only Login Kit attempts. Generic iOS web callbacks must continue to
  // reach the API, including those made by older installed clients.
  const state =
    provider === "tiktok"
      ? originalState?.replace("ios-https-v1:", "ios-https-v1:app-tiktok:")
      : undefined;
  if (state) {
    url.searchParams.set("state", state);
  }
  const redirectUri =
    provider === "dropbox"
      ? `db-${clientId}://2/token`
      : provider === "spotify"
        ? "ai.okou.ios://connector-provider/spotify"
        : exchangeUrl;
  url.searchParams.set("redirect_uri", redirectUri);
  let codeVerifier: string | undefined;
  if (provider !== "spotify") {
    codeVerifier = randomBytes(32).toString("base64url");
    // TikTok's OpenSDK uses a hexadecimal SHA-256 challenge, not RFC 7636's
    // base64url encoding. Dropbox uses the standard S256 representation.
    url.searchParams.set(
      "code_challenge",
      createHash("sha256")
        .update(codeVerifier)
        .digest(provider === "tiktok" ? "hex" : "base64url"),
    );
    url.searchParams.set("code_challenge_method", "S256");
  }
  return {
    ...authorization,
    url: url.toString(),
    codeVerifier,
    redirectUri,
    state,
    nativeAppAuthorization: {
      provider,
      callbackUrl: redirectUri,
      ...(provider === "spotify" ? { exchangeUrl } : {}),
    },
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
