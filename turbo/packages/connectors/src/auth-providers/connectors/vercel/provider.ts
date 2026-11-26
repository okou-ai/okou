import { effectiveOAuthScopes } from "../../oauth/scope";
import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildVercelAuthorizationUrl,
  exchangeVercelCode,
  fetchVercelUserInfo,
  requestVercelInstallationToken,
} from "./oauth";

export const vercelProvider: AuthCodeConnectorAuthProvider<"vercel", "oauth"> =
  {
    grant: {
      kind: "auth-code",
      buildAuthUrl: (args) => {
        const { clientId } = args.authClient;
        return buildVercelAuthorizationUrl(
          clientId,
          args.redirectUri,
          args.state,
        );
      },
      exchangeCode: async (args) => {
        const { clientId, clientSecret } = args.authClient;
        const code = args.code;
        const redirectUri = args.redirectUri;
        const result = await exchangeVercelCode(
          clientId,
          clientSecret,
          code,
          redirectUri,
        );
        return {
          outputs: {
            accessToken: result.accessToken,
          },
          scopes: [],
          userInfo: await fetchVercelUserInfo(result.accessToken),
        };
      },
    },
    access: {
      kind: "none",
    },
    revoke: { kind: "none" },
  };

export const vercelInstallationProvider: AuthCodeConnectorAuthProvider<
  "vercel",
  "oauth-installation"
> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: vercelProvider.grant.buildAuthUrl,
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args.authClient;
      const { installationId } = await exchangeVercelCode(
        clientId,
        clientSecret,
        args.code,
        args.redirectUri,
      );
      if (!installationId) {
        throw new Error("No installation ID in Vercel authorization response");
      }
      const token = await requestVercelInstallationToken({
        clientId,
        clientSecret,
        installationId,
      });
      return {
        outputs: { accessToken: token.accessToken, installationId },
        expiresIn: token.expiresIn,
        scopes: effectiveOAuthScopes(
          token.scope,
          args.authCodeGrant.scopes,
          /\s+/u,
        ),
        userInfo: await fetchVercelUserInfo(token.accessToken),
      };
    },
  },
  access: {
    kind: "refresh-token",
    refresh: async (args, signal) => {
      const { clientId, clientSecret } = args.authClient;
      const token = await requestVercelInstallationToken(
        { clientId, clientSecret, installationId: args.inputs.installationId },
        signal,
      );
      return {
        outputs: { accessToken: token.accessToken },
        expiresIn: token.expiresIn,
      };
    },
  },
  revoke: { kind: "none" },
};
