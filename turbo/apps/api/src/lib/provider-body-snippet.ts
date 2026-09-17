import { redactPresignedUrls } from "./presigned-url-redaction";

const PROVIDER_BODY_SNIPPET_MAX_LENGTH = 200;

/**
 * Keeps a bounded, redacted slice of an upstream response body for a failure
 * record. A gateway error answers with its own page rather than the provider's
 * error envelope, so the parsed message is empty and the body is the only thing
 * left that identifies the failure class. Callers decide which bodies qualify;
 * this only guarantees the slice stays short and carries no presigned URL.
 */
export function providerBodySnippet(body: string): string | undefined {
  const collapsed = redactPresignedUrls(body).replace(/\s+/gu, " ").trim();
  if (!collapsed) {
    return undefined;
  }
  return collapsed.length > PROVIDER_BODY_SNIPPET_MAX_LENGTH
    ? `${collapsed.slice(0, PROVIDER_BODY_SNIPPET_MAX_LENGTH)}…`
    : collapsed;
}
