import { accept } from "@okouai/connectors/accept";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

import type { FileEntryWithHash } from "@okouai/api-contracts/contracts/storage-content-hash";
import type { ContentBundle } from "@okouai/api-contracts/contracts/content-bundle";
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
import { SEED_SKILLS } from "@okouai/core/seed-skills";
import { skills } from "@okouai/db/schema/skill";
import { command } from "ccstate";
import { eq, inArray } from "drizzle-orm";
import { Parser } from "tar";

import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { createDeferredPromise, safeSync } from "../utils";
import { publishContentBundle$ } from "./content-bundle.service";

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
  readonly frontmatter: SkillFrontmatter;
  readonly versionHash: string;
  readonly totalSize: number;
}

const log = logger("skills:sync");
const REPO_REFS_URL = `https://github.com/${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}.git/info/refs?service=git-upload-pack`;
const TARBALL_URL = `https://codeload.github.com/${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}/tar.gz/refs/heads/${DEFAULT_SKILLS_BRANCH}`;
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

async function fetchHeadCommitSha(_signal: AbortSignal): Promise<string> {
  const response = await accept(fetch(REPO_REFS_URL), [200]);

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
      if (!SEED_SKILLS.includes(skillName)) {
        entry.resume();
        return;
      }
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
  const response = await accept(fetch(TARBALL_URL), [200]);

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
    frontmatter,
    versionHash: computeSystemSkillHash(url, fileEntries),
    totalSize,
  };
}

function skillSourceValues(context: SkillSyncContext, timestamp: Date) {
  return {
    name: context.frontmatter.name ?? context.skillName,
    fullPath: context.fullPath,
    versionHash: context.versionHash,
    frontmatter: context.frontmatter,
    size: context.totalSize,
    fileCount: context.files.length,
    syncedAt: timestamp,
  };
}
const commitSeedSkillPublication$ = command(
  async (
    { set },
    args: {
      readonly context: SkillSyncContext;
      readonly timestamp: Date;
      readonly contentBundle: ContentBundle;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const database = set(writeDb$);
    const record = {
      ...skillSourceValues(args.context, args.timestamp),
      storageId: null,
      s3Key: null,
      contentBundle: args.contentBundle,
      contentBundleSourceVersionHash: args.context.versionHash,
    };
    await database
      .insert(skills)
      .values({ url: args.context.url, ...record })
      .onConflictDoUpdate({
        target: skills.url,
        set: { ...record, updatedAt: args.timestamp },
      });
    signal.throwIfAborted();
  },
);

const syncSingleSkill$ = command(
  async (
    { get, set },
    extracted: ExtractedSkill,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const context = buildSkillSyncContext(extracted);
    const [existingSkill] = await get(db$)
      .select({
        versionHash: skills.versionHash,
        contentBundle: skills.contentBundle,
        contentBundleSourceVersionHash: skills.contentBundleSourceVersionHash,
      })
      .from(skills)
      .where(eq(skills.url, context.url))
      .limit(1);
    signal.throwIfAborted();
    if (
      existingSkill?.versionHash === context.versionHash &&
      existingSkill.contentBundle !== null &&
      existingSkill.contentBundleSourceVersionHash === context.versionHash
    ) {
      return false;
    }
    const timestamp = nowDate();
    const contentBundle = await set(
      publishContentBundle$,
      context.files.map((file) => {
        return { path: file.path, content: file.content };
      }),
      signal,
    );
    signal.throwIfAborted();
    await set(
      commitSeedSkillPublication$,
      { context, timestamp, contentBundle },
      signal,
    );
    signal.throwIfAborted();
    return true;
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

    const seedSkillUrls = SEED_SKILLS.map(skillUrl);
    // commitSha is a batch completion marker. A failed or interrupted attempt
    // leaves the set incomplete so the next cron run downloads the same commit
    // and retries its missing work. Historical non-Seed rows belong to retained
    // Registry/Run inputs and must not participate in this batch.
    const existing = await get(db$)
      .select({
        url: skills.url,
        commitSha: skills.commitSha,
        versionHash: skills.versionHash,
        contentBundle: skills.contentBundle,
        contentBundleSourceVersionHash: skills.contentBundleSourceVersionHash,
      })
      .from(skills)
      .where(inArray(skills.url, seedSkillUrls));
    signal.throwIfAborted();

    if (
      existing.length > 0 &&
      existing.every((skill) => {
        return skill.commitSha === headSha;
      }) &&
      SEED_SKILLS.every((name) => {
        return existing.some((skill) => {
          return (
            skill.url === skillUrl(name) &&
            skill.contentBundle !== null &&
            skill.contentBundleSourceVersionHash === skill.versionHash
          );
        });
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
          return set(syncSingleSkill$, extracted, signal);
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

    validateSeedSkills(extractedSkills, SEED_SKILLS);

    if (failed === 0 && extractedSkills.length === SEED_SKILLS.length) {
      // A missing Seed or failed publication must leave the batch retryable.
      // Advance only this complete Seed set, never retained non-Seed metadata.
      await set(writeDb$)
        .update(skills)
        .set({ commitSha: headSha, updatedAt: nowDate() })
        .where(inArray(skills.url, seedSkillUrls));
      signal.throwIfAborted();
    }

    log.debug("Skills sync completed", {
      commitSha: headSha,
      synced,
      skipped,
      failed,
      removed: 0,
      total: extractedSkills.length,
    });

    return {
      commitSha: headSha,
      synced,
      skipped,
      failed,
      removed: 0,
      total: extractedSkills.length,
    };
  },
);
