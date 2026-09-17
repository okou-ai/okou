const ALLOWED_SLACK_DOWNLOAD_HOSTNAMES: ReadonlySet<string> = Object.freeze(
  new Set(["files.slack.com", "files-pri.slack.com", "cdn.slack.com"]),
);

type SlackFileFetchErrorCode =
  | "invalid-url"
  | "download-failed"
  | "html-response"
  | "too-large";

export class SlackFileFetchError extends Error {
  constructor(
    readonly code: SlackFileFetchErrorCode,
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "SlackFileFetchError";
  }
}

export function isSlackFileFetchError(
  error: unknown,
): error is SlackFileFetchError {
  return error instanceof SlackFileFetchError;
}

function isValidSlackDownloadUrl(url: string): boolean {
  const parsed = URL.parse(url);
  if (!parsed) {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    ALLOWED_SLACK_DOWNLOAD_HOSTNAMES.has(parsed.hostname)
  );
}

export const MAX_SLACK_FILE_SIZE_BYTES = 100 * 1024 * 1024;

export async function fetchSlackFile(
  url: string,
  token: string,
  signal?: AbortSignal,
): Promise<Response> {
  if (!isValidSlackDownloadUrl(url)) {
    throw new SlackFileFetchError("invalid-url", "Invalid Slack download URL");
  }

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });

  if (!response.ok) {
    throw new SlackFileFetchError(
      "download-failed",
      `Failed to download Slack file: ${response.status} ${response.statusText}`,
      response.status,
    );
  }

  const responseContentType = response.headers.get("content-type") ?? "";
  if (responseContentType.includes("text/html")) {
    throw new SlackFileFetchError(
      "html-response",
      "Slack returned an unexpected response",
    );
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const size = Number(contentLength);
    if (Number.isSafeInteger(size) && size > MAX_SLACK_FILE_SIZE_BYTES) {
      throw new SlackFileFetchError("too-large", "File exceeds maximum size");
    }
  }

  return response;
}
