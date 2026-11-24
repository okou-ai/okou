import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildGoogleAuthorizationUrl,
  exchangeGoogleOAuthCode,
  refreshGoogleToken,
} from "../../oauth/google";
import { oauthRefreshResultToProviderResult } from "../../oauth/types";

const ANDROID_PUBLISHER_SCOPE = "https://www.googleapis.com/auth/androidpublisher";

export const googlePlayProvider: AuthCodeConnectorAuthProvider<"google-play"> =
  {
    grant: {
      kind: "auth-code",
      buildAuthUrl: (args) => {
        const { clientId } = args.authClient;
        return buildGoogleAuthorizationUrl(
          args.authCodeGrant,
          "google-play",
          clientId,
          args.redirectUri,
          args.state,
        );
      },
      exchangeCode: async (args) => {
        const { clientId, clientSecret } = args.authClient;
        const result = await exchangeGoogleOAuthCode(
          args.authCodeGrant,
          "google-play",
          clientId,
          clientSecret,
          args.code,
          args.redirectUri,
        );
        if (!result.scopes.includes(ANDROID_PUBLISHER_SCOPE)) {
          throw new Error(
            "Grant Google Play Developer API access to connect this account.",
          );
        }
        return {
          outputs: {
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
          },
          expiresIn: result.expiresIn,
          scopes: result.scopes,
          userInfo: {
            id: result.userInfo.id,
            username: result.userInfo.name,
            email: result.userInfo.email,
          },
        };
      },
    },
    access: {
      kind: "refresh-token",
      refresh: async (args, signal: AbortSignal) => {
        const { clientId, clientSecret } = args.authClient;
        return oauthRefreshResultToProviderResult(
          await refreshGoogleToken(
            "google-play",
            clientId,
            clientSecret,
            args.inputs.refreshToken,
            signal,
          ),
        );
      },
    },
    revoke: { kind: "none" },
  };
