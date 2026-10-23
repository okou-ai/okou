import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { MIMEType } from "node:util";
import {
  fileDownloadUrlSchema,
  type FileDownloadUrl,
} from "@okouai/api-contracts/contracts/file-download";
import { apiErrorSchema } from "@okouai/api-contracts/contracts/errors";
import { getActiveToken } from "./config";
import { headersWithCliClientHeaders } from "./client-headers";
import { ApiRequestError } from "./core/client-factory";

interface DownloadOptions {
  readonly maxBytes?: number;
  readonly matchMetadataContentType?: boolean;
}

interface DownloadResult {
  readonly path: string;
  readonly mimetype: string;
  readonly size: number;
}

/** Resolve a single-file capability; only the API receives the CLI token. */
export async function downloadFileViaUrl(
  endpoint: URL,
  outPath: string,
  options: DownloadOptions = {},
  signal?: AbortSignal,
): Promise<DownloadResult | null> {
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }
  const response = await fetch(endpoint, {
    headers: headersWithCliClientHeaders({
      Authorization: `Bearer ${token}`,
    }),
    redirect: "error",
    signal,
  });
  const body: unknown = await response.json();
  // Older API deployments have no URL route. Resource-level 404s use the
  // structured API error envelope and must not trigger a second lookup.
  if (
    response.status === 404 &&
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    body.error === "Not found"
  ) {
    return null;
  }
  if (response.status !== 200) {
    const error = apiErrorSchema.safeParse(body);
    if (
      response.status === 409 &&
      error.success &&
      error.data.error.code === "DIRECT_DOWNLOAD_UNAVAILABLE"
    ) {
      return null;
    }
    throw new ApiRequestError(
      error.success
        ? error.data.error.message
        : `Failed to resolve file download (HTTP ${response.status})`,
      error.success ? error.data.error.code : "UNKNOWN",
      response.status,
    );
  }
  return downloadFileFromUrl(
    fileDownloadUrlSchema.parse(body),
    outPath,
    options,
    signal,
  );
}

function contentLength(response: Response): number | undefined {
  // fetch decodes encoded bodies, whose wire length is not their file length.
  const encoding = response.headers.get("content-encoding");
  if (encoding && encoding !== "identity") return undefined;
  const value = response.headers.get("content-length");
  if (value === null) return undefined;
  const length = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(length)) {
    throw new Error("File download has an invalid content length");
  }
  return length;
}

async function fetchFileUrl(initialUrl: string, signal: AbortSignal) {
  let url = fileDownloadUrlSchema.shape.downloadUrl.parse(initialUrl);
  let redirects = 0;
  while (true) {
    const response = await fetch(url, {
      credentials: "omit",
      headers: { "Accept-Encoding": "identity" },
      redirect: "manual",
      signal,
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || redirects++ >= 5) {
      throw new Error("File download has an invalid redirect chain");
    }
    url = fileDownloadUrlSchema.shape.downloadUrl.parse(
      new URL(location, url).href,
    );
  }
}

function downloadMimetype(
  response: Response,
  metadata: FileDownloadUrl,
  matchMetadata: boolean,
): string {
  const contentType = response.headers.get("content-type");
  const declaredType = new MIMEType(metadata.contentType).essence;
  const receivedType = contentType
    ? new MIMEType(contentType).essence
    : undefined;
  if (
    matchMetadata &&
    receivedType !== undefined &&
    receivedType !== "application/octet-stream" &&
    receivedType !== declaredType
  ) {
    throw new Error("File download MIME type differs from its metadata");
  }
  // Preserve charset parameters in Web/Graph response metadata. Discord's
  // provider-declared MIME remains authoritative even for generic CDN responses.
  return matchMetadata ? declaredType : contentType || metadata.contentType;
}

async function writeDownloadBody(
  body: ReadableStream<Uint8Array>,
  path: string,
  expectedLength: number | undefined,
  maximum: number,
): Promise<number> {
  const reader = body.getReader();
  let size = 0;
  try {
    const file = await open(path, "wx", 0o600);
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (
          size > maximum ||
          (expectedLength !== undefined && size > expectedLength)
        ) {
          throw new Error("File download exceeds its declared size or limit");
        }
        await file.writeFile(chunk.value);
      }
      if (expectedLength !== undefined && size !== expectedLength) {
        throw new Error("File download is incomplete");
      }
      return size;
    } finally {
      await file.close();
    }
  } finally {
    reader.releaseLock();
  }
}

/** Stream a capability URL to an atomic local file without account credentials. */
export async function downloadFileFromUrl(
  metadata: FileDownloadUrl,
  outPath: string,
  options: DownloadOptions = {},
  owner?: AbortSignal,
): Promise<DownloadResult> {
  const controller = new AbortController();
  const signal = owner
    ? AbortSignal.any([owner, controller.signal])
    : controller.signal;
  const temporaryPath = `${outPath}.${randomUUID()}.part`;
  const maximum = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
  try {
    if (metadata.size !== undefined && metadata.size > maximum) {
      throw new Error("File exceeds the download size limit");
    }
    const response = await fetchFileUrl(metadata.downloadUrl, signal);
    if (response.status !== 200) {
      throw new Error(`File download failed (HTTP ${response.status})`);
    }
    if (!response.body) throw new Error("File download response has no body");
    const length = contentLength(response);
    if (length !== undefined && length > maximum) {
      throw new Error("File exceeds the download size limit");
    }
    if (
      metadata.size !== undefined &&
      length !== undefined &&
      metadata.size !== length
    ) {
      throw new Error("File download length differs from its metadata");
    }
    const mimetype = downloadMimetype(
      response,
      metadata,
      options.matchMetadataContentType ?? false,
    );
    const size = await writeDownloadBody(
      response.body,
      temporaryPath,
      metadata.size ?? length,
      maximum,
    );
    await rename(temporaryPath, outPath);
    return { path: outPath, mimetype, size };
  } finally {
    controller.abort();
    await rm(temporaryPath, { force: true });
  }
}
