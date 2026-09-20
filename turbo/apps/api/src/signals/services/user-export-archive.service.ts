import { createHash } from "node:crypto";
import { once } from "node:events";
import { addAbortSignal, Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { ZipArchive } from "archiver";
import { command } from "ccstate";
import {
  abortMultipartS3Upload,
  completeMultipartS3Upload,
  createMultipartS3Upload,
  uploadMultipartS3Part,
  type MultipartS3Part,
} from "../external/s3";
import { joinAll, onRejection, safeSync, settleIncludingAbort } from "../utils";

const ARCHIVE_CHUNK_BYTES = 64 * 1024;
const MULTIPART_PART_BYTES = 5 * 1024 * 1024;
const MULTIPART_MAX_PARTS = 10_000;
const MULTIPART_CLEANUP_TIMEOUT_MS = 10_000;

interface UserExportArchiveEntry {
  readonly path: string;
  readonly content: string | Buffer | AsyncIterable<string | Buffer>;
}

interface UserExportArchiveFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

async function* contentChunks(
  content: UserExportArchiveEntry["content"],
  signal: AbortSignal,
): AsyncGenerator<Buffer> {
  const chunks =
    typeof content === "string" || Buffer.isBuffer(content)
      ? [content]
      : content;
  for await (const chunk of chunks) {
    signal.throwIfAborted();
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    for (
      let offset = 0;
      offset < buffer.byteLength;
      offset += ARCHIVE_CHUNK_BYTES
    ) {
      signal.throwIfAborted();
      yield buffer.subarray(offset, offset + ARCHIVE_CHUNK_BYTES);
    }
  }
}

/** Keeps only the current entry and stream buffers while collecting file hashes. */
export class UserExportArchive {
  readonly output = new ZipArchive({
    highWaterMark: ARCHIVE_CHUNK_BYTES,
    zlib: { level: 6 },
  });

  private readonly completedFiles: UserExportArchiveFile[] = [];
  private readonly paths = new Set<string>();
  private activeSource: Readable | undefined;
  private failure: Error | undefined;
  private finalized = false;

  constructor() {
    this.output.on("error", (error: Error) => {
      this.abort(error);
    });
    this.output.on("warning", (error: Error) => {
      this.abort(error);
    });
  }

  get files(): readonly UserExportArchiveFile[] {
    return this.completedFiles;
  }

  abort(reason: unknown): void {
    if (this.failure) {
      return;
    }
    this.failure =
      reason instanceof Error
        ? reason
        : new Error("User export archive failed", { cause: reason });
    this.activeSource?.destroy(this.failure);
    this.output.abort();
    this.output.destroy(this.failure);
  }

  async append(
    entry: UserExportArchiveEntry,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    if (this.failure) {
      throw this.failure;
    }
    if (this.finalized || this.activeSource) {
      throw new Error(
        "User export entries must be written sequentially before finalization",
      );
    }
    if (
      entry.path.includes("\\") ||
      entry.path.includes("\0") ||
      /^[a-z]:/i.test(entry.path) ||
      entry.path.split("/").some((part) => {
        return part.length === 0 || part === "." || part === "..";
      }) ||
      this.paths.has(entry.path)
    ) {
      throw new Error(`Unsafe or duplicate user export path: ${entry.path}`);
    }
    this.paths.add(entry.path);
    const hash = createHash("sha256");
    let bytes = 0;
    const source = Readable.from(
      (async function* () {
        for await (const chunk of contentChunks(entry.content, signal)) {
          hash.update(chunk);
          bytes += chunk.byteLength;
          yield chunk;
        }
      })(),
      { objectMode: false, highWaterMark: ARCHIVE_CHUNK_BYTES },
    );
    this.activeSource = source;
    const fail = (error: unknown): void => {
      this.abort(error);
    };
    const completed = onRejection(once(this.output, "entry", { signal }), fail);
    const consumed = onRejection(finished(source, { cleanup: true }), fail);
    const enqueued = safeSync(() => {
      this.output.append(source, { name: entry.path });
    });
    if ("error" in enqueued) {
      this.abort(enqueued.error);
    }
    const result = await settleIncludingAbort(joinAll([completed, consumed]));
    this.activeSource = undefined;
    if (!result.ok) {
      throw result.error;
    }
    signal.throwIfAborted();
    this.completedFiles.push({
      path: entry.path,
      bytes,
      sha256: hash.digest("hex"),
    });
  }

  async finalize(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.failure) {
      throw this.failure;
    }
    if (this.finalized || this.activeSource) {
      throw new Error(
        "User export archive is already finalized or has an active entry",
      );
    }
    this.finalized = true;
    // Archiver's finalize promise can remain pending after abort(). The output
    // stream's terminal state also observes failure and releases the writer.
    const terminal = finished(this.output, { cleanup: true, signal });
    await onRejection(
      Promise.race([this.output.finalize(), terminal]),
      (error) => {
        this.abort(error);
      },
    );
    signal.throwIfAborted();
  }
}

/** Joins generation and upload so neither branch survives a failed export. */
export const uploadUserExportArchive$ = command(
  async (
    { get },
    args: {
      readonly bucket: string;
      readonly key: string;
      readonly archive: UserExportArchive;
      readonly writing: Promise<void>;
    },
    signal: AbortSignal,
  ): Promise<number> => {
    const { archive } = args;
    addAbortSignal(signal, archive.output);
    let uploadId: string | undefined;
    let completed = false;
    const fail = (error: unknown): void => {
      archive.abort(error);
    };
    const writing = onRejection(args.writing, fail);
    const uploading = onRejection(
      (async (): Promise<number> => {
        signal.throwIfAborted();
        uploadId = await get(
          createMultipartS3Upload(
            args.bucket,
            args.key,
            "application/zip",
            undefined,
            signal,
          ),
        );
        signal.throwIfAborted();
        const parts: MultipartS3Part[] = [];
        let buffer = Buffer.allocUnsafe(MULTIPART_PART_BYTES);
        let bufferedBytes = 0;
        let totalBytes = 0;
        const uploadBuffered = async (): Promise<void> => {
          if (bufferedBytes === 0) {
            return;
          }
          if (parts.length === MULTIPART_MAX_PARTS || !uploadId) {
            throw new Error("User export exceeded the multipart upload limit");
          }
          const part = await get(
            uploadMultipartS3Part(
              {
                bucket: args.bucket,
                key: args.key,
                uploadId,
                partNumber: parts.length + 1,
                body: buffer.subarray(0, bufferedBytes),
              },
              signal,
            ),
          );
          signal.throwIfAborted();
          parts.push(part);
          buffer = Buffer.allocUnsafe(MULTIPART_PART_BYTES);
          bufferedBytes = 0;
        };
        for await (const chunk of archive.output as AsyncIterable<unknown>) {
          signal.throwIfAborted();
          if (!Buffer.isBuffer(chunk)) {
            throw new Error("User export archive emitted a non-buffer chunk");
          }
          for (let offset = 0; offset < chunk.byteLength; ) {
            const length = Math.min(
              MULTIPART_PART_BYTES - bufferedBytes,
              chunk.byteLength - offset,
            );
            chunk.copy(buffer, bufferedBytes, offset, offset + length);
            offset += length;
            bufferedBytes += length;
            totalBytes += length;
            if (bufferedBytes === MULTIPART_PART_BYTES) {
              await uploadBuffered();
            }
          }
        }
        await writing;
        signal.throwIfAborted();
        await uploadBuffered();
        signal.throwIfAborted();
        await get(
          completeMultipartS3Upload(
            args.bucket,
            args.key,
            uploadId,
            parts,
            signal,
          ),
        );
        completed = true;
        signal.throwIfAborted();
        return totalBytes;
      })(),
      fail,
    );
    const [, archiveBytes] = await onRejection(
      joinAll([writing, uploading]),
      async () => {
        if (uploadId && !completed) {
          await settleIncludingAbort(
            get(
              abortMultipartS3Upload(
                args.bucket,
                args.key,
                uploadId,
                AbortSignal.timeout(MULTIPART_CLEANUP_TIMEOUT_MS),
              ),
            ),
          );
        }
      },
    );
    signal.throwIfAborted();
    return archiveBytes;
  },
);
