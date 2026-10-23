import { command } from "ccstate";
import { integrationsGithubDownloadFileContract } from "@okouai/api-contracts/contracts/integrations";

import { inferMimetype } from "../../lib/mimetype";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { safeUriComponentDecode, tapError } from "../utils";

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;

function jsonResponse(status: number, message: string, code: string): Response {
  return Response.json({ error: { message, code } }, { status });
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const size = Number(value);
  return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
}

const GITHUB_ASSET_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const GITHUB_CONTENT_HOSTS = [
  "objects.githubusercontent.com",
  "private-user-images.githubusercontent.com",
  "raw.githubusercontent.com",
  "user-images.githubusercontent.com",
] as const;

const EXTENSION_BY_CONTENT_TYPE: Readonly<Record<string, string>> = {
  "application/json": "json",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "text/csv": "csv",
  "text/markdown": "md",
  "text/plain": "txt",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};

function normalizeGithubDownloadUrl(url: string): string {
  return url.replace(/[.,;:!?]+$/u, "");
}

function isAllowedGithubDownloadUrl(url: string): boolean {
  if (!URL.canParse(url)) {
    return false;
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "github.com") {
    return (
      parsed.pathname.startsWith("/user-attachments/assets/") ||
      parsed.pathname.startsWith("/user-attachments/files/")
    );
  }

  return GITHUB_CONTENT_HOSTS.some((host) => {
    return host === hostname;
  });
}

function filenameFromContentDisposition(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/iu);
  if (utf8Match?.[1]) {
    return utf8Match[1].trim();
  }

  const quotedMatch = value.match(/filename="([^"]+)"/iu);
  return quotedMatch?.[1] ?? null;
}

function filenameFromGithubDownloadUrl(url: string): string | null {
  const parsed = new URL(url);
  const segment = parsed.pathname.split("/").filter(Boolean).pop();
  if (!segment || GITHUB_ASSET_ID_RE.test(segment)) {
    return null;
  }
  return segment;
}

function extensionFromContentType(contentType: string | null): string | null {
  const normalized = contentType?.split(";")[0]?.trim().toLowerCase();
  return normalized ? (EXTENSION_BY_CONTENT_TYPE[normalized] ?? null) : null;
}

function fallbackGithubFilename(contentType: string | null): string {
  const extension = extensionFromContentType(contentType);
  return extension ? `github-file.${extension}` : "github-file";
}

function sanitizeDownloadFilename(filename: string): string {
  return filename.trim().replace(/[/\\]/gu, "_").slice(0, 255) || "github-file";
}

const download$ = command(async ({ get }, signal: AbortSignal) => {
  const query = get(queryOf(integrationsGithubDownloadFileContract.download));
  const fileUrl = normalizeGithubDownloadUrl(query.url);
  if (!isAllowedGithubDownloadUrl(fileUrl)) {
    return jsonResponse(
      400,
      "Only GitHub file attachment URLs can be downloaded",
      "BAD_REQUEST",
    );
  }

  const headers = new Headers({ Accept: "application/octet-stream" });
  const downloadResponse = await tapError(
    fetch(fileUrl, {
      headers,
      signal,
    }),
  );
  signal.throwIfAborted();
  if (!downloadResponse) {
    return jsonResponse(502, "Failed to download GitHub file", "BAD_GATEWAY");
  }
  if (!downloadResponse.ok) {
    const status = downloadResponse.status === 404 ? 404 : 502;
    return jsonResponse(
      status,
      `Failed to download GitHub file: ${downloadResponse.status}`,
      status === 404 ? "NOT_FOUND" : "BAD_GATEWAY",
    );
  }
  if (!downloadResponse.body) {
    return jsonResponse(
      502,
      "GitHub download response has no body",
      "EMPTY_BODY",
    );
  }

  const contentLength = downloadResponse.headers.get("content-length");
  const contentLengthBytes = parseContentLength(contentLength);
  if (
    contentLengthBytes !== undefined &&
    contentLengthBytes > MAX_FILE_SIZE_BYTES
  ) {
    return jsonResponse(
      413,
      `File exceeds maximum size of ${MAX_FILE_SIZE_BYTES} bytes`,
      "PAYLOAD_TOO_LARGE",
    );
  }

  const responseContentType = downloadResponse.headers.get("content-type");
  if (responseContentType?.includes("text/html")) {
    return jsonResponse(
      502,
      "GitHub returned an unexpected HTML file response",
      "BAD_GATEWAY",
    );
  }
  const filename = sanitizeDownloadFilename(
    query.filename ??
      filenameFromContentDisposition(
        downloadResponse.headers.get("content-disposition"),
      ) ??
      filenameFromGithubDownloadUrl(fileUrl) ??
      fallbackGithubFilename(responseContentType),
  );
  const contentType = responseContentType ?? inferMimetype(filename);

  const responseHeaders = new Headers();
  responseHeaders.set("Content-Type", contentType);
  responseHeaders.set("X-File-Name", encodeURIComponent(filename));
  responseHeaders.set("X-File-Mimetype", contentType);
  if (contentLength) {
    responseHeaders.set("Content-Length", contentLength);
  }

  return new Response(downloadResponse.body, {
    status: 200,
    headers: responseHeaders,
  });
});

const fileUrl$ = command(({ get }) => {
  const query = get(queryOf(integrationsGithubDownloadFileContract.fileUrl));
  // Keep signed query parameters byte-for-byte; punctuation cleanup applies
  // only to bare attachment links copied from prose.
  const downloadUrl = new URL(query.url).search
    ? query.url
    : normalizeGithubDownloadUrl(query.url);
  const parsed = new URL(downloadUrl);
  if (
    !isAllowedGithubDownloadUrl(downloadUrl) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.hash !== ""
  ) {
    return jsonResponse(
      400,
      "Only GitHub file attachment URLs can be downloaded",
      "BAD_REQUEST",
    );
  }
  const urlFilename = filenameFromGithubDownloadUrl(downloadUrl);
  const decodedFilename = urlFilename
    ? (safeUriComponentDecode(urlFilename) ?? urlFilename)
    : urlFilename;
  const filename = sanitizeDownloadFilename(
    (query.filename ?? decodedFilename ?? "github-file").replace(
      /\p{Cc}/gu,
      "",
    ),
  );
  const safeFilename =
    filename === "." || filename === ".." ? "github-file" : filename;
  return Response.json(
    {
      downloadUrl,
      filename: safeFilename,
      contentType: inferMimetype(safeFilename),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
});

const githubReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "github:read",
} as const;

export const integrationsGithubDownloadFileRoutes: readonly RouteEntry[] = [
  {
    route: integrationsGithubDownloadFileContract.download,
    handler: authRoute(githubReadAuth, download$),
  },
  {
    route: integrationsGithubDownloadFileContract.fileUrl,
    handler: authRoute(githubReadAuth, fileUrl$),
  },
];
