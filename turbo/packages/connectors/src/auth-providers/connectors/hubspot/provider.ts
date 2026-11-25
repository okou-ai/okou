import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildHubSpotAuthorizationUrl,
  exchangeHubSpotCode,
  refreshHubSpotToken,
} from "./oauth";
import { oauthRefreshResultToProviderResult } from "../../oauth/types";
export const hubspotProvider: AuthCodeConnectorAuthProvider<"hubspot"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args.authClient;
      return buildHubSpotAuthorizationUrl(
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
      const result = await exchangeHubSpotCode(
        args.authCodeGrant,
        clientId,
        clientSecret,
        code,
        redirectUri,
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
          identityNamespace: result.userInfo.identityNamespace,
          username: result.userInfo.hubDomain,
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
        await refreshHubSpotToken(
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
