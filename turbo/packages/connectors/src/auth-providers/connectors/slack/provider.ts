import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildSlackAuthorizationUrl,
  exchangeSlackCode,
  fetchSlackUserInfo,
  revokeSlackToken,
} from "./oauth";
export const slackProvider: AuthCodeConnectorAuthProvider<"slack"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args.authClient;
      return buildSlackAuthorizationUrl(
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
      const slackResult = await exchangeSlackCode(
        args.authCodeGrant,
        clientId,
        clientSecret,
        code,
        redirectUri,
      );
      const slackUser = await fetchSlackUserInfo(
        slackResult.userId,
        slackResult.accessToken,
      );
      return {
        outputs: {
          accessToken: slackResult.accessToken,
        },
        scopes: slackResult.scopes,
        userInfo: {
          id: slackUser.id,
          identityNamespace: slackResult.identityNamespace,
          username: slackUser.username,
          email: slackUser.email,
        },
      };
    },
  },
  access: {
    kind: "none",
  },
  revoke: {
    kind: "token-revoke",
    revokeToken: (args) => {
      const { clientId, clientSecret } = args.authClient;
      return revokeSlackToken(clientId, clientSecret, args.inputs.accessToken);
    },
  },
};
