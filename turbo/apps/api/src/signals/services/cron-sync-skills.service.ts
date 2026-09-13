import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import {
  DEFAULT_SKILLS_BRANCH,
  DEFAULT_SKILLS_OWNER,
  DEFAULT_SKILLS_REPO,
  resolveSkillRef,
} from "@okouai/core/github-url";
import {
  parseSkillFrontmatter,
  type SkillFrontmatter,
} from "@okouai/core/skill-frontmatter";
import {
  getSkillStorageName,
  SYSTEM_ORG_ID,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { SEED_SKILLS } from "@okouai/core/seed-skills";
import { skills } from "@okouai/db/schema/skill";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { command, computed, type Computed } from "ccstate";
import { eq, inArray, like } from "drizzle-orm";
import { create as createTar, Parser } from "tar";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import {
  deleteS3Objects,
  listS3ObjectsUnderPrefix,
  putS3Object,
} from "../external/s3";
import { createDeferredPromise, safeSync, tapError } from "../utils";
import type { FileEntryWithHash } from "./storage-content-hash.service";
import { newStorageS3Location } from "./storage-s3-prefix.utils";

import { preparePiResourceIndex } from "../../lib/pi-resource-index";
import {
  publishPiResourceVersionIndex,
  readPiResourceVersionIndexes,
} from "./pi-resource-version-index.service";

interface SyncSkillsResult {
  readonly commitSha: string;
  readonly synced: number;
  readonly skipped: number;
  readonly failed: number;
  readonly removed: number;
  readonly total: number;
}

interface SyncSkillsScope {
  readonly skillNamePrefix: string | null;
  readonly requiredSkillNames: readonly string[];
}

interface ExtractedFile {
  readonly path: string;
  readonly content: Buffer;
  readonly hash: string;
  readonly size: number;
}

interface ExtractedSkill {
  readonly skillName: string;
  readonly files: readonly ExtractedFile[];
}

interface SkillSyncContext {
  readonly skillName: string;
  readonly files: readonly ExtractedFile[];
  readonly url: string;
  readonly fullPath: string;
  readonly storageName: string;
  readonly frontmatter: SkillFrontmatter;
  readonly versionHash: string;
  readonly totalSize: number;
}

interface SkillArchiveUpload {
  readonly archiveBuffer: Buffer;
  readonly manifestBuffer: Buffer;
  readonly s3Key: string;
}

const log = logger("skills:sync");
const REPO_REFS_URL = `https://github.com/${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}.git/info/refs?service=git-upload-pack`;
const TARBALL_URL = `https://codeload.github.com/${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}/tar.gz/refs/heads/${DEFAULT_SKILLS_BRANCH}`;
const OFFICIAL_SKILL_URL_ROOT = `https://github.com/${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}/tree/${DEFAULT_SKILLS_BRANCH}/`;
const SYNC_BATCH_SIZE = 5;

function parseHeadRef(pktLineText: string, branch: string): string {
  const refSuffix = `refs/heads/${branch}`;
  const shaLength = 40;

  for (const line of pktLineText.split("\n")) {
    const refIndex = line.indexOf(refSuffix);
    if (refIndex === -1) {
      continue;
    }

    const shaEnd = refIndex - 1;
    const shaStart = shaEnd - shaLength;
    if (shaStart < 0) {
      continue;
    }

    const sha = line.substring(shaStart, shaEnd);
    if (/^[0-9a-f]{40}$/.test(sha)) {
      return sha;
    }
  }

  throw new Error(`refs/heads/${branch} not found in git refs`);
}

async function fetchHeadCommitSha(signal: AbortSignal): Promise<string> {
  const response = await fetch(REPO_REFS_URL, { signal });
  if (!response.ok) {
    throw new Error(`Failed to fetch git refs: ${response.status}`);
  }

  return parseHeadRef(await response.text(), DEFAULT_SKILLS_BRANCH);
}

function extractSkillsFromTarball(
  gzipped: Buffer,
  signal: AbortSignal,
): Promise<ExtractedSkill[]> {
  const decompressed = gunzipSync(gzipped);
  const filesBySkill = new Map<string, ExtractedFile[]>();
  const deferred = createDeferredPromise<ExtractedSkill[]>(signal);

  const parser = new Parser({
    onReadEntry: (entry) => {
      if (entry.type !== "File") {
        entry.resume();
        return;
      }

      const parts = entry.path.split("/");
      if (parts.length < 3) {
        entry.resume();
        return;
      }

      const skillName = parts[1]!;
      const relativePath = parts.slice(2).join("/");
      const chunks: Buffer[] = [];
      entry.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      entry.on("end", () => {
        const content = Buffer.concat(chunks);
        const hash = createHash("sha256").update(content).digest("hex");
        const files = filesBySkill.get(skillName) ?? [];
        files.push({
          path: relativePath,
          content,
          hash,
          size: content.length,
        });
        filesBySkill.set(skillName, files);
      });
    },
  });

  parser.on("end", () => {
    if (deferred.settled()) {
      return;
    }

    const extracted: ExtractedSkill[] = [];
    for (const [skillName, files] of filesBySkill) {
      if (
        files.some((file) => {
          return file.path === "SKILL.md";
        })
      ) {
        extracted.push({ skillName, files });
      }
    }
    deferred.resolve(extracted);
  });
  parser.on("error", (error) => {
    if (!deferred.settled()) {
      deferred.reject(error);
    }
  });
  const parseResult = safeSync(() => {
    parser.write(decompressed);
    parser.end();
  });
  if ("error" in parseResult && !deferred.settled()) {
    deferred.reject(parseResult.error);
  }

  return deferred.promise;
}

async function downloadAndExtractSkills(
  signal: AbortSignal,
): Promise<ExtractedSkill[]> {
  const response = await fetch(TARBALL_URL, { signal });
  if (!response.ok) {
    throw new Error(`Failed to download tarball: ${response.status}`);
  }

  return await extractSkillsFromTarball(
    Buffer.from(await response.arrayBuffer()),
    signal,
  );
}

function computeSystemSkillHash(
  skillUrl: string,
  files: readonly FileEntryWithHash[],
): string {
  if (files.length === 0) {
    return createHash("sha256")
      .update(`system-skill:${skillUrl}\n`)
      .digest("hex");
  }

  const entries = files
    .map((file) => {
      return `${file.path}:${file.hash}`;
    })
    .sort();
  return createHash("sha256")
    .update(`system-skill:${skillUrl}\n${entries.join("\n")}`)
    .digest("hex");
}

function skillUrl(skillName: string): string {
  return `https://github.com/${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}/tree/${DEFAULT_SKILLS_BRANCH}/${skillName}`;
}

function buildSkillSyncContext(extracted: ExtractedSkill): SkillSyncContext {
  const skillName = extracted.skillName;
  const files = extracted.files;
  const url = skillUrl(skillName);
  const fullPath = `${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}/tree/${DEFAULT_SKILLS_BRANCH}/${skillName}`;
  const skillMd = files.find((file) => {
    return file.path === "SKILL.md";
  });
  const frontmatter: SkillFrontmatter = skillMd
    ? parseSkillFrontmatter(skillMd.content.toString("utf8"))
    : {};
  const fileEntries: FileEntryWithHash[] = files.map((file) => {
    return {
      path: file.path,
      hash: file.hash,
      size: file.size,
    };
  });
  const totalSize = files.reduce((sum, file) => {
    return sum + file.size;
  }, 0);

  return {
    skillName,
    files,
    url,
    fullPath,
    storageName: getSkillStorageName(fullPath),
    frontmatter,
    versionHash: computeSystemSkillHash(url, fileEntries),
    totalSize,
  };
}

async function createSkillArchive(
  files: readonly ExtractedFile[],
): Promise<{ archiveBuffer: Buffer; manifestBuffer: Buffer }> {
  const tmpDir = await mkdtemp(join(tmpdir(), "api-skill-"));
  await Promise.all(
    files.map((file) => {
      const filePath = join(tmpDir, file.path);
      mkdirSync(join(filePath, ".."), { recursive: true });
      return writeFile(filePath, file.content);
    }),
  );

  const tarPath = join(tmpDir, "__archive.tar.gz");
  await createTar(
    {
      gzip: true,
      file: tarPath,
      cwd: tmpDir,
    },
    files.map((file) => {
      return file.path;
    }),
  );

  const archiveBuffer = await readFile(tarPath);
  const manifestBuffer = Buffer.from(
    JSON.stringify(
      {
        version: 1,
        files: files.map((file) => {
          return {
            path: file.path,
            hash: file.hash,
            size: file.size,
          };
        }),
        createdAt: nowDate().toISOString(),
      },
      null,
      2,
    ),
  );
  rmSync(tmpDir, { recursive: true, force: true });

  return { archiveBuffer, manifestBuffer };
}

async function hasCurrentSkillVersion(
  args: {
    readonly db: Db;
    readonly url: string;
    readonly versionHash: string;
    readonly commitSha: string;
    readonly files: readonly ExtractedFile[];
  },
  signal: AbortSignal,
): Promise<boolean> {
  const [existingSkill] = await args.db
    .select({ versionHash: skills.versionHash })
    .from(skills)
    .where(eq(skills.url, args.url))
    .limit(1);
  signal.throwIfAborted();

  if (existingSkill?.versionHash !== args.versionHash) {
    return false;
  }

  const { indexes } = await readPiResourceVersionIndexes(
    args.db,
    [args.versionHash],
    signal,
  );
  if (!indexes.has(args.versionHash)) {
    const [version] = await args.db
      .select({ archiveSize: storageVersions.archiveSize })
      .from(storageVersions)
      .where(eq(storageVersions.id, args.versionHash))
      .limit(1);
    if (!version) {
      throw new Error("Current skill references a missing Storage version");
    }
    // Reuse the publisher's archive encoding and bounded parser even when the
    // logical version is unchanged. Raw files would bypass the expansion limit.
    const { archiveBuffer } = await createSkillArchive(args.files);
    signal.throwIfAborted();
    await publishPiResourceVersionIndex(
      {
        db: args.db,
        versionId: args.versionHash,
        projection: preparePiResourceIndex(archiveBuffer),
        archiveSize: version.archiveSize,
      },
      signal,
    );
  }
  await args.db
    .update(skills)
    .set({ commitSha: args.commitSha, updatedAt: nowDate() })
    .where(eq(skills.url, args.url));
  signal.throwIfAborted();
  return true;
}

function uploadSkillArchive(
  context: SkillSyncContext,
  s3Prefix: string,
  signal: AbortSignal,
): Computed<Promise<SkillArchiveUpload>> {
  return computed(async (get): Promise<SkillArchiveUpload> => {
    const { archiveBuffer, manifestBuffer } = await createSkillArchive(
      context.files,
    );
    signal.throwIfAborted();

    const bucketName = env("R2_USER_STORAGES_BUCKET_NAME");
    const s3Key = `${s3Prefix}/${context.versionHash}`;

    await Promise.all([
      get(
        putS3Object(
          bucketName,
          `${s3Key}/archive.tar.gz`,
          archiveBuffer,
          "application/gzip",
        ),
      ),
      get(
        putS3Object(
          bucketName,
          `${s3Key}/manifest.json`,
          manifestBuffer,
          "application/json",
        ),
      ),
    ]);
    signal.throwIfAborted();

    return { archiveBuffer, manifestBuffer, s3Key };
  });
}

async function upsertSkillStorage(
  args: {
    readonly db: Db;
    readonly context: SkillSyncContext;
    readonly timestamp: Date;
  },
  signal: AbortSignal,
): Promise<{ readonly id: string; readonly s3Prefix: string }> {
  const location = newStorageS3Location(SYSTEM_ORG_ID);
  const [storage] = await args.db
    .insert(storages)
    .values({
      id: location.storageId,
      orgId: SYSTEM_ORG_ID,
      userId: VOLUME_ORG_USER_ID,
      name: args.context.storageName,
      s3Prefix: location.s3Prefix,
      size: args.context.totalSize,
      fileCount: args.context.files.length,
    })
    .onConflictDoUpdate({
      target: [storages.orgId, storages.userId, storages.name],
      set: {
        size: args.context.totalSize,
        fileCount: args.context.files.length,
        updatedAt: args.timestamp,
      },
    })
    .returning({ id: storages.id, s3Prefix: storages.s3Prefix });
  signal.throwIfAborted();

  if (!storage) {
    throw new Error(
      `Failed to create storage for skill ${args.context.skillName}`,
    );
  }

  return storage;
}

async function insertSkillStorageVersion(
  args: {
    readonly db: Db;
    readonly storageId: string;
    readonly context: SkillSyncContext;
    readonly upload: SkillArchiveUpload;
    readonly commitSha: string;
  },
  signal: AbortSignal,
): Promise<void> {
  await args.db
    .insert(storageVersions)
    .values({
      id: args.context.versionHash,
      storageId: args.storageId,
      s3Key: args.upload.s3Key,
      size: args.context.totalSize,
      archiveSize: args.upload.archiveBuffer.length,
      fileCount: args.context.files.length,
      message: `Synced from ${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}@${args.commitSha.slice(0, 7)}`,
      createdBy: "system",
    })
    .onConflictDoUpdate({
      target: storageVersions.id,
      set: { archiveSize: args.upload.archiveBuffer.length },
    });
  signal.throwIfAborted();
}

async function updateSkillStorageHead(
  args: {
    readonly db: Db;
    readonly storageId: string;
    readonly context: SkillSyncContext;
    readonly upload: SkillArchiveUpload;
    readonly timestamp: Date;
  },
  signal: AbortSignal,
): Promise<void> {
  await args.db
    .update(storages)
    .set({
      headVersionId: args.context.versionHash,
      size: args.context.totalSize,
      fileCount: args.context.files.length,
      updatedAt: args.timestamp,
    })
    .where(eq(storages.id, args.storageId));
  signal.throwIfAborted();
}

async function upsertSkillRecord(
  args: {
    readonly db: Db;
    readonly storageId: string;
    readonly context: SkillSyncContext;
    readonly upload: SkillArchiveUpload;
    readonly commitSha: string;
    readonly timestamp: Date;
  },
  signal: AbortSignal,
): Promise<void> {
  const displayName = args.context.frontmatter.name ?? args.context.skillName;

  await args.db
    .insert(skills)
    .values({
      url: args.context.url,
      name: displayName,
      fullPath: args.context.fullPath,
      storageId: args.storageId,
      versionHash: args.context.versionHash,
      commitSha: args.commitSha,
      frontmatter: args.context.frontmatter,
      s3Key: args.upload.s3Key,
      size: args.context.totalSize,
      fileCount: args.context.files.length,
      syncedAt: args.timestamp,
    })
    .onConflictDoUpdate({
      target: skills.url,
      set: {
        name: displayName,
        fullPath: args.context.fullPath,
        storageId: args.storageId,
        versionHash: args.context.versionHash,
        commitSha: args.commitSha,
        frontmatter: args.context.frontmatter,
        s3Key: args.upload.s3Key,
        size: args.context.totalSize,
        fileCount: args.context.files.length,
        syncedAt: args.timestamp,
        updatedAt: args.timestamp,
      },
    });
  signal.throwIfAborted();
}

function syncSingleSkill(
  db: Db,
  extracted: ExtractedSkill,
  commitSha: string,
  signal: AbortSignal,
): Computed<Promise<boolean>> {
  return computed(async (get): Promise<boolean> => {
    const context = buildSkillSyncContext(extracted);

    if (
      await hasCurrentSkillVersion(
        {
          db,
          url: context.url,
          versionHash: context.versionHash,
          commitSha,
          files: context.files,
        },
        signal,
      )
    ) {
      return false;
    }

    const timestamp = nowDate();
    // Upsert the storage row first: objects must land under the row's stored
    // prefix, which an existing row keeps from its creation time.
    const storage = await upsertSkillStorage(
      {
        db,
        context,
        timestamp,
      },
      signal,
    );
    const storageId = storage.id;
    const upload = await get(
      uploadSkillArchive(context, storage.s3Prefix, signal),
    );
    const projection = preparePiResourceIndex(upload.archiveBuffer);
    await db.transaction(async (tx) => {
      await insertSkillStorageVersion(
        { db: tx, storageId, context, upload, commitSha },
        signal,
      );
      await updateSkillStorageHead(
        { db: tx, storageId, context, upload, timestamp },
        signal,
      );
      await upsertSkillRecord(
        { db: tx, storageId, context, upload, commitSha, timestamp },
        signal,
      );
      await publishPiResourceVersionIndex(
        {
          db: tx,
          versionId: context.versionHash,
          projection,
          archiveSize: upload.archiveBuffer.length,
        },
        signal,
      );
    });

    log.debug("Synced skill", {
      skillName: context.skillName,
      versionHash: context.versionHash.slice(0, 8),
    });
    return true;
  });
}

function removeOrphanedSkills(
  db: Db,
  extractedSkills: readonly ExtractedSkill[],
  urlPrefix: string,
  signal: AbortSignal,
): Computed<Promise<number>> {
  return computed(async (get): Promise<number> => {
    const tarballUrls = new Set(
      extractedSkills.map((skill) => {
        return skillUrl(skill.skillName);
      }),
    );
    const existingSkills = await db
      .select({ id: skills.id, url: skills.url, storageId: skills.storageId })
      .from(skills)
      .where(like(skills.url, `${urlPrefix}%`));
    signal.throwIfAborted();

    const orphans = existingSkills.filter((skill) => {
      return !tarballUrls.has(skill.url);
    });
    if (orphans.length === 0) {
      return 0;
    }

    const orphanIds = orphans.map((skill) => {
      return skill.id;
    });
    const orphanStorageIds = orphans
      .map((skill) => {
        return skill.storageId;
      })
      .filter((id): id is string => {
        return id !== null;
      });

    const orphanStorages =
      orphanStorageIds.length > 0
        ? await db
            .select({ id: storages.id, s3Prefix: storages.s3Prefix })
            .from(storages)
            .where(inArray(storages.id, orphanStorageIds))
        : [];
    signal.throwIfAborted();

    await db.delete(skills).where(inArray(skills.id, orphanIds));
    signal.throwIfAborted();

    if (orphanStorageIds.length > 0) {
      await db.delete(storages).where(inArray(storages.id, orphanStorageIds));
      signal.throwIfAborted();
    }

    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    for (const storage of orphanStorages) {
      await tapError(
        (async () => {
          const objects = await get(
            listS3ObjectsUnderPrefix(bucket, storage.s3Prefix),
          );
          signal.throwIfAborted();
          if (objects.length > 0) {
            await get(
              deleteS3Objects(
                bucket,
                objects.map((object) => {
                  return object.key;
                }),
              ),
            );
            signal.throwIfAborted();
          }
        })(),
        (error) => {
          log.warn("Failed to clean up S3 objects for removed skill", {
            s3Prefix: storage.s3Prefix,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );
    }

    log.debug("Removed orphaned skills", {
      removed: orphans.length,
      skillUrls: orphans.map((skill) => {
        return skill.url;
      }),
    });
    return orphans.length;
  });
}

function validateSeedSkills(
  extractedSkills: readonly ExtractedSkill[],
  requiredSkillNames: readonly string[],
): void {
  const tarballNames = new Set(
    extractedSkills.map((skill) => {
      return skill.skillName;
    }),
  );
  const missingSkills = requiredSkillNames.filter((name) => {
    return !tarballNames.has(name);
  });

  if (missingSkills.length > 0) {
    log.error("SEED_SKILLS references skills not found in repository", {
      missingSkills: missingSkills.map((name) => {
        return resolveSkillRef(name);
      }),
    });
  }
}

export const syncSkillsForScope$ = command(
  async (
    { get, set },
    scope: SyncSkillsScope,
    signal: AbortSignal,
  ): Promise<SyncSkillsResult> => {
    const db = set(writeDb$);
    const headSha = await fetchHeadCommitSha(signal);
    signal.throwIfAborted();

    const urlPrefix = `${OFFICIAL_SKILL_URL_ROOT}${scope.skillNamePrefix ?? ""}`;
    const [existing] =
      scope.skillNamePrefix === null
        ? await db.select({ commitSha: skills.commitSha }).from(skills).limit(1)
        : await db
            .select({ commitSha: skills.commitSha })
            .from(skills)
            .where(like(skills.url, `${urlPrefix}%`))
            .limit(1);
    signal.throwIfAborted();

    if (existing?.commitSha === headSha) {
      return {
        commitSha: headSha,
        synced: 0,
        skipped: 0,
        failed: 0,
        removed: 0,
        total: 0,
      };
    }

    const extractedSkills = (await downloadAndExtractSkills(signal)).filter(
      (skill) => {
        return (
          scope.skillNamePrefix === null ||
          skill.skillName.startsWith(scope.skillNamePrefix)
        );
      },
    );
    signal.throwIfAborted();

    let synced = 0;
    let skipped = 0;
    let failed = 0;

    for (
      let index = 0;
      index < extractedSkills.length;
      index += SYNC_BATCH_SIZE
    ) {
      const batch = extractedSkills.slice(index, index + SYNC_BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((extracted) => {
          return get(syncSingleSkill(db, extracted, headSha, signal));
        }),
      );
      signal.throwIfAborted();

      for (let resultIndex = 0; resultIndex < results.length; resultIndex++) {
        const result = results[resultIndex]!;
        if (result.status === "fulfilled") {
          if (result.value) {
            synced++;
          } else {
            skipped++;
          }
        } else {
          failed++;
          log.warn("Skipping skill due to sync error", {
            skillName: batch[resultIndex]!.skillName,
            error:
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason),
          });
        }
      }
    }

    const removed = await get(
      removeOrphanedSkills(db, extractedSkills, urlPrefix, signal),
    );
    signal.throwIfAborted();
    validateSeedSkills(extractedSkills, scope.requiredSkillNames);

    log.debug("Skills sync completed", {
      commitSha: headSha,
      synced,
      skipped,
      failed,
      removed,
      total: extractedSkills.length,
    });

    return {
      commitSha: headSha,
      synced,
      skipped,
      failed,
      removed,
      total: extractedSkills.length,
    };
  },
);

export const syncSkills$ = command(
  async ({ set }, signal: AbortSignal): Promise<SyncSkillsResult> => {
    return await set(
      syncSkillsForScope$,
      { skillNamePrefix: null, requiredSkillNames: SEED_SKILLS },
      signal,
    );
  },
);
