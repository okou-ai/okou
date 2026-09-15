import { command } from "ccstate";
import {
  MAX_PRESENTATION_TEMPLATE_PACKAGE_BYTES,
  MAX_PRESENTATION_TEMPLATE_PACKAGE_FILE_BYTES,
  MAX_PRESENTATION_TEMPLATE_PACKAGE_FILES,
  MAX_PRESENTATION_TEMPLATE_PAGE_BYTES,
  MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES,
  MAX_PRESENTATION_TEMPLATE_TOTAL_PAGE_BYTES,
  PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
  PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPES,
  REQUIRED_PRESENTATION_TEMPLATE_PACKAGE_FILES,
  type PublishPresentationTemplateBody,
} from "@okouai/api-contracts/contracts/presentation-templates";
import { getPresentationTemplateStorageName } from "@okouai/core/storage-names";
import { presentationTemplates } from "@okouai/db/schema/presentation-template";
import { gunzipSync } from "node:zlib";
import { Parser } from "tar";

import { badRequestMessage } from "../../lib/error";
import { createDeferredPromise, safeSync, settle } from "../utils";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { downloadS3BufferWithMaxBytes } from "../external/s3";
import { uploadedArtifactObject } from "./uploaded-artifact.service";
import { uploadVolumeServerSide$ } from "./storage-volume-upload.service";

interface ResolvedUpload {
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
const resolveUploads$ = command(
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

function checkSource(source: ResolvedUpload): string | null {
  const accepted: readonly string[] =
    PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPES;
  if (!accepted.includes(source.contentType)) {
    return `The source deck must be one of: ${accepted.join(", ")}`;
  }
  if (source.sizeBytes > MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES) {
    return `The source deck must be ${MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES.toString()} bytes or smaller`;
  }
  return null;
}

function checkPages(pages: readonly ResolvedUpload[]): string | null {
  const wrongType = pages.findIndex((page) => {
    return page.contentType !== PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE;
  });
  if (wrongType !== -1) {
    return `Page ${(wrongType + 1).toString()} must be a ${PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE}`;
  }
  const oversized = pages.findIndex((page) => {
    return page.sizeBytes > MAX_PRESENTATION_TEMPLATE_PAGE_BYTES;
  });
  if (oversized !== -1) {
    return `Page ${(oversized + 1).toString()} must be no larger than ${MAX_PRESENTATION_TEMPLATE_PAGE_BYTES.toString()} bytes`;
  }
  const total = pages.reduce((sum, page) => {
    return sum + page.sizeBytes;
  }, 0);
  if (total > MAX_PRESENTATION_TEMPLATE_TOTAL_PAGE_BYTES) {
    return `Page images must total ${MAX_PRESENTATION_TEMPLATE_TOTAL_PAGE_BYTES.toString()} bytes or fewer`;
  }
  return null;
}

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

function checkPackage(files: readonly PackageFile[]): string | null {
  if (files.length === 0) {
    return "The package archive is empty";
  }
  if (files.length > MAX_PRESENTATION_TEMPLATE_PACKAGE_FILES) {
    return `A package may contain at most ${MAX_PRESENTATION_TEMPLATE_PACKAGE_FILES.toString()} files`;
  }
  const unsafe = files.find((file) => {
    return unsafePackagePath(file.path);
  });
  if (unsafe) {
    return `Unsafe package path: ${unsafe.path}`;
  }
  const oversized = files.find((file) => {
    return file.content.length > MAX_PRESENTATION_TEMPLATE_PACKAGE_FILE_BYTES;
  });
  if (oversized) {
    return `Package file ${oversized.path} exceeds ${MAX_PRESENTATION_TEMPLATE_PACKAGE_FILE_BYTES.toString()} bytes`;
  }
  const paths = new Set(
    files.map((file) => {
      return file.path;
    }),
  );
  if (paths.size !== files.length) {
    return "The package contains duplicate paths";
  }
  const missing = REQUIRED_PRESENTATION_TEMPLATE_PACKAGE_FILES.find((path) => {
    return !paths.has(path);
  });
  if (missing) {
    return `The package must contain ${missing}`;
  }
  const empty = REQUIRED_PRESENTATION_TEMPLATE_PACKAGE_FILES.find((path) => {
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

type PublishResult =
  | { readonly kind: "published"; readonly templateId: string }
  | {
      readonly kind: "rejected";
      readonly response: ReturnType<typeof badRequestMessage>;
    };

function rejected(message: string): PublishResult {
  return { kind: "rejected", response: badRequestMessage(message) };
}

/**
 * Turn a finished analysis into a ready template.
 *
 * The row is created already `ready`: nothing exists before a package has been
 * validated, so a failed analysis leaves no half-built template behind — only
 * the chat thread that explains what happened.
 */
export const publishPresentationTemplate$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly ownerUserId: string;
      readonly body: PublishPresentationTemplateBody;
    },
    signal: AbortSignal,
  ): Promise<PublishResult> => {
    const db = set(writeDb$);
    const { body } = args;
    const ids = [body.sourceFileId, ...body.pageFileIds, body.packageFileId];
    const uploads = await set(
      resolveUploads$,
      { ownerUserId: args.ownerUserId, orgId: args.orgId, ids },
      signal,
    );
    signal.throwIfAborted();

    const missing = ids.find((id) => {
      return !uploads.has(id);
    });
    if (missing) {
      return rejected(`Uploaded file not found: ${missing}`);
    }
    // Non-null: every id was just proven present.
    const source = uploads.get(body.sourceFileId)!;
    const packageUpload = uploads.get(body.packageFileId)!;
    const pages = body.pageFileIds.map((id) => {
      return uploads.get(id)!;
    });

    const sourceError = checkSource(source);
    if (sourceError) {
      return rejected(sourceError);
    }
    const pageError = checkPages(pages);
    if (pageError) {
      return rejected(pageError);
    }
    if (packageUpload.sizeBytes > MAX_PRESENTATION_TEMPLATE_PACKAGE_BYTES) {
      return rejected(
        `The package must be ${MAX_PRESENTATION_TEMPLATE_PACKAGE_BYTES.toString()} bytes or smaller`,
      );
    }

    const bucket = packageUpload.bucket;
    const archive = await get(
      downloadS3BufferWithMaxBytes(
        bucket,
        packageUpload.storageKey,
        MAX_PRESENTATION_TEMPLATE_PACKAGE_BYTES,
        signal,
      ),
    );
    signal.throwIfAborted();

    // A caller-supplied archive is the one input here that can be malformed
    // rather than merely wrong, so gunzip and tar failures become a 400 instead
    // of propagating as a 500. The download cap bounds the compressed bytes
    // only, so the same cap is applied to the decompressed output: without it a
    // small archive could expand until it exhausted the API process.
    const decompressed = safeSync(() => {
      return gunzipSync(archive, {
        maxOutputLength: MAX_PRESENTATION_TEMPLATE_PACKAGE_BYTES,
      });
    });
    if ("error" in decompressed) {
      return rejected(
        isTooLargeDecompressed(decompressed.error)
          ? `The package must unpack to ${MAX_PRESENTATION_TEMPLATE_PACKAGE_BYTES.toString()} bytes or fewer`
          : "The package archive could not be read as a .tar.gz",
      );
    }
    const read = await settle(
      readPackageEntries(decompressed.ok, signal),
      signal,
    );
    signal.throwIfAborted();
    if (!read.ok) {
      return rejected("The package archive could not be read as a .tar.gz");
    }
    const packageError = checkPackage(read.value);
    if (packageError) {
      return rejected(packageError);
    }
    const files = read.value;

    const currentTime = nowDate();
    const [created] = await db
      .insert(presentationTemplates)
      .values({
        orgId: args.orgId,
        ownerUserId: args.ownerUserId,
        title: body.title,
        sourceStorageKey: source.storageKey,
        sourceFilename: source.filename,
        pageKeys: pages.map((page) => {
          return page.storageKey;
        }),
        createdBy: args.ownerUserId,
        updatedBy: args.ownerUserId,
        createdAt: currentTime,
        updatedAt: currentTime,
      })
      .returning();
    signal.throwIfAborted();
    if (!created) {
      throw new Error("Failed to create the presentation template");
    }

    // The package is stored under a name derived from the row id, so the
    // template needs no column pointing at it.
    await set(
      uploadVolumeServerSide$,
      {
        orgId: args.orgId,
        storageName: getPresentationTemplateStorageName(created.id),
        files: files.map((file) => {
          return { path: file.path, content: file.content };
        }),
      },
      signal,
    );
    signal.throwIfAborted();
    return { kind: "published", templateId: created.id };
  },
);
