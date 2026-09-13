import { createHash } from "node:crypto";
import {
  ZipReader,
  Uint8ArrayReader,
  type FileEntry,
} from "@zip.js/zip.js/index-native.js";
import { command } from "ccstate";
import {
  MAX_INTRO_VIDEO_PROJECT_BYTES,
  type IntroVideoRenderRequest,
} from "@okouai/api-contracts/contracts/intro-video-render";
import { settleIncludingAbort } from "../utils";
import { env } from "../../lib/env";
import {
  downloadS3BufferWithMaxBytes,
  generatePresignedGetUrl,
  putImmutableS3Object,
} from "../external/s3";
import { uploadedArtifactObject } from "./uploaded-artifact.service";

export class IntroVideoProjectError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 404 | 413 = 400,
  ) {
    super(message);
    this.name = "IntroVideoProjectError";
  }
}

function unsafeArchivePath(path: string): boolean {
  return (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes(":") ||
    path.includes("\0") ||
    path.split("/").some((part) => {
      return !part || part === ".." || part === ".";
    })
  );
}

async function validateArchive(
  reader: ZipReader<Uint8Array>,
  composition: string,
  aspectRatio: IntroVideoRenderRequest["output"]["aspectRatio"],
  signal: AbortSignal,
): Promise<void> {
  const names = new Set<string>();
  let expandedSize = 0;
  let selected: FileEntry | undefined;
  for await (const entry of reader.getEntriesGenerator()) {
    signal.throwIfAborted();
    const path = entry.filename.replace(/\/$/, "");
    if (
      unsafeArchivePath(path) ||
      names.has(path) ||
      entry.encrypted ||
      entry.symlink
    ) {
      throw new Error("Unsafe archive entry");
    }
    names.add(path);
    expandedSize += entry.uncompressedSize;
    if (names.size > 10_000 || expandedSize > 1024 * 1024 * 1024) {
      throw new Error("Project exceeds 10,000 entries or 1 GiB expanded size");
    }
    if (entry.filename === composition && !entry.directory) {
      selected = entry;
    }
  }
  if (!selected || selected.uncompressedSize > 1024 * 1024) {
    throw new Error("Missing or oversized HTML entry");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  await selected.getData(
    new WritableStream<Uint8Array>({
      write(chunk) {
        size += chunk.byteLength;
        if (size > 1024 * 1024) {
          throw new Error("HTML entry exceeds 1 MiB");
        }
        chunks.push(chunk);
      },
    }),
    { signal, checkSignature: true },
  );
  const html = Buffer.concat(chunks).toString("utf8");
  if (size !== selected.uncompressedSize || !html.trim()) {
    throw new Error("Empty or invalid HTML entry");
  }
  const width = Number(/data-width\s*=\s*["']([0-9]+)["']/i.exec(html)?.[1]);
  const height = Number(/data-height\s*=\s*["']([0-9]+)["']/i.exec(html)?.[1]);
  const ratio = width / height;
  const expected = aspectRatio === "16:9" ? 16 / 9 : 9 / 16;
  if (!Number.isFinite(ratio) || Math.abs(ratio - expected) >= 0.01) {
    throw new Error(
      "Composition dimensions must match the output aspect ratio",
    );
  }
}

async function validateProject(
  bytes: Buffer,
  composition: string,
  aspectRatio: IntroVideoRenderRequest["output"]["aspectRatio"],
  signal: AbortSignal,
): Promise<void> {
  if (bytes.byteLength > MAX_INTRO_VIDEO_PROJECT_BYTES) {
    throw new IntroVideoProjectError(
      "PROJECT_TOO_LARGE",
      "Project ZIP must be at most 200 MiB",
      413,
    );
  }
  const reader = new ZipReader(new Uint8ArrayReader(bytes), {
    useWebWorkers: false,
    useCompressionStream: true,
    strictness: "strict",
  });
  const validated = await settleIncludingAbort(
    validateArchive(reader, composition, aspectRatio, signal),
  );
  await reader.close();
  signal.throwIfAborted();
  if (!validated.ok) {
    throw new IntroVideoProjectError(
      "INVALID_RENDER_PROJECT",
      validated.error instanceof Error
        ? validated.error.message
        : "Invalid project ZIP",
    );
  }
}

export const prepareIntroVideoRenderProject$ = command(
  async (
    { get },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly projectFileId: string;
      readonly generationId: string;
      readonly composition: string;
      readonly aspectRatio: IntroVideoRenderRequest["output"]["aspectRatio"];
    },
    signal: AbortSignal,
  ) => {
    const object = await get(
      uploadedArtifactObject({
        id: args.projectFileId,
        userId: args.userId,
        orgId: args.orgId,
      }),
    );
    signal.throwIfAborted();
    if (!object) {
      throw new IntroVideoProjectError(
        "NOT_FOUND",
        "Project file not found",
        404,
      );
    }
    if (object.size > MAX_INTRO_VIDEO_PROJECT_BYTES) {
      throw new IntroVideoProjectError(
        "PROJECT_TOO_LARGE",
        "Project ZIP must be at most 200 MiB",
        413,
      );
    }
    if (
      !["application/zip", "application/x-zip-compressed"].includes(
        object.contentType,
      )
    ) {
      throw new IntroVideoProjectError(
        "INVALID_RENDER_PROJECT",
        "Upload a project ZIP to Okou first",
      );
    }
    const bytes = await get(
      downloadS3BufferWithMaxBytes(
        object.bucket,
        object.key,
        MAX_INTRO_VIDEO_PROJECT_BYTES,
        signal,
      ),
    );
    signal.throwIfAborted();
    await validateProject(bytes, args.composition, args.aspectRatio, signal);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const bucket = env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME");
    if (!bucket || bucket === env("R2_USER_ARTIFACTS_BUCKET_NAME")) {
      throw new Error("Private render input storage is not configured");
    }
    const key = `intro-video-render-inputs/${args.generationId}/${digest}.zip`;
    await get(
      putImmutableS3Object(bucket, key, bytes, "application/zip", signal),
    );
    signal.throwIfAborted();
    const url = await get(
      generatePresignedGetUrl(bucket, key, 26 * 60 * 60, undefined, true),
    );
    signal.throwIfAborted();
    return { digest, key, url };
  },
);
