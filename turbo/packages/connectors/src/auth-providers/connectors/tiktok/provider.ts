import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildTikTokAuthorizationUrl,
  exchangeTikTokCode,
  refreshTikTokToken,
  revokeTikTokToken,
} from "./oauth";

export const tiktokProvider: AuthCodeConnectorAuthProvider<"tiktok", "oauth"> =
  {
    grant: {
      kind: "auth-code",
      buildAuthUrl: (args) => {
        return buildTikTokAuthorizationUrl(
          args.authCodeGrant,
          args.authClient.clientId,
          args.redirectUri,
          args.state,
        );
      },
      exchangeCode: (args) => {
        return exchangeTikTokCode({
          ...args.authClient,
          code: args.code,
          redirectUri: args.redirectUri,
        });
      },
    },
    access: {
      kind: "refresh-token",
      refresh: (args, signal) => {
        return refreshTikTokToken(
          { ...args.authClient, refreshToken: args.inputs.refreshToken },
          signal,
        );
      },
    },
    revoke: {
      kind: "token-revoke",
      revokeToken: (args, signal) => {
        return revokeTikTokToken(
          { ...args.authClient, accessToken: args.inputs.accessToken },
          signal,
        );
      },
    },
  };
