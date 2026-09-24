import type { DiscordApiResult } from "../external/discord-client";

export type DiscordFailureResponse = {
  status: 403 | 404 | 429 | 502 | 503;
  body: {
    error: {
      code: string;
      message: string;
      retryAfterSeconds?: number;
    };
  };
};

export function discordUnavailable(): DiscordFailureResponse {
  return {
    status: 404,
    body: {
      error: {
        code: "NOT_FOUND",
        message:
          "This Discord conversation is unavailable to your connected account and Okou in the current organization.",
      },
    },
  };
}

export function discordApiFailure(
  result: Exclude<DiscordApiResult<unknown>, { kind: "ok" }>,
): DiscordFailureResponse {
  if (result.kind === "unavailable") {
    return discordUnavailable();
  }
  if (result.status === 429) {
    return {
      status: 429,
      body: {
        error: {
          code: "DISCORD_RATE_LIMITED",
          message:
            "Discord rate limit reached. Retry after the indicated delay.",
          ...(result.retryAfterMs !== undefined && {
            retryAfterSeconds: Math.ceil(result.retryAfterMs / 1000),
          }),
        },
      },
    };
  }
  return {
    status: 502,
    body: {
      error: {
        code: "DISCORD_ERROR",
        message:
          "Discord could not complete the request. No automatic resend was attempted for an uncertain delivery.",
      },
    },
  };
}
