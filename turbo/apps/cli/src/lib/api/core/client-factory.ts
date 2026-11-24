import { getApiUrl, getActiveToken } from "../config";
import type { ApiErrorResponse } from "@okouai/api-contracts/contracts/errors";
import { cliClientHeaderApi } from "../client-headers";

/**
 * Custom API request error with code and HTTP status
 */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/**
 * Build authentication headers from a token
 */
function buildHeaders(token: string): Record<string, string> {
  // Note: Don't set Content-Type here - the contract client adds it for requests with body.
  // Setting Content-Type for bodyless requests (GET, DELETE) can cause server-side parsing issues.
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  return headers;
}

/**
 * Get base URL for API requests
 */
export async function getBaseUrl(): Promise<string> {
  const apiUrl = await getApiUrl();
  if (!apiUrl) {
    throw new Error("API URL not configured");
  }
  return apiUrl;
}

/**
 * Configuration for contract client initialization
 */
export async function getClientConfig() {
  const baseUrl = await getBaseUrl();
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }
  const baseHeaders = buildHeaders(token);

  // JWT tokens carry orgId in payload — server extracts it from authCtx.orgId
  return {
    baseUrl,
    baseHeaders,
    jsonQuery: false as const,
    api: cliClientHeaderApi,
  };
}

/**
 * Handle API error responses and throw appropriate error.
 *
 * Parses the server error response and throws an ApiRequestError
 * with the server's message and code. Falls back to defaultMessage
 * if the server response doesn't include an error message.
 */
export function handleError(
  result: { status: number; body: unknown },
  defaultMessage: string,
): never {
  const errorBody = result.body as ApiErrorResponse;
  const message = errorBody.error?.message || defaultMessage;
  const code = errorBody.error?.code || "UNKNOWN";
  throw new ApiRequestError(message, code, result.status);
}
