import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  computeContentHashFromHashes,
  hashFileContent,
  type FileEntryWithHash,
} from "@okouai/api-contracts/contracts/storage-content-hash";
import { VOLUME_ORG_USER_ID } from "@okouai/core/storage-names";
import type { PiResourceVersionIndex } from "@okouai/db/jsonb-contracts/pi-resource-version-index";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { create } from "tar";

import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { preparePiResourceIndex } from "../../lib/pi-resource-index";
import {
  enqueuePiResourceVersionIndexes,
  publishPiResourceVersionIndex,
  readPiResourceVersionIndexes,
} from "./pi-resource-version-index.service";
import { writeDb$, type Db } from "../external/db";
import { putS3Object } from "../external/s3";
import { onRejection } from "../utils";
import { newStorageS3Location } from "./storage-s3-prefix.utils";
import {
  registerPreparedStorageVersions,
  storageVersionMatches,
  StorageVersionIdentityConflictError,
  type PreparedStorageVersion,
} from "./storage-version-registration.service";

const SERVER_SIDE_STORAGE_VERSION_CREATOR = "user";

interface VolumeFileInput {
  readonly path: string;
  /** Buffer for binary payloads such as logos, fonts, and page images. */
  readonly content: string | Buffer;
}

export interface PrepareVolumeServerSideInput {
  readonly orgId: string;
  readonly storageName: string;
  readonly files: readonly VolumeFileInput[];
  readonly piResourceIndex?: true;
  /** An explicitly owned generation, either already reserved or private and
   * unregistered. The caller revalidates/creates its parent before publication;
   * preparation must not resolve a different canonical parent. */
  readonly storage?: ServerSideVolumeStorage;
}

export interface PreparedServerSideVolume {
  readonly storageName: string;
  readonly version: PreparedStorageVersion;
  readonly updatedAt: Date;
  readonly piResourceIndex?:
    | {
        readonly kind: "prepared";
        readonly projection: PiResourceVersionIndex | undefined;
      }
    | { readonly kind: "reused" };
}

export interface ServerSideVolumeStorage {
  readonly id: string;
  readonly s3Prefix: string;
}

interface PrepareVolumeServerSideWithDbInput {
  readonly db: Db;
  readonly input: PrepareVolumeServerSideInput;
}

interface S3StorageManifest {
  readonly version: string;
  readonly createdAt: string;
  readonly totalSize: number;
  readonly fileCount: number;
  readonly files: readonly FileEntryWithHash[];
}

interface MaterializedVolumeFile extends FileEntryWithHash {
  readonly content: Buffer;
}

async function bufferFromStream(
  stream: AsyncIterable<Uint8Array>,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function compareArchiveFiles(
  left: MaterializedVolumeFile,
  right: MaterializedVolumeFile,
): number {
  if (left.path < right.path) {
    return -1;
  }
  if (left.path > right.path) {
    return 1;
  }
  if (left.hash < right.hash) {
    return -1;
  }
  if (left.hash > right.hash) {
    return 1;
  }
  return 0;
}

function materializeFiles(
  files: readonly VolumeFileInput[],
): readonly MaterializedVolumeFile[] {
  const validationRoot = resolve(tmpdir(), "api-volume-validation");
  return files.map((file) => {
    resolveVolumeFilePath(validationRoot, file.path);
    const content = Buffer.isBuffer(file.content)
      ? file.content
      : Buffer.from(file.content, "utf8");
    return {
      path: file.path,
      content,
      hash: hashFileContent(content),
      size: content.length,
    };
  });
}

function resolveVolumeFilePath(root: string, path: string): string {
  const filePath = resolve(join(root, path));
  const relativePath = relative(root, filePath);
  if (
    isAbsolute(path) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Invalid file path: ${path}`);
  }
  return filePath;
}

function writeFilesToDirectory(
  tmpDir: string,
  files: readonly MaterializedVolumeFile[],
): void {
  for (const file of files) {
    const filePath = resolveVolumeFilePath(tmpDir, file.path);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, file.content);
    // `tar` portable mode retains file permissions, so canonicalize them.
    chmodSync(filePath, 0o644);
  }
}

function createArchiveBuffer(
  tmpDir: string,
  files: readonly MaterializedVolumeFile[],
): Promise<Buffer> {
  return bufferFromStream(
    create(
      {
        gzip: { portable: true },
        portable: true,
        mtime: new Date(0),
        cwd: tmpDir,
      },
      files.map((file) => {
        return file.path;
      }),
    ),
  );
}

async function buildVolumeArchive(
  tmpDir: string,
  files: readonly MaterializedVolumeFile[],
  signal: AbortSignal,
): Promise<Buffer> {
  signal.throwIfAborted();
  writeFilesToDirectory(tmpDir, files);
  const archiveBuffer = await createArchiveBuffer(tmpDir, files);
  signal.throwIfAborted();
  return archiveBuffer;
}

async function createVolumeArchive(
  files: readonly MaterializedVolumeFile[],
  signal: AbortSignal,
): Promise<Buffer> {
  const archiveFiles = [...files].sort(compareArchiveFiles);
  const tmpDir = await mkdtemp(join(tmpdir(), "api-volume-"));
  const archiveBuffer = await onRejection(
    buildVolumeArchive(tmpDir, archiveFiles, signal),
    () => {
      rmSync(tmpDir, { recursive: true, force: true });
    },
  );
  rmSync(tmpDir, { recursive: true, force: true });
  return archiveBuffer;
}

const uploadVolumeObjects$ = command(
  async (
    { get },
    args: {
      readonly bucketName: string;
      readonly s3Key: string;
      readonly archiveBuffer: Buffer;
      readonly manifest: S3StorageManifest;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const uploadResults = await Promise.allSettled([
      get(
        putS3Object(
          args.bucketName,
          `${args.s3Key}/archive.tar.gz`,
          args.archiveBuffer,
          "application/gzip",
          signal,
        ),
      ),
      get(
        putS3Object(
          args.bucketName,
          `${args.s3Key}/manifest.json`,
          JSON.stringify(args.manifest),
          "application/json",
          signal,
        ),
      ),
    ]);
    signal.throwIfAborted();
    for (const uploadResult of uploadResults) {
      if (uploadResult.status === "rejected") {
        throw uploadResult.reason;
      }
    }
  },
);

async function readStorageVersion(
  db: Db,
  versionId: string,
  signal: AbortSignal,
): Promise<PreparedStorageVersion | undefined> {
  const [version] = await db
    .select({
      storageId: storageVersions.storageId,
      versionId: storageVersions.id,
      s3Key: storageVersions.s3Key,
      size: storageVersions.size,
      archiveSize: storageVersions.archiveSize,
      fileCount: storageVersions.fileCount,
      message: storageVersions.message,
      createdBy: storageVersions.createdBy,
    })
    .from(storageVersions)
    .where(eq(storageVersions.id, versionId))
    .limit(1);
  signal.throwIfAborted();
  return version;
}

function assertServerSideVersionIdentity(
  stored: PreparedStorageVersion,
  expected: Omit<PreparedStorageVersion, "archiveSize">,
): void {
  if (
    !storageVersionMatches(stored, {
      ...expected,
      archiveSize: stored.archiveSize,
    })
  ) {
    throw new StorageVersionIdentityConflictError(expected.versionId);
  }
}

/** DB-only container reservation; callers own any required publication locks. */
export async function resolveCanonicalVolumeStorage(
  db: Db,
  args: { readonly orgId: string; readonly storageName: string },
  signal: AbortSignal,
): Promise<ServerSideVolumeStorage> {
  const { storageId, s3Prefix } = newStorageS3Location(args.orgId);
  await db
    .insert(storages)
    .values({
      id: storageId,
      userId: VOLUME_ORG_USER_ID,
      orgId: args.orgId,
      name: args.storageName,
      s3Prefix,
      size: 0,
      fileCount: 0,
    })
    .onConflictDoNothing();
  signal.throwIfAborted();

  const [storage] = await db
    .select({ id: storages.id, s3Prefix: storages.s3Prefix })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, args.orgId),
        eq(storages.userId, VOLUME_ORG_USER_ID),
        eq(storages.name, args.storageName),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!storage) {
    throw new Error(`Failed to create storage for ${args.storageName}`);
  }
  return storage;
}

export const prepareVolumeServerSideWithDb$ = command(
  async (
    { set },
    args: PrepareVolumeServerSideWithDbInput,
    signal: AbortSignal,
  ): Promise<PreparedServerSideVolume> => {
    const input = args.input;
    const writeDb = args.db;
    const files = materializeFiles(input.files);
    const totalSize = files.reduce((sum, file) => {
      return sum + file.size;
    }, 0);
    const fileEntries = files.map((file) => {
      return {
        path: file.path,
        hash: file.hash,
        size: file.size,
      };
    });
    const updatedAt = nowDate();
    const storage =
      input.storage ??
      (await resolveCanonicalVolumeStorage(writeDb, input, signal));

    const versionId = computeContentHashFromHashes(storage.id, fileEntries);
    const s3Key = `${storage.s3Prefix}/${versionId}`;
    const expectedVersion: Omit<PreparedStorageVersion, "archiveSize"> = {
      storageId: storage.id,
      versionId,
      s3Key,
      size: totalSize,
      fileCount: files.length,
      message: null,
      createdBy: SERVER_SIDE_STORAGE_VERSION_CREATOR,
    };
    const existing = await readStorageVersion(writeDb, versionId, signal);
    if (existing) {
      assertServerSideVersionIdentity(existing, expectedVersion);
      if (input.piResourceIndex) {
        const { indexes } = await readPiResourceVersionIndexes(
          writeDb,
          [versionId],
          signal,
        );
        const indexed = indexes.get(versionId);
        if (indexed && indexed.storageId !== storage.id) {
          throw new StorageVersionIdentityConflictError(versionId);
        }
        if (indexed) {
          return {
            storageName: input.storageName,
            version: existing,
            updatedAt,
            piResourceIndex: { kind: "reused" },
          };
        }
      } else {
        return { storageName: input.storageName, version: existing, updatedAt };
      }
    }

    // Misses still use the published encoder: normalized/duplicate paths and
    // archive limits cannot be reproduced by indexing the raw input files.
    const archiveBuffer = await createVolumeArchive(files, signal);
    const piResourceIndex = input.piResourceIndex
      ? {
          kind: "prepared" as const,
          projection: preparePiResourceIndex(archiveBuffer),
        }
      : undefined;
    if (existing) {
      return {
        storageName: input.storageName,
        version: existing,
        updatedAt,
        piResourceIndex,
      };
    }

    const bucketName = env("R2_USER_STORAGES_BUCKET_NAME");
    const manifest: S3StorageManifest = {
      version: versionId,
      createdAt: updatedAt.toISOString(),
      totalSize,
      fileCount: files.length,
      files: fileEntries,
    };
    await set(
      uploadVolumeObjects$,
      {
        bucketName,
        s3Key,
        archiveBuffer,
        manifest,
      },
      signal,
    );

    return {
      storageName: input.storageName,
      version: { ...expectedVersion, archiveSize: archiveBuffer.length },
      updatedAt,
      piResourceIndex,
    };
  },
);

export const prepareVolumeServerSide$ = command(
  async (
    { set },
    args: PrepareVolumeServerSideInput,
    signal: AbortSignal,
  ): Promise<PreparedServerSideVolume> => {
    const writeDb = set(writeDb$);
    return await set(
      prepareVolumeServerSideWithDb$,
      { db: writeDb, input: args },
      signal,
    );
  },
);

export async function commitPreparedVolumeServerSide(
  args: {
    readonly db: Db;
    readonly volume: PreparedServerSideVolume;
  },
  signal: AbortSignal,
): Promise<void> {
  await registerPreparedStorageVersions(
    { db: args.db, versions: [args.volume.version] },
    signal,
  );
  await args.db
    .update(storages)
    .set({
      headVersionId: args.volume.version.versionId,
      size: args.volume.version.size,
      fileCount: args.volume.version.fileCount,
      updatedAt: args.volume.updatedAt,
    })
    .where(eq(storages.id, args.volume.version.storageId));
  signal.throwIfAborted();
  // Keep Storage-before-index lock ordering across all publication paths. Both
  // references become visible together when the caller commits its transaction.
  // Reused ready indexes are already durable: do not rewrite them or interfere
  // with index ownership. The registered version was revalidated above.
  if (args.volume.piResourceIndex?.kind === "prepared") {
    await publishPiResourceVersionIndex(
      {
        db: args.db,
        versionId: args.volume.version.versionId,
        projection: args.volume.piResourceIndex.projection,
        archiveSize: args.volume.version.archiveSize,
      },
      signal,
    );
  } else if (!args.volume.piResourceIndex) {
    await enqueuePiResourceVersionIndexes(
      args.db,
      [args.volume.version.versionId],
      signal,
    );
  }
}
