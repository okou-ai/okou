import { command } from "ccstate";
import { gunzipSync } from "node:zlib";
import { Parser } from "tar";

import { createDeferredPromise, safeSync, settle } from "../utils";
import { downloadS3BufferWithMaxBytes } from "../external/s3";
import { uploadedArtifactObject } from "./uploaded-artifact.service";

/**
 * The parts of publishing a compiled template that do not depend on what the
 * template produces: resolving the run's own uploads, and turning its package
 * archive into validated files.
 *
 * Presentation templates and user templates both receive a `.tar.gz` of
 * guidance from a reverse run, so this owns the archive's safety rules once.
 * What differs between them — accepted source types, size ceilings, required
 * package entries — arrives as arguments rather than being hard-coded here.
 */
export interface ResolvedUpload {
  readonly bucket: string;
  readonly id: string;
  readonly storageKey: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

interface PackageFile {
  readonly path: string;
  readonly content: Buffer;
}

/**
 * Resolve the caller's own uploads, the same way `/uploads/complete` does: an
 * id resolves to an object only when that object's stored metadata names this
 * user. Ownership is therefore never taken from the request body, and this
 * works for browser and run uploads, including private ownership records and
 * historical public objects without a `run_uploaded_files` row.
 */
export const resolveTemplateUploads$ = command(
  async (
    { get },
    args: {
      readonly ownerUserId: string;
      readonly orgId: string;
      readonly ids: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, ResolvedUpload>> => {
    const resolved = new Map<string, ResolvedUpload>();
    for (const id of new Set(args.ids)) {
      const object = await get(
        uploadedArtifactObject({
          userId: args.ownerUserId,
          orgId: args.orgId,
          id,
        }),
      );
      signal.throwIfAborted();
      if (object) {
        resolved.set(id, {
          bucket: object.bucket,
          id,
          storageKey: object.key,
          filename: object.filename,
          contentType: object.contentType,
          sizeBytes: object.size,
        });
      }
    }
    return resolved;
  },
);

/**
 * `maxOutputLength` stops zlib at the cap instead of letting a small archive
 * expand toward the process memory limit, and it reports that stop as
 * `ERR_BUFFER_TOO_LARGE` rather than as a corrupt-archive error.
 */
function isTooLargeDecompressed(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ERR_BUFFER_TOO_LARGE"
  );
}

/**
 * A package path has to be a plain relative file path. Anything that could
 * escape the extraction root, or that is not a regular file, is rejected rather
 * than sanitised, so a rejected package is obvious instead of quietly reshaped.
 */
function unsafePackagePath(path: string): boolean {
  return (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => {
      return segment === "" || segment === "." || segment === "..";
    })
  );
}

function readPackageEntries(
  archive: Buffer,
  signal: AbortSignal,
): Promise<readonly PackageFile[]> {
  const files: PackageFile[] = [];
  const deferred = createDeferredPromise<readonly PackageFile[]>(signal);
  const parser = new Parser({
    onReadEntry: (entry) => {
      if (entry.type !== "File") {
        // Directories carry no content, and links are how an archive escapes
        // its root; neither belongs in a guidance package.
        entry.resume();
        return;
      }
      const chunks: Buffer[] = [];
      entry.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      entry.on("end", () => {
        files.push({ path: entry.path, content: Buffer.concat(chunks) });
      });
    },
  });
  parser.on("end", () => {
    if (!deferred.settled()) {
      deferred.resolve(files);
    }
  });
  parser.on("error", (error) => {
    if (!deferred.settled()) {
      deferred.reject(error);
    }
  });
  parser.write(archive);
  parser.end();
  return deferred.promise;
}

export interface TemplatePackageLimits {
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly requiredPaths: readonly string[];
}

function checkPackage(
  files: readonly PackageFile[],
  limits: TemplatePackageLimits,
): string | null {
  if (files.length === 0) {
    return "The package archive is empty";
  }
  if (files.length > limits.maxFiles) {
    return `A package may contain at most ${limits.maxFiles.toString()} files`;
  }
  const unsafe = files.find((file) => {
    return unsafePackagePath(file.path);
  });
  if (unsafe) {
    return `Unsafe package path: ${unsafe.path}`;
  }
  const oversized = files.find((file) => {
    return file.content.length > limits.maxFileBytes;
  });
  if (oversized) {
    return `Package file ${oversized.path} exceeds ${limits.maxFileBytes.toString()} bytes`;
  }
  const paths = new Set(
    files.map((file) => {
      return file.path;
    }),
  );
  if (paths.size !== files.length) {
    return "The package contains duplicate paths";
  }
  const missing = limits.requiredPaths.find((path) => {
    return !paths.has(path);
  });
  if (missing) {
    return `The package must contain ${missing}`;
  }
  const empty = limits.requiredPaths.find((path) => {
    const file = files.find((candidate) => {
      return candidate.path === path;
    });
    return file !== undefined && file.content.toString("utf8").trim() === "";
  });
  if (empty) {
    return `${empty} must not be empty`;
  }
  return null;
}

type TemplatePackageResult =
  | { readonly kind: "files"; readonly files: readonly PackageFile[] }
  | { readonly kind: "rejected"; readonly message: string };

/**
 * Download, decompress and validate one package archive.
 *
 * A caller-supplied archive is the one input that can be malformed rather than
 * merely wrong, so gunzip and tar failures come back as a rejection message for
 * the caller to turn into a 400 instead of propagating as a 500. The download
 * cap bounds the compressed bytes only, so the same cap is applied to the
 * decompressed output: without it a small archive could expand until it
 * exhausted the API process.
 */
export const loadTemplatePackage$ = command(
  async (
    { get },
    args: {
      readonly upload: ResolvedUpload;
      readonly limits: TemplatePackageLimits;
    },
    signal: AbortSignal,
  ): Promise<TemplatePackageResult> => {
    const { upload, limits } = args;
    if (upload.sizeBytes > limits.maxBytes) {
      return {
        kind: "rejected",
        message: `The package must be ${limits.maxBytes.toString()} bytes or smaller`,
      };
    }
    const archive = await get(
      downloadS3BufferWithMaxBytes(
        upload.bucket,
        upload.storageKey,
        limits.maxBytes,
        signal,
      ),
    );
    signal.throwIfAborted();
    const decompressed = safeSync(() => {
      return gunzipSync(archive, { maxOutputLength: limits.maxBytes });
    });
    if ("error" in decompressed) {
      return {
        kind: "rejected",
        message: isTooLargeDecompressed(decompressed.error)
          ? `The package must unpack to ${limits.maxBytes.toString()} bytes or fewer`
          : "The package archive could not be read as a .tar.gz",
      };
    }
    const read = await settle(
      readPackageEntries(decompressed.ok, signal),
      signal,
    );
    signal.throwIfAborted();
    if (!read.ok) {
      return {
        kind: "rejected",
        message: "The package archive could not be read as a .tar.gz",
      };
    }
    const packageError = checkPackage(read.value, limits);
    return packageError === null
      ? { kind: "files", files: read.value }
      : { kind: "rejected", message: packageError };
  },
);
