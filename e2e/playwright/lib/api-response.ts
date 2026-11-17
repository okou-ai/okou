export function apiResponseSummary(
  response: Response,
  requestId?: string,
): string {
  const contentType = response.headers.get("content-type");
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  const kind = !mediaType
    ? "unknown"
    : mediaType === "application/json" || mediaType.endsWith("+json")
      ? "json"
      : mediaType === "text/html" || mediaType === "application/xhtml+xml"
        ? "html"
        : "other";
  return [
    `HTTP ${response.status} (${kind})`,
    "content_type=" + JSON.stringify(contentType?.slice(0, 128) ?? null),
    "content_length=" + metadataValue(response.headers.get("content-length")),
    "request_id=" +
      metadataValue(requestId ?? response.headers.get("x-request-id")),
    "retry_after=" + metadataValue(response.headers.get("retry-after")),
    "cf_ray=" + metadataValue(response.headers.get("cf-ray")),
  ].join("; ");
}

function metadataValue(value: string | null): string {
  return value === null
    ? "unavailable"
    : JSON.stringify(value.slice(0, 128)).slice(1, -1);
}

export async function readApiJson(
  response: Response,
  operation: string,
  requestId?: string,
): Promise<unknown> {
  const summary = apiResponseSummary(response, requestId);
  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // An errored body must not hide the HTTP failure already observed.
    }
    throw new Error(`${operation} failed with ${summary}`);
  }
  try {
    return (await response.json()) as unknown;
  } catch (error) {
    // JSON parser messages can quote credentials from a malformed response body.
    const reason =
      error instanceof SyntaxError
        ? "returned invalid JSON"
        : "response read failed";
    throw new Error(`${operation} ${reason}: ${summary}`);
  }
}
