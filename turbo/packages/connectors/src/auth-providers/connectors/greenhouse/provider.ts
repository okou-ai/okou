import type { RefreshTokenAccessProvider } from "../../types";
import { fetchGreenhouseAccessToken } from "./api-token";

export const greenhouseProvider = {
  access: {
    kind: "refresh-token",
    refresh: async (args, signal: AbortSignal) => {
      const token = await fetchGreenhouseAccessToken(
        {
          clientId: args.inputs.clientId,
          clientSecret: args.inputs.clientSecret,
          userId: args.inputs.userId,
        },
        signal,
      );
      return {
        outputs: { accessToken: token.accessToken },
        expiresIn: token.expiresIn,
      };
    },
  } satisfies RefreshTokenAccessProvider<
    "greenhouse",
    "oauth-client-credentials"
  >,
};
