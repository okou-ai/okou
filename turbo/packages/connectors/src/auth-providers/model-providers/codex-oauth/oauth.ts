import { number, object, string } from "zod";
import { throwOAuthError } from "../../oauth/error";
import { reportedOAuthScopes } from "../../oauth/scope";

export const CHATGPT_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CHATGPT_OAUTH_ISSUER = "https://auth.openai.com";

const CHATGPT_OAUTH_TOKEN_URL = `${CHATGPT_OAUTH_ISSUER}/oauth/token`;

export type ChatgptRefreshErrorCode =
  | "refresh_token_expired"
  | "refresh_token_reused"
  | "refresh_token_invalidated"
  | "refresh_token_other";

/**
 * Typed error for refresh-token failures so the firewall pipeline can
 * distinguish stale-token cases (must re-auth) from transient HTTP errors
 * (retry next time).
 */
export interface ChatgptRefreshError extends Error {
  readonly name: "ChatgptRefreshError";
  readonly code: ChatgptRefreshErrorCode;
}

function createChatgptRefreshError(
  code: ChatgptRefreshErrorCode,
  message: string,
): ChatgptRefreshError {
  const err = new Error(message);
  err.name = "ChatgptRefreshError";
  Object.assign(err, { code });
  return err as ChatgptRefreshError;
}

export function isChatgptRefreshError(
  value: unknown,
): value is ChatgptRefreshError {
  return (
    value instanceof Error &&
    value.name === "ChatgptRefreshError" &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

interface ChatgptRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[] | null;
}

const refreshResponseSchema = object({
  id_token: string().optional(),
  access_token: string().optional(),
  refresh_token: string().nullable().optional(),
  expires_in: number().optional(),
  scope: string().optional(),
});

const refreshErrorBodySchema = object({
  error: object({
    code: string().optional(),
    message: string().optional(),
  }).optional(),
});

/**
 * Refresh a ChatGPT access token. Refresh tokens rotate on each call -
 * the new refresh_token (when present) is returned and must be persisted by
 * the caller. 401 responses are classified into ChatgptRefreshError codes
 * so the firewall pipeline can distinguish stale-token from transient errors.
 */
export async function refreshChatgptToken(
  clientId: string,
  refreshToken: string,
  signal: AbortSignal,
): Promise<ChatgptRefreshResult> {
  const response = await fetch(CHATGPT_OAUTH_TOKEN_URL, {
    signal,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (response.status === 401) {
    const body = await response.text();
    let code: ChatgptRefreshErrorCode = "refresh_token_other";
    let message = body;
    try {
      const parsed = refreshErrorBodySchema.parse(JSON.parse(body));
      const errCode = parsed.error?.code;
      if (
        errCode === "refresh_token_expired" ||
        errCode === "refresh_token_reused" ||
        errCode === "refresh_token_invalidated"
      ) {
        code = errCode;
      }
      message = parsed.error?.message ?? body;
    } catch {
      // body wasn't JSON - keep raw text as message, code stays "refresh_token_other"
    }
    throw createChatgptRefreshError(code, `ChatGPT refresh failed: ${message}`);
  }

  if (!response.ok) {
    await throwOAuthError("ChatGPT", "refresh", response);
  }

  const data = refreshResponseSchema.parse(await response.json());
  if (!data.access_token) {
    throw new Error("No access token in ChatGPT refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: reportedOAuthScopes(data.scope, " "),
  };
}

export function getChatgptSecretName(): "CHATGPT_ACCESS_TOKEN" {
  return "CHATGPT_ACCESS_TOKEN";
}

export function getChatgptRefreshSecretName(): "CHATGPT_REFRESH_TOKEN" {
  return "CHATGPT_REFRESH_TOKEN";
}
