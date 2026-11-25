import type { AuthCodeConnectorAuthProvider } from "../../types";
import { buildLinkedInAuthorizationUrl, exchangeLinkedInCode } from "./oauth";

export const linkedinProvider: AuthCodeConnectorAuthProvider<
  "linkedin",
  "oauth"
> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      return buildLinkedInAuthorizationUrl(
        args.authCodeGrant,
        args.authClient.clientId,
        args.redirectUri,
        args.state,
      );
    },
    exchangeCode: async (args) => {
      const result = await exchangeLinkedInCode({
        grant: args.authCodeGrant,
        clientId: args.authClient.clientId,
        clientSecret: args.authClient.clientSecret,
        code: args.code,
        redirectUri: args.redirectUri,
      });
      return {
        outputs: { accessToken: result.accessToken },
        expiresIn: result.expiresIn,
        scopes: result.scopes,
        userInfo: result.userInfo,
      };
    },
  },
  access: { kind: "none" },
  revoke: { kind: "none" },
};
