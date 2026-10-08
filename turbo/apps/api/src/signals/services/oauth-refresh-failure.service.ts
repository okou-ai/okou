import { isOAuthProviderHttpError } from "@okouai/connectors/auth-providers/oauth/error";
import {
  isProviderHttpError,
  isProviderResponseError,
} from "@okouai/connectors/auth-providers/provider-error";

export function isFetchNetworkError(error: unknown): boolean {
  return (
    error instanceof TypeError && error.message.toLowerCase().includes("fetch")
  );
}

/** An upstream outage is not evidence that the stored authorization changed.
 * Keep explicit invalid_grant responses terminal even if their HTTP status is
 * unexpected; provider-specific rotating-token admission remains separate. */
export function isTransientOAuthRefreshFailure(error: unknown): boolean {
  if (isOAuthProviderHttpError(error)) {
    if (error.oauthError === "invalid_grant") {
      return false;
    }
    if (
      error.oauthError === "server_error" ||
      error.oauthError === "temporarily_unavailable"
    ) {
      return true;
    }
  }
  return (
    (isProviderHttpError(error) &&
      (error.status >= 500 || error.status === 429)) ||
    isProviderResponseError(error) ||
    isFetchNetworkError(error)
  );
}
