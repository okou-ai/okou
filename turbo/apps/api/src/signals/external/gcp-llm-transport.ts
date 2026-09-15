export type GcpLlmTransportReason = "network" | "upstream_timeout";

function property(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? value[key as keyof typeof value]
    : undefined;
}

/** Classify only errors caught at fetch/body I/O, never output interpretation. */
export function gcpLlmTransportReason(
  error: unknown,
): GcpLlmTransportReason | undefined {
  if (error instanceof Error && error.name === "AbortError") {
    return undefined;
  }
  const code =
    property(property(error, "cause"), "code") ?? property(error, "code");
  if (
    typeof code === "string" &&
    [
      "ETIMEDOUT",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
    ].includes(code)
  ) {
    return "upstream_timeout";
  }
  if (
    (typeof code === "string" &&
      [
        "ECONNRESET",
        "ECONNREFUSED",
        "EAI_AGAIN",
        "ENETUNREACH",
        "UND_ERR_SOCKET",
      ].includes(code)) ||
    (code === undefined &&
      error instanceof TypeError &&
      (error.message === "fetch failed" || error.message === "Failed to fetch"))
  ) {
    return "network";
  }
  return undefined;
}
