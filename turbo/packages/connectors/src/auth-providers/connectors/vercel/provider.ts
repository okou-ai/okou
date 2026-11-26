import { effectiveOAuthScopes } from "../../oauth/scope";
import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildVercelAuthorizationUrl,
  exchangeVercelCode,
  fetchVercelUserInfo,
  requestVercelInstallationToken,
} from "./oauth";

export const vercelProvider: AuthCodeConnectorAuthProvider<"vercel"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      return buildVercelAuthorizationUrl(
        args.authClient.clientId,
        args.redirectUri,
        args.state,
      );
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args.authClient;
      const codeExchange = await exchangeVercelCode(
        clientId,
        clientSecret,
        args.code,
        args.redirectUri,
      );
      if (!Object.hasOwn(args.authCodeGrant.outputs, "installationId")) {
        return {
          outputs: { accessToken: codeExchange.accessToken },
          scopes: [],
          userInfo: await fetchVercelUserInfo(codeExchange.accessToken),
        };
      }
      const { installationId } = codeExchange;
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
