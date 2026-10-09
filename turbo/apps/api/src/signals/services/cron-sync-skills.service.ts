import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import type { FileEntryWithHash } from "@okouai/api-contracts/contracts/storage-content-hash";
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
import { command } from "ccstate";
import { and, asc, eq, inArray, like } from "drizzle-orm";
import { create as createTar, Parser } from "tar";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import {
  deleteS3Objects,
  listS3ObjectsUnderPrefix,
  putS3Object,
} from "../external/s3";
import { createDeferredPromise, safeSync, tapError } from "../utils";

import { newStorageS3Location } from "./storage-s3-prefix.utils";
import { StorageVersionIdentityConflictError } from "./storage-version-registration.service";

import {
  preparePiResourceIndex,
  PI_RESOURCE_EXTRACTOR_VERSION,
} from "../../lib/pi-resource-index";
import { piResourceVersionIndexes } from "@okouai/db/schema/pi-resource-version-index";
import {
  piResourceProjectionValues,
  readPiResourceVersionIndexes$,
} from "./pi-resource-version-index.service";

interface SyncSkillsResult {
  readonly commitSha: string;
  readonly synced: number;
  readonly skipped: number;
  readonly failed: number;
  readonly removed: number;
  readonly total: number;
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

const hasCurrentSkillVersion$ = command(
  async (
    { get, set },
    args: {
      readonly url: string;
      readonly versionHash: string;
      readonly files: readonly ExtractedFile[];
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const [existingSkill] = await get(db$)
      .select({ versionHash: skills.versionHash, storageId: skills.storageId })
      .from(skills)
      .where(eq(skills.url, args.url))
      .limit(1);
    signal.throwIfAborted();

    if (existingSkill?.versionHash !== args.versionHash) {
      return false;
    }

    const [version] = await get(db$)
      .select({
        storageId: storageVersions.storageId,
        fileCount: storageVersions.fileCount,
        archiveSize: storageVersions.archiveSize,
      })
      .from(storageVersions)
      .where(eq(storageVersions.id, args.versionHash))
      .limit(1);
    signal.throwIfAborted();
    if (
      !version ||
      version.storageId !== existingSkill.storageId ||
      version.fileCount !== args.files.length
    ) {
      throw new Error("Current skill references an invalid Storage version");
    }
    const { indexes } = await set(
      readPiResourceVersionIndexes$,
      [args.versionHash],
      signal,
    );
    if (!indexes.has(args.versionHash)) {
      // Reuse the publisher's archive encoding and bounded parser even when the
      // logical version is unchanged. Raw files would bypass the expansion limit.
      const { archiveBuffer } = await createSkillArchive(args.files);
      signal.throwIfAborted();
      const values = piResourceProjectionValues(
        preparePiResourceIndex(archiveBuffer),
        version.archiveSize,
        nowDate(),
      );
      await set(writeDb$)
        .insert(piResourceVersionIndexes)
        .values({
          storageVersionId: args.versionHash,
          extractorVersion: PI_RESOURCE_EXTRACTOR_VERSION,
          ...values,
        })
        .onConflictDoUpdate({
          target: [
            piResourceVersionIndexes.storageVersionId,
            piResourceVersionIndexes.extractorVersion,
          ],
          set: values,
        });
      signal.throwIfAborted();
    }
    return true;
  },
);

const uploadSkillArchive$ = command(
  async (
    { get },
    args: { readonly context: SkillSyncContext; readonly s3Prefix: string },
    signal: AbortSignal,
  ): Promise<SkillArchiveUpload> => {
    const { context, s3Prefix } = args;
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

    return { archiveBuffer, s3Key };
  },
);

const resolveSkillStorage$ = command(
  async (
    { get, set },
    args: { readonly context: SkillSyncContext },
    signal: AbortSignal,
  ): Promise<{ readonly id: string; readonly s3Prefix: string }> => {
    const db = set(writeDb$);
    const location = newStorageS3Location(SYSTEM_ORG_ID);
    await db
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
      .onConflictDoNothing();
    signal.throwIfAborted();
    // Existing HEAD metadata belongs to the publication transaction. Reading
    // the canonical prefix needs no row update or lock across R2 I/O.
    const [storage] = await get(db$)
      .select({ id: storages.id, s3Prefix: storages.s3Prefix })
      .from(storages)
      .where(
        and(
          eq(storages.orgId, SYSTEM_ORG_ID),
          eq(storages.userId, VOLUME_ORG_USER_ID),
          eq(storages.name, args.context.storageName),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!storage) {
      throw new Error(
        `Failed to create storage for skill ${args.context.skillName}`,
      );
    }

    return storage;
  },
);

interface SkillPublication {
  readonly storageId: string;
  readonly context: SkillSyncContext;
  readonly upload: SkillArchiveUpload;
  readonly timestamp: Date;
  readonly commitSha: string;
}
function skillVersionValues(args: SkillPublication) {
  return {
    id: args.context.versionHash,
    storageId: args.storageId,
    s3Key: args.upload.s3Key,
    size: args.context.totalSize,
    archiveSize: args.upload.archiveBuffer.length,
    fileCount: args.context.files.length,
    message: `Synced from ${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}@${args.commitSha.slice(0, 7)}`,
    createdBy: "system",
  };
}
function skillHeadValues(args: SkillPublication) {
  return {
    headVersionId: args.context.versionHash,
    size: args.context.totalSize,
    fileCount: args.context.files.length,
    updatedAt: args.timestamp,
  };
}
function skillRecordValues(args: SkillPublication) {
  return {
    name: args.context.frontmatter.name ?? args.context.skillName,
    fullPath: args.context.fullPath,
    storageId: args.storageId,
    versionHash: args.context.versionHash,
    frontmatter: args.context.frontmatter,
    s3Key: args.upload.s3Key,
    size: args.context.totalSize,
    fileCount: args.context.files.length,
    syncedAt: args.timestamp,
  };
}
function skillVersionMatches(
  version: Pick<
    typeof storageVersions.$inferSelect,
    "storageId" | "s3Key" | "size" | "fileCount"
  >,
  storageId: string,
  context: SkillSyncContext,
  s3Key: string,
) {
  return (
    version.storageId === storageId &&
    version.s3Key === s3Key &&
    Number(version.size) === context.totalSize &&
    version.fileCount === context.files.length
  );
}
const skillVersionColumns = Object.freeze({
  storageId: storageVersions.storageId,
  s3Key: storageVersions.s3Key,
  size: storageVersions.size,
  archiveSize: storageVersions.archiveSize,
  fileCount: storageVersions.fileCount,
});
const commitSkillPublication$ = command(
  async (
    { set },
    args: SkillPublication,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const record = skillRecordValues(args);
    const projection = preparePiResourceIndex(args.upload.archiveBuffer);
    await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(storageVersions)
        .values(skillVersionValues(args))
        .onConflictDoNothing()
        .returning({ archiveSize: storageVersions.archiveSize });
      signal.throwIfAborted();
      const [stored] = inserted
        ? []
        : await tx
            .select(skillVersionColumns)
            .from(storageVersions)
            .where(eq(storageVersions.id, args.context.versionHash))
            .limit(1);
      signal.throwIfAborted();
      if (
        !inserted &&
        (!stored ||
          !skillVersionMatches(
            stored,
            args.storageId,
            args.context,
            args.upload.s3Key,
          ))
      ) {
        throw new StorageVersionIdentityConflictError(args.context.versionHash);
      }
      const archiveSize = inserted?.archiveSize ?? stored?.archiveSize;
      if (archiveSize === undefined) {
        throw new Error("Published skill has no registered archive size");
      }
      await tx
        .update(storages)
        .set(skillHeadValues(args))
        .where(eq(storages.id, args.storageId));
      signal.throwIfAborted();
      await tx
        .insert(skills)
        .values({ url: args.context.url, ...record })
        .onConflictDoUpdate({
          target: skills.url,
          set: { ...record, updatedAt: args.timestamp },
        });
      signal.throwIfAborted();
      const values = piResourceProjectionValues(
        projection,
        archiveSize,
        nowDate(),
      );
      await tx
        .insert(piResourceVersionIndexes)
        .values({
          storageVersionId: args.context.versionHash,
          extractorVersion: PI_RESOURCE_EXTRACTOR_VERSION,
          ...values,
        })
        .onConflictDoUpdate({
          target: [
            piResourceVersionIndexes.storageVersionId,
            piResourceVersionIndexes.extractorVersion,
          ],
          set: values,
        });
      signal.throwIfAborted();
    });
  },
);

const syncSingleSkill$ = command(
  async (
    { get, set },
    args: { readonly extracted: ExtractedSkill; readonly commitSha: string },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const { extracted, commitSha } = args;
    const context = buildSkillSyncContext(extracted);

    if (
      await set(
        hasCurrentSkillVersion$,
        {
          url: context.url,
          versionHash: context.versionHash,
          files: context.files,
        },
        signal,
      )
    ) {
      return false;
    }

    const timestamp = nowDate();
    // Resolve the storage row first: objects must land under its canonical
    // prefix, which an existing row keeps from its creation time.
    const storage = await set(resolveSkillStorage$, { context }, signal);
    const storageId = storage.id;
    const [existing] = await get(db$)
      .select({
        storageId: storageVersions.storageId,
        s3Key: storageVersions.s3Key,
        size: storageVersions.size,
        fileCount: storageVersions.fileCount,
      })
      .from(storageVersions)
      .where(eq(storageVersions.id, context.versionHash))
      .limit(1);
    signal.throwIfAborted();
    const s3Key = `${storage.s3Prefix}/${context.versionHash}`;
    if (existing && !skillVersionMatches(existing, storageId, context, s3Key)) {
      throw new StorageVersionIdentityConflictError(context.versionHash);
    }
    const upload = existing
      ? {
          archiveBuffer: (await createSkillArchive(context.files))
            .archiveBuffer,
          s3Key,
        }
      : await set(
          uploadSkillArchive$,
          { context, s3Prefix: storage.s3Prefix },
          signal,
        );
    signal.throwIfAborted();
    await set(
      commitSkillPublication$,
      { storageId, context, upload, commitSha, timestamp },
      signal,
    );
    signal.throwIfAborted();

    log.debug("Synced skill", {
      skillName: context.skillName,
      versionHash: context.versionHash.slice(0, 8),
    });
    return true;
  },
);

const removeOrphanedSkills$ = command(
  async (
    { get, set },
    args: {
      readonly extractedSkills: readonly ExtractedSkill[];
      readonly urlPrefix: string;
    },
    signal: AbortSignal,
  ): Promise<number> => {
    const { extractedSkills, urlPrefix } = args;
    const tarballUrls = new Set(
      extractedSkills.map((skill) => {
        return skillUrl(skill.skillName);
      }),
    );
    const existingSkills = await get(db$)
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

    const orphanStorages = await set(writeDb$).transaction(async (tx) => {
      const lockedStorages =
        orphanStorageIds.length > 0
          ? await tx
              .select({ id: storages.id, s3Prefix: storages.s3Prefix })
              .from(storages)
              .where(inArray(storages.id, orphanStorageIds))
              .orderBy(asc(storages.id))
              .for("update")
          : [];
      signal.throwIfAborted();
      await tx.delete(skills).where(inArray(skills.id, orphanIds));
      if (lockedStorages.length > 0) {
        await tx.delete(storages).where(
          inArray(
            storages.id,
            lockedStorages.map((storage) => {
              return storage.id;
            }),
          ),
        );
      }
      signal.throwIfAborted();
      return lockedStorages;
    });

    signal.throwIfAborted();
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
  },
);

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

export const syncSkills$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<SyncSkillsResult> => {
    const headSha = await fetchHeadCommitSha(signal);
    signal.throwIfAborted();

    const urlPrefix = OFFICIAL_SKILL_URL_ROOT;
    // commitSha is a batch completion marker. A failed or interrupted attempt
    // leaves the set incomplete so the next cron run downloads the same commit
    // and retries its missing work.
    const existing = await get(db$)
      .select({ commitSha: skills.commitSha })
      .from(skills)
      .where(like(skills.url, `${urlPrefix}%`));
    signal.throwIfAborted();

    if (
      existing.length > 0 &&
      existing.every((skill) => {
        return skill.commitSha === headSha;
      })
    ) {
      return {
        commitSha: headSha,
        synced: 0,
        skipped: 0,
        failed: 0,
        removed: 0,
        total: 0,
      };
    }

    const extractedSkills = await downloadAndExtractSkills(signal);
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
          return set(
            syncSingleSkill$,
            { extracted, commitSha: headSha },
            signal,
          );
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

    const removed = await set(
      removeOrphanedSkills$,
      { extractedSkills, urlPrefix },
      signal,
    );
    signal.throwIfAborted();
    validateSeedSkills(extractedSkills, SEED_SKILLS);

    if (failed === 0) {
      // Advance the marker only after every extracted skill completed. Updating
      // it per skill would let one success hide another skill's failure.
      await set(writeDb$)
        .update(skills)
        .set({ commitSha: headSha, updatedAt: nowDate() })
        .where(like(skills.url, `${urlPrefix}%`));
      signal.throwIfAborted();
    }

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
