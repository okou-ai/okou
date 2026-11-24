import {
  ZipReader,
  type CreateReadableOptions,
  type FileEntry,
  type Reader,
} from "@zip.js/zip.js/lib/zip-core-reader.js";
import { getMimeType } from "@zip.js/zip.js/mime-types";
import {
  classifyChatAttachment,
  type BodyPreviewKind,
} from "../signals/chat-page/parse-body-blocks.ts";
import { isTextPreviewKind } from "../signals/text-preview.ts";
import { fetchResource } from "./resource-fetch.ts";

const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 1024;

type ZipEntryKind = Exclude<BodyPreviewKind, "html" | "file">;

export interface ZipArtifactEntry {
  readonly path: string;
  readonly preview: {
    readonly kind: ZipEntryKind;
    readonly read: (signal: AbortSignal) => Promise<Blob>;
  } | null;
}

export function isZipArtifact(filename: string, contentType?: string): boolean {
  const type = contentType?.split(";")[0]?.trim().toLowerCase();
  return (
    type === "application/zip" ||
    type === "application/x-zip-compressed" ||
    ((!type || type === "application/octet-stream") &&
      /\.zip$/iu.test(filename))
  );
}

async function readArchiveBody(
  response: Response,
  signal: AbortSignal,
): Promise<Blob> {
  const size = Number(response.headers.get("content-length"));
  if (!response.ok || !response.body || size > MAX_ARCHIVE_BYTES) {
    await response.body?.cancel();
    throw new Error("ZIP artifact is unavailable or exceeds its preview limit");
  }
  let bytes = 0;
  const bounded = response.body.pipeThrough(
    new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
      transform(chunk, controller) {
        signal.throwIfAborted();
        bytes += chunk.byteLength;
        if (bytes > MAX_ARCHIVE_BYTES) {
          throw new Error("ZIP artifact exceeds its preview limit");
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(bounded).blob();
}

async function readFileEntry(
  entry: FileEntry,
  type: string,
  signal: AbortSignal,
): Promise<Blob> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  const writable = new WritableStream<Uint8Array<ArrayBuffer>>({
    write(chunk) {
      signal.throwIfAborted();
      bytes += chunk.byteLength;
      if (bytes > MAX_ENTRY_BYTES || bytes > entry.uncompressedSize) {
        throw new Error("ZIP entry exceeds its preview limit");
      }
      chunks.push(chunk);
    },
  });
  await entry.getData(writable, { checkCrc32: true, signal });
  signal.throwIfAborted();
  if (bytes !== entry.uncompressedSize) {
    throw new Error("ZIP entry size mismatch");
  }
  return new Blob(chunks, { type });
}

function previewForEntry(entry: FileEntry): ZipArtifactEntry["preview"] {
  const fileType = (entry.unixMode ?? 0) & 0xf0_00;
  if (
    entry.encrypted ||
    entry.symlink ||
    (fileType !== 0 && fileType !== 0x80_00) ||
    (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) ||
    entry.uncompressedSize > MAX_ENTRY_BYTES
  ) {
    return null;
  }
  const filename = entry.filename.split("/").at(-1) ?? "";
  const kind = classifyChatAttachment({ filename });
  const type = getMimeType(filename);
  if (
    // SVG blobs can execute as top-level documents on the app's origin.
    /\.(?:svg|heic|heif)$/iu.test(filename) ||
    !(
      isTextPreviewKind(kind) ||
      (kind === "pdf" && type === "application/pdf") ||
      ((kind === "image" || kind === "audio" || kind === "video") &&
        type.startsWith(`${kind}/`))
    )
  ) {
    return null;
  }
  return {
    kind,
    read: (signal) => {
      return readFileEntry(entry, type, signal);
    },
  };
}

export async function readZipArtifact(
  url: string,
  size: number | undefined,
  signal: AbortSignal,
): Promise<readonly ZipArtifactEntry[]> {
  if (size !== undefined && size > MAX_ARCHIVE_BYTES) {
    throw new Error("ZIP artifact exceeds its preview limit");
  }
  const response = await fetchResource(url, {}, signal);
  const archive = await readArchiveBody(response, signal);
  signal.throwIfAborted();
  const reader = new ZipReader(archiveReader(archive), {
    strictness: "strict",
    useWebWorkers: false,
  });
  const entries: ZipArtifactEntry[] = [];
  let count = 0;
  for await (const entry of reader.getEntriesGenerator()) {
    signal.throwIfAborted();
    if (++count > MAX_ENTRIES) {
      throw new Error("ZIP artifact contains too many entries");
    }
    if (!entry.directory) {
      entries.push({ path: entry.filename, preview: previewForEntry(entry) });
    }
  }
  return entries;
}

function archiveReader(archive: Blob): Reader<Blob> {
  return {
    size: archive.size,
    get readable() {
      return archive.stream();
    },
    createReadable({
      offset = 0,
      size = archive.size - offset,
    }: CreateReadableOptions = {}) {
      return archive.slice(offset, offset + size).stream();
    },
    async readUint8Array(offset, length) {
      return new Uint8Array(
        await archive.slice(offset, offset + length).arrayBuffer(),
      );
    },
  };
}
