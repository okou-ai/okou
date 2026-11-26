import { type ModelProviderRefreshTokenAuthProvider } from "../../types";
import { refreshChatgptToken } from "./oauth";
import { oauthRefreshResultToProviderResult } from "../../oauth/types";

type CodexOAuthRefreshInputs = {
  readonly refreshToken: string;
};

type CodexOAuthRefreshOutputs = {
  readonly accessToken: string;
  readonly refreshToken?: string;
};

/**
 * Refresh provider for the codex-oauth-token model provider type.
 *
 * Browser OAuth setup is not supported. Users connect by pasting auth.json;
 * this provider only keeps the derived ChatGPT access token fresh server-side.
 */
const codexOauthProviderDefinition = {
  grant: {
    kind: "none",
  },
  access: {
    kind: "refresh-token",
    resolveAuthClient: (env) => {
      const clientId = env.CODEX_OAUTH_CLIENT_ID;
      if (!clientId) {
        return undefined;
      }
      return {
        clientRegistration: "static",
        clientType: "public",
        clientId,
      };
    },
    refresh: async (args, signal: AbortSignal) => {
      const refreshToken = args.inputs.refreshToken;
      return oauthRefreshResultToProviderResult(
        await refreshChatgptToken(
          args.authClient.clientId,
          refreshToken,
          signal,
        ),
      );
    },
  },
  revoke: {
    kind: "none",
  },
} satisfies ModelProviderRefreshTokenAuthProvider<
  CodexOAuthRefreshInputs,
  CodexOAuthRefreshOutputs
>;

export const codexOauthProvider: ModelProviderRefreshTokenAuthProvider<
  CodexOAuthRefreshInputs,
  CodexOAuthRefreshOutputs
> = codexOauthProviderDefinition;
