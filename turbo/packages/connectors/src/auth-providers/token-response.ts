import type { ZodType } from "zod";

import { ProviderResponseError } from "./provider-error";
import { OAuthProviderHttpError, standardOAuthErrorCode } from "./oauth/error";

export async function parseProviderTokenResponse<T>(
  response: Response,
  schema: ZodType<T>,
  failureMessage: string,
): Promise<T> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ProviderResponseError(failureMessage, {
        stage: "token",
        reason: "invalid_json",
        httpStatus: response.status,
        contentType: response.headers.get("content-type"),
      });
    }
    throw error;
  }

  if (payload !== null && typeof payload === "object" && "error" in payload) {
    const oauthError = standardOAuthErrorCode(payload.error);
    if (oauthError) {
      // Some providers return OAuth errors with HTTP 200. Preserve the error
      // code so callers can still require reconnection for invalid_grant.
      throw new OAuthProviderHttpError(
        failureMessage,
        response.status,
        oauthError,
      );
    }
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ProviderResponseError(
      failureMessage,
      {
        stage: "token",
        reason: "invalid_schema",
        httpStatus: response.status,
        contentType: response.headers.get("content-type"),
        invalidFields: parsed.error.issues.map((issue) => {
          return issue.path.map(String).join(".");
        }),
      },
      payload,
    );
  }
  return parsed.data;
}
