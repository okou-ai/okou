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
  readonly acceptContentType?: (contentType: string) => boolean;
}

interface DownloadResult {
  readonly path: string;
  readonly mimetype: string;
  readonly size: number;
}

async function fetchDownloadEndpoint(endpoint: URL, signal?: AbortSignal) {
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }
  const response = await fetch(endpoint, {
    headers: headersWithCliClientHeaders({ Authorization: `Bearer ${token}` }),
    redirect: "manual",
    signal,
  });
  if (response.status !== 200 && response.status !== 302) {
    const error = apiErrorSchema.safeParse(await response.json());
    throw new ApiRequestError(
      error.success
        ? error.data.error.message
        : `Failed to download file (HTTP ${response.status})`,
      error.success ? error.data.error.code : "UNKNOWN",
      response.status,
    );
  }
  return response;
}

/** Only the configured API receives the CLI credential. */
export async function resolveFileDownloadUrl(
  endpoint: URL,
  signal?: AbortSignal,
) {
  const response = await fetchDownloadEndpoint(endpoint, signal);
  return fileDownloadUrlSchema.parse(await response.json());
}

export async function downloadFileViaUrl(
  endpoint: URL,
  outPath: string,
  options: DownloadOptions = {},
): Promise<DownloadResult> {
  return downloadFileFromUrl(
    await resolveFileDownloadUrl(endpoint),
    outPath,
    options,
  );
}

/** The API selects a public capability or credentialed provider bytes once. */
export async function downloadFileFromApi(
  endpoint: URL,
  outPath: string,
  options: DownloadOptions = {},
): Promise<DownloadResult> {
  let response = await fetchDownloadEndpoint(endpoint);
  const metadata = {
    contentType:
      response.headers.get("x-file-mimetype") ?? "application/octet-stream",
    size: response.headers.has("x-file-size")
      ? Number(response.headers.get("x-file-size"))
      : undefined,
  };
  if (response.status === 302) {
    const location = fileDownloadUrlSchema.shape.downloadUrl.parse(
      response.headers.get("location"),
    );
    await response.body?.cancel();
    response = await fetchFileUrl(location);
  }
  return writeDownloadFile(response, metadata, outPath, options);
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

export async function fetchFileUrl(initialUrl: string, signal?: AbortSignal) {
  let url = fileDownloadUrlSchema.shape.downloadUrl.parse(initialUrl);
  let redirects = 0;
  while (true) {
    const response = await fetch(url, {
      credentials: "omit",
      headers: { "Accept-Encoding": "identity" },
      redirect: "manual",
      signal,
    });
    if (response.status === 200) return response;
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      throw new Error(`File download failed (HTTP ${response.status})`);
    }
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
  metadata: Pick<FileDownloadUrl, "contentType">,
  matchMetadata: boolean,
): string {
  const contentType = response.headers.get("content-type");
  const declaredType = new MIMEType(metadata.contentType).essence;
  const receivedType = contentType
    ? new MIMEType(contentType).essence
    : undefined;
  if (
    matchMetadata &&
    declaredType !== "application/octet-stream" &&
    receivedType !== undefined &&
    receivedType !== "application/octet-stream" &&
    receivedType !== declaredType
  ) {
    throw new Error("File download MIME type differs from its metadata");
  }
  // Preserve charset parameters in Web/Graph response metadata. Discord's
  // provider-declared MIME remains authoritative even for generic CDN responses.
  // Generic metadata marks an omitted type; validate the CDN's MIME instead.
  return matchMetadata && declaredType !== "application/octet-stream"
    ? declaredType
    : contentType || metadata.contentType;
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
): Promise<DownloadResult> {
  const response = await fetchFileUrl(metadata.downloadUrl);
  return writeDownloadFile(response, metadata, outPath, options);
}

async function writeDownloadFile(
  response: Response,
  metadata: Pick<FileDownloadUrl, "contentType" | "size">,
  outPath: string,
  options: DownloadOptions,
): Promise<DownloadResult> {
  const temporaryPath = `${outPath}.${randomUUID()}.part`;
  const maximum = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
  try {
    if (!response.body) throw new Error("File download response has no body");
    const length = contentLength(response);
    if ((metadata.size ?? 0) > maximum || (length ?? 0) > maximum) {
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
    if (
      options.acceptContentType &&
      !options.acceptContentType(new MIMEType(mimetype).essence)
    ) {
      throw new Error("File download MIME type is unsupported");
    }
    const size = await writeDownloadBody(
      response.body,
      temporaryPath,
      metadata.size ?? length,
      maximum,
    );
    await rename(temporaryPath, outPath);
    return { path: outPath, mimetype, size };
  } finally {
    try {
      await response.body?.cancel();
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}
