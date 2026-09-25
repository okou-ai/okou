import {
  discordFilenameSchema,
  MAX_DISCORD_FILE_SIZE_BYTES,
} from "@okouai/api-contracts/contracts/integrations-discord-files";
import { isAllowedUploadType } from "../../lib/uploads-constants";
import {
  settle,
  settleIncludingAbort,
  startUntrackedBestEffortCleanup,
} from "../utils";

const DISCORD_ATTACHMENT_HOSTS: ReadonlySet<string> = Object.freeze(
  new Set(["cdn.discordapp.com", "media.discordapp.net"]),
);

export class DiscordFileFetchError extends Error {
  constructor(
    readonly code: "invalid-attachment" | "too-large" | "download-failed",
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "DiscordFileFetchError";
  }
}

export interface DiscordAttachmentDownload {
  readonly channelId: string;
  readonly attachmentId: string;
  readonly filename: string;
  readonly size: number;
  readonly contentType?: string;
  readonly url: string;
}

function validateAttachment(args: DiscordAttachmentDownload): void {
  const url = URL.parse(args.url);
  if (
    !url ||
    url.protocol !== "https:" ||
    !DISCORD_ATTACHMENT_HOSTS.has(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hash !== "" ||
    !/^[1-9]\d{0,19}$/u.test(args.channelId) ||
    !/^[1-9]\d{0,19}$/u.test(args.attachmentId) ||
    !url.pathname.startsWith(
      `/attachments/${args.channelId}/${args.attachmentId}/`,
    ) ||
    !discordFilenameSchema.safeParse(args.filename).success
  ) {
    throw new DiscordFileFetchError(
      "invalid-attachment",
      "Discord returned an invalid attachment reference",
    );
  }
  if (!Number.isSafeInteger(args.size) || args.size < 0) {
    throw new DiscordFileFetchError(
      "invalid-attachment",
      "Discord returned an invalid attachment size",
    );
  }
  if (args.size > MAX_DISCORD_FILE_SIZE_BYTES) {
    throw new DiscordFileFetchError("too-large", "Discord file exceeds 10 MiB");
  }
}

function attachmentContentType(
  declared: string | undefined,
  received: string | null,
): string {
  const declaredType = declared?.replace(/;.*$/su, "").trim().toLowerCase();
  const responseType = received?.replace(/;.*$/su, "").trim().toLowerCase();
  // Discord attachment metadata may omit content_type. In that case the CDN
  // response must provide an allowed MIME type; no type is inferred from a URL.
  const contentType = declaredType ?? responseType;
  if (
    !contentType ||
    !isAllowedUploadType(contentType) ||
    (responseType !== undefined &&
      responseType !== "application/octet-stream" &&
      responseType !== contentType)
  ) {
    throw new DiscordFileFetchError(
      "invalid-attachment",
      "Discord returned an unsupported or mismatched attachment MIME type",
    );
  }
  return contentType;
}

interface DownloadedDiscordAttachment {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly contentType: string;
  readonly filename: string;
}

async function readAttachmentChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expectedSize: number,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await settle(reader.read());
    signal.throwIfAborted();
    if (!chunk.ok) {
      throw new DiscordFileFetchError(
        "download-failed",
        "Discord attachment download was interrupted",
      );
    }
    const { done, value } = chunk.value;
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > MAX_DISCORD_FILE_SIZE_BYTES || size > expectedSize) {
      throw new DiscordFileFetchError(
        "too-large",
        "Discord attachment body exceeds its allowed size",
      );
    }
    chunks.push(value);
  }
  if (size !== expectedSize) {
    throw new DiscordFileFetchError(
      "invalid-attachment",
      "Discord attachment body is incomplete",
    );
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function downloadAttachment(
  args: DiscordAttachmentDownload,
  signal: AbortSignal,
): Promise<DownloadedDiscordAttachment> {
  // Signed Discord CDN URLs carry their own short-lived authorization. Never
  // forward the bot credential or follow a redirect to another host.
  const fetched = await settle(
    fetch(args.url, {
      redirect: "manual",
      credentials: "omit",
      signal,
    }),
    signal,
  );
  if (!fetched.ok) {
    throw new DiscordFileFetchError(
      "download-failed",
      "Discord attachment download could not be completed",
    );
  }
  const response = fetched.value;
  if (!response.ok) {
    startUntrackedBestEffortCleanup(
      response.body?.cancel() ?? Promise.resolve(),
    );
    throw new DiscordFileFetchError(
      "download-failed",
      `Discord attachment download failed (${response.status})`,
      response.status,
    );
  }
  const contentType = attachmentContentType(
    args.contentType,
    response.headers.get("content-type"),
  );
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) !== args.size) {
    throw new DiscordFileFetchError(
      Number(length) > MAX_DISCORD_FILE_SIZE_BYTES
        ? "too-large"
        : "invalid-attachment",
      "Discord attachment length differs from its message metadata",
    );
  }
  if (!response.body) {
    throw new DiscordFileFetchError(
      "invalid-attachment",
      "Discord returned no attachment body",
    );
  }
  const reader = response.body.getReader();
  const result = await settleIncludingAbort(
    readAttachmentChunks(reader, args.size, signal),
  );
  if (!result.ok) {
    startUntrackedBestEffortCleanup(reader.cancel());
  }
  reader.releaseLock();
  if (!result.ok) {
    throw result.error;
  }
  return { bytes: result.value, contentType, filename: args.filename };
}

export async function fetchDiscordAttachment(
  args: DiscordAttachmentDownload,
  signal: AbortSignal,
): Promise<DownloadedDiscordAttachment> {
  validateAttachment(args);
  const controller = new AbortController();
  const downloadSignal = AbortSignal.any([
    signal,
    controller.signal,
    AbortSignal.timeout(10_000),
  ]);
  // Capture cancellation only to release the provider request, then propagate
  // the caller's cancellation before returning an HTTP result.
  const result = await settleIncludingAbort(
    downloadAttachment(args, downloadSignal),
  );
  const timedOut = downloadSignal.aborted && !signal.aborted;
  controller.abort();
  signal.throwIfAborted();
  if (timedOut) {
    throw new DiscordFileFetchError(
      "download-failed",
      "Discord attachment download timed out",
    );
  }
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}
