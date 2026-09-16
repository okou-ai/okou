/** Mirrors the Clerk 3.13.1 response wrapper at the mocked SDK boundary. */
export class ClerkTransportTestError extends Error {
  static readonly kind = "ClerkAPIResponseError";
  readonly code = "api_response_error";

  constructor(
    readonly status: unknown = undefined,
    readonly errors: unknown = [
      { code: "unexpected_error", message: "fetch failed" },
    ],
  ) {
    super("");
    this.name = "ClerkAPIResponseError";
  }
}
