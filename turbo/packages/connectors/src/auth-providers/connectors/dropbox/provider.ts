import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildDropboxAuthorizationUrl,
  exchangeDropboxCode,
  refreshDropboxToken,
} from "./oauth";
import { oauthRefreshResultToProviderResult } from "../../oauth/types";
export const dropboxProvider: AuthCodeConnectorAuthProvider<"dropbox"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args.authClient;
      return buildDropboxAuthorizationUrl(
        args.authCodeGrant,
        clientId,
        args.redirectUri,
        args.state,
      );
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args.authClient;
      const code = args.code;
      const redirectUri = args.redirectUri;
      const result = await exchangeDropboxCode(
        args.authCodeGrant,
        clientId,
        clientSecret,
        code,
        redirectUri,
        args.codeVerifier,
      );
      return {
        outputs: {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
        },
        expiresIn: result.expiresIn,
        scopes: result.scopes,
        userInfo: {
          id: result.userInfo.id,
          username: result.userInfo.username,
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
        await refreshDropboxToken(
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
