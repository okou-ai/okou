import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildPosthogAuthorizationUrl,
  exchangePosthogCode,
  refreshPosthogToken,
} from "./oauth";
import { oauthRefreshResultToProviderResult } from "../../oauth/types";
export const posthogProvider: AuthCodeConnectorAuthProvider<"posthog"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args.authClient;
      return buildPosthogAuthorizationUrl(
        args.authCodeGrant,
        clientId,
        args.redirectUri,
        args.state,
      );
    },
    exchangeCode: async (args) => {
      const result = await exchangePosthogCode({
        grant: args.authCodeGrant,
        clientId: args.authClient.clientId,
        code: args.code,
        redirectUri: args.redirectUri,
        codeVerifier: args.codeVerifier,
      });
      return {
        outputs: {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          region: result.region,
          baseUrl: result.baseUrl,
        },
        expiresIn: result.expiresIn,
        scopes: result.scopes,
        userInfo: {
          // Preserve existing US account IDs while separating EU's ID namespace.
          id:
            result.region === "us"
              ? result.userInfo.id
              : `${result.region}:${result.userInfo.id}`,
          username: result.userInfo.name,
          email: result.userInfo.email,
        },
      };
    },
  },
  access: {
    kind: "refresh-token",
    refresh: async (args, signal: AbortSignal) => {
      return oauthRefreshResultToProviderResult(
        await refreshPosthogToken(
          {
            clientId: args.authClient.clientId,
            refreshToken: args.inputs.refreshToken,
            region: args.inputs.region,
            baseUrl: args.inputs.baseUrl,
          },
          signal,
        ),
      );
    },
  },
  revoke: { kind: "none" },
};
