import { safeUrlParse } from "../utils";

interface ScrapeTargetPolicyResult {
  readonly url: URL;
}

export type ScrapeTargetPolicyError =
  "invalid_url" | "unsupported_scheme" | "embedded_credentials";

export function validateScrapeTargetUrl(
  rawUrl: string,
): ScrapeTargetPolicyResult | ScrapeTargetPolicyError {
  const url = safeUrlParse(rawUrl);
  if (!url) {
    return "invalid_url";
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "unsupported_scheme";
  }

  if (url.username || url.password) {
    return "embedded_credentials";
  }

  return { url };
}
