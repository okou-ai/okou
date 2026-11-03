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

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    if (payload !== null && typeof payload === "object" && "error" in payload) {
      const oauthError = standardOAuthErrorCode(payload.error);
      if (oauthError) {
        // Preserve standard errors that otherwise look like an invalid token
        // payload. Schema-valid error envelopes belong to the provider handler.
        throw new OAuthProviderHttpError(
          failureMessage,
          response.status,
          oauthError,
        );
      }
    }
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
