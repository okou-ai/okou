import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_SKILLS_BRANCH,
  DEFAULT_SKILLS_OWNER,
  DEFAULT_SKILLS_REPO,
} from "@okouai/core/github-url";
import { testPiResourceIndexWorkContract } from "@okouai/api-contracts/contracts/test-pi-resource-index-work";
import {
  getSkillStorageName,
  SYSTEM_ORG_ID,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { SEED_SKILLS } from "@okouai/core/seed-skills";
import { http, HttpResponse } from "msw";
import { create as createTar } from "tar";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { extractFilesFromTarGz } from "../../../lib/tar";
import { server } from "../../../mocks/server";
import { readPiResourceIndexStatusFixture } from "../../../test-fixtures/pi-resource-index";
import {
  readPiStableContextStorageDemandFixture,
  seedPiStableContextStorageDemandFixture,
} from "../../../test-fixtures/pi-stable-context";
import { testPiResourceIndexWorkRoutes } from "../test-pi-resource-index-work";
import { createBddApi } from "./helpers/api-bdd";
import {
  cleanupOwnedSkillsState,
  findSkillByUrlState,
  findSystemStorageByNameState,
  seedCurrentSkillVersionsState,
  setOwnedSkillsCommitShaState,
  syncOwnedSkillsState,
} from "./helpers/cron-sync-skills-state";

const context = testContext();
const bdd = createBddApi(context);
const BUCKET = "test-user-storages";
const STALE_PRESEEDED_COMMIT_SHA = "0".repeat(40);

interface MockSkillEntry {
  readonly name: string;
  readonly files: readonly {
    readonly path: string;
    readonly content: string;
  }[];
}

interface MockSkillVersion {
  readonly name: string;
  readonly url: string;
  readonly fullPath: string;
  readonly storageName: string;
  readonly versionHash: string;
  readonly size: number;
  readonly archiveSize: number;
  readonly fileCount: number;
  readonly frontmatter: {
    readonly name: string;
    readonly description: string;
  };
}

interface CronSyncSkillsFixture {
  readonly skillNamePrefix: string;
  readonly requiredSeedSkillNames: readonly string[];
  readonly existingSkillName: string;
  readonly sentinelSkillName: string;
  readonly alphaSkill: MockSkillEntry;
  readonly betaSkill: MockSkillEntry;
  readonly skillUrls: Set<string>;
  readonly storageNames: Set<string>;
}

function createCronSyncSkillsFixture(): CronSyncSkillsFixture {
  const fixtureId = randomUUID().replaceAll("-", "");
  const skillNamePrefix = `api-test-skill-${fixtureId}-`;
  const alphaName = `${skillNamePrefix}alpha`;
  const betaName = `${skillNamePrefix}beta`;
  return {
    skillNamePrefix,
    requiredSeedSkillNames: SEED_SKILLS.map((name) => {
      return `${skillNamePrefix}${name}`;
    }),
    existingSkillName: `${skillNamePrefix}existing`,
    sentinelSkillName: `api-test-sentinel-${fixtureId}-existing`,
    alphaSkill: {
      name: alphaName,
      files: [
        {
          path: "SKILL.md",
          content: [
            "---",
            `name: ${alphaName}`,
            "description: Alpha integration skill",
            "---",
            "",
            "# Alpha Skill",
            "Send messages to Alpha.",
          ].join("\n"),
        },
        { path: "index.ts", content: 'console.log("alpha");' },
      ],
    },
    betaSkill: {
      name: betaName,
      files: [
        {
          path: "SKILL.md",
          content: [
            "---",
            `name: ${betaName}`,
            "description: Beta integration",
            "---",
            "",
            "# Beta Skill",
          ].join("\n"),
        },
      ],
    },
    skillUrls: new Set(),
    storageNames: new Set(),
  };
}

function registerOwnedSkill(
  fixture: CronSyncSkillsFixture,
  name: string,
  ownsStorage: boolean,
): {
  readonly name: string;
  readonly url: string;
  readonly fullPath: string;
  readonly frontmatter: { readonly name: string; readonly description: string };
} {
  const url = testSkillUrl(name);
  const fullPath = `${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}/tree/${DEFAULT_SKILLS_BRANCH}/${name}`;
  fixture.skillUrls.add(url);
  if (ownsStorage) {
    fixture.storageNames.add(getSkillStorageName(fullPath));
  }
  return {
    name,
    url,
    fullPath,
    frontmatter: { name, description: `${name} skill` },
  };
}

function registerOwnedEntries(
  fixture: CronSyncSkillsFixture,
  entries: readonly MockSkillEntry[],
): void {
  for (const entry of entries) {
    registerOwnedSkill(fixture, entry.name, true);
  }
}

async function cleanupOwnedSkills(
  fixture: CronSyncSkillsFixture,
): Promise<void> {
  if (fixture.skillUrls.size === 0 && fixture.storageNames.size === 0) {
    return;
  }
  await cleanupOwnedSkillsState(context, {
    skillUrls: [...fixture.skillUrls],
    storageNames: [...fixture.storageNames],
  });
}

async function setOwnedSkillsCommitSha(
  fixture: CronSyncSkillsFixture,
  commitSha: string,
  skillNames: readonly string[] = [fixture.existingSkillName],
): Promise<void> {
  await setOwnedSkillsCommitShaState(context, {
    skills: skillNames.map((name) => {
      return registerOwnedSkill(fixture, name, false);
    }),
    commitSha,
  });
}

async function syncOwnedSkills(fixture: CronSyncSkillsFixture) {
  return await syncOwnedSkillsState(context, {
    skillNamePrefix: fixture.skillNamePrefix,
    requiredSkillNames: fixture.requiredSeedSkillNames,
  });
}

async function seedCurrentSkillVersions(
  fixture: CronSyncSkillsFixture,
  entries: readonly MockSkillEntry[],
): Promise<void> {
  if (entries.length === 0) {
    return;
  }
  registerOwnedEntries(fixture, entries);
  await seedCurrentSkillVersionsState(context, {
    staleCommitSha: STALE_PRESEEDED_COMMIT_SHA,
    versions: entries.map((entry) => {
      const version = buildMockSkillVersion(fixture, entry);
      return {
        name: version.name,
        url: version.url,
        full_path: version.fullPath,
        storage_name: version.storageName,
        version_hash: version.versionHash,
        size: version.size,
        archive_size: version.archiveSize,
        file_count: version.fileCount,
        frontmatter: version.frontmatter,
      };
    }),
  });
}

function newCommitSha(): string {
  return randomUUID().replaceAll("-", "").padEnd(40, "a").slice(0, 40);
}

function createGitRefsResponse(commitSha: string): string {
  const header = "001e# service=git-upload-pack\n0000";
  const refLine = `003f${commitSha} refs/heads/main\n`;
  return header + refLine;
}

function buildMockTarball(mockSkills: readonly MockSkillEntry[]): Buffer {
  const tmpDir = mkdtempSync(join(tmpdir(), "okou-api-test-tarball-"));
  const prefix = `${DEFAULT_SKILLS_REPO}-${DEFAULT_SKILLS_BRANCH}`;

  mkdirSync(join(tmpDir, prefix), { recursive: true });
  const filePaths: string[] = [];

  for (const skill of mockSkills) {
    const skillDir = join(tmpDir, prefix, skill.name);
    mkdirSync(skillDir, { recursive: true });

    for (const file of skill.files) {
      const filePath = join(skillDir, file.path);
      mkdirSync(join(filePath, ".."), { recursive: true });
      writeFileSync(filePath, file.content);
      filePaths.push(join(prefix, skill.name, file.path));
    }
  }

  const tarPath = join(tmpDir, "test.tar.gz");
  createTar({ gzip: true, file: tarPath, cwd: tmpDir, sync: true }, filePaths);
  const tarball = readFileSync(tarPath);
  rmSync(tmpDir, { recursive: true, force: true });
  return tarball;
}

function memoizedTarballBuilder(): (
  mockSkills: readonly MockSkillEntry[],
) => Buffer {
  // Building a tarball involves heavy filesystem I/O (temp dirs, per-file
  // writes, gzip). The output is deterministic for the same entries, so cache
  // it to keep repeated full-seed tarball builds from timing out tests in CI.
  const cache = new Map<string, Buffer>();
  return (mockSkills) => {
    const cacheKey = JSON.stringify(mockSkills);
    const cached = cache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const tarball = buildMockTarball(mockSkills);
    cache.set(cacheKey, tarball);
    return tarball;
  };
}

const buildMemoizedMockTarball = memoizedTarballBuilder();

function createMockTarball(
  fixture: CronSyncSkillsFixture,
  mockSkills: readonly MockSkillEntry[],
): Buffer {
  registerOwnedEntries(fixture, mockSkills);
  return buildMemoizedMockTarball(mockSkills);
}

function seedSkillEntries(fixture: CronSyncSkillsFixture): MockSkillEntry[] {
  return fixture.requiredSeedSkillNames.map((name) => {
    return {
      name,
      files: [
        {
          path: "SKILL.md",
          content: `---\nname: ${name}\ndescription: ${name} skill\n---\n\n# ${name}\n`,
        },
      ],
    };
  });
}

function createFullTarball(
  fixture: CronSyncSkillsFixture,
  extras: readonly MockSkillEntry[],
): Buffer {
  return createMockTarball(fixture, [...seedSkillEntries(fixture), ...extras]);
}

function buildMockSkillVersion(
  fixture: CronSyncSkillsFixture,
  skill: MockSkillEntry,
): MockSkillVersion {
  const fullPath = `${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}/tree/${DEFAULT_SKILLS_BRANCH}/${skill.name}`;
  const storageName = getSkillStorageName(fullPath);
  const versionHash = computeMockSkillVersionHash(skill);
  return {
    name: skill.name,
    url: testSkillUrl(skill.name),
    fullPath,
    storageName,
    versionHash,
    size: skill.files.reduce((sum, file) => {
      return sum + Buffer.byteLength(file.content);
    }, 0),
    archiveSize: createMockTarball(fixture, [skill]).length,
    fileCount: skill.files.length,
    frontmatter: {
      name: skill.name,
      description: `${skill.name} skill`,
    },
  };
}

function computeMockSkillVersionHash(skill: MockSkillEntry): string {
  const fileEntries = skill.files
    .map((file) => {
      const hash = createHash("sha256").update(file.content).digest("hex");
      return `${file.path}:${hash}`;
    })
    .sort();
  return createHash("sha256")
    .update(
      `system-skill:${testSkillUrl(skill.name)}\n${fileEntries.join("\n")}`,
    )
    .digest("hex");
}

async function seedCurrentSeedSkillVersions(
  fixture: CronSyncSkillsFixture,
): Promise<void> {
  await seedCurrentSkillVersions(fixture, seedSkillEntries(fixture));
}

// The production cron scans every system skill. The existing prefix-scoped
// route runs that same sync against this test's owned names (API testing guide,
// Shared Persistent State); prior versions also go through GitHub and S3.
async function publishSeedSkills(
  fixture: CronSyncSkillsFixture,
): Promise<void> {
  const commitSha = newCommitSha();
  setupMswHandlers(commitSha, createFullTarball(fixture, []));
  await expect(syncOwnedSkills(fixture)).resolves.toStrictEqual({
    success: true,
    commitSha,
    synced: fixture.requiredSeedSkillNames.length,
    skipped: 0,
    failed: 0,
    removed: 0,
    total: fixture.requiredSeedSkillNames.length,
  });
  context.mocks.s3.send.mockClear();
}

async function publishSentinelSkill(
  fixture: CronSyncSkillsFixture,
  commitSha: string,
): Promise<void> {
  const name = fixture.sentinelSkillName;
  setupMswHandlers(
    commitSha,
    createMockTarball(fixture, [
      {
        name,
        files: [
          {
            path: "SKILL.md",
            content: `---\nname: ${name}\ndescription: Sentinel skill\n---\n\n# Sentinel`,
          },
        ],
      },
    ]),
  );
  await expect(
    syncOwnedSkillsState(context, {
      skillNamePrefix: name,
      requiredSkillNames: [],
    }),
  ).resolves.toStrictEqual({
    success: true,
    commitSha,
    synced: 1,
    skipped: 0,
    failed: 0,
    removed: 0,
    total: 1,
  });
  context.mocks.s3.send.mockClear();
}

async function expectCompletedCommit(
  fixture: CronSyncSkillsFixture,
  commitSha: string,
): Promise<void> {
  setupGitRefsHandler(commitSha);
  await expect(syncOwnedSkills(fixture)).resolves.toStrictEqual({
    success: true,
    commitSha,
    synced: 0,
    skipped: 0,
    failed: 0,
    removed: 0,
    total: 0,
  });
}

function useCronSyncSkillsFixture(): CronSyncSkillsFixture {
  const fixture = createCronSyncSkillsFixture();
  onTestFinished(async () => {
    await cleanupOwnedSkills(fixture);
  });
  return fixture;
}

function setupGitRefsHandler(commitSha: string): void {
  server.use(
    http.get("https://github.com/okou-ai/okou-skills.git/info/refs", () => {
      return new HttpResponse(createGitRefsResponse(commitSha));
    }),
  );
}

function setupMswHandlers(commitSha: string, tarball: Buffer): void {
  setupGitRefsHandler(commitSha);
  server.use(
    http.get(
      "https://codeload.github.com/okou-ai/okou-skills/tar.gz/refs/heads/main",
      () => {
        return new HttpResponse(tarball);
      },
    ),
  );
}

function commandName(command: unknown): string {
  return command instanceof Object && "constructor" in command
    ? command.constructor.name
    : "";
}

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command !== "object" ||
    command === null ||
    !("input" in command) ||
    typeof command.input !== "object" ||
    command.input === null
  ) {
    return {};
  }
  return command.input as Record<string, unknown>;
}

function s3CallsByName(name: string): unknown[] {
  return context.mocks.s3.send.mock.calls
    .map((call) => {
      return call[0];
    })
    .filter((command) => {
      return commandName(command) === name;
    });
}

function expectUploadedSkill(skill: MockSkillEntry): {
  readonly archiveKey: string;
  readonly archive: Buffer;
} {
  const versionHash = computeMockSkillVersionHash(skill);
  const uploads = s3CallsByName("PutObjectCommand").map(commandInput);
  const archives = uploads.filter((upload) => {
    return (
      typeof upload.Key === "string" &&
      upload.Key.endsWith(`/${versionHash}/archive.tar.gz`)
    );
  });
  expect(archives).toHaveLength(1);
  const archive = archives[0]!;
  if (typeof archive.Key !== "string" || !Buffer.isBuffer(archive.Body)) {
    throw new Error("Expected an uploaded skill archive");
  }
  const archiveKey = archive.Key;
  const manifests = uploads.filter((upload) => {
    return (
      upload.Key === archiveKey.replace(/archive\.tar\.gz$/, "manifest.json")
    );
  });
  expect(manifests).toHaveLength(1);
  const manifest = manifests[0]!;
  if (!Buffer.isBuffer(manifest.Body)) {
    throw new Error("Expected an uploaded skill manifest");
  }
  expect(JSON.parse(manifest.Body.toString("utf8"))).toMatchObject({
    version: 1,
    files: skill.files.map((file) => {
      return {
        path: file.path,
        hash: createHash("sha256").update(file.content).digest("hex"),
        size: Buffer.byteLength(file.content),
      };
    }),
  });
  const byPath = (left: { path: string }, right: { path: string }) => {
    return left.path.localeCompare(right.path);
  };
  expect([...extractFilesFromTarGz(archive.Body)].sort(byPath)).toStrictEqual(
    [...skill.files].sort(byPath),
  );
  return { archiveKey: archive.Key, archive: archive.Body };
}

function setupS3ListObjects(keys: readonly string[]): void {
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (commandName(command) === "ListObjectsV2Command") {
      return Promise.resolve({
        Contents: keys.map((key) => {
          return {
            Key: key,
            Size: 1,
            LastModified: new Date("2026-05-14T00:00:00.000Z"),
          };
        }),
      });
    }
    return Promise.resolve({});
  });
}

function testSkillUrl(name: string): string {
  return `https://github.com/${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}/tree/${DEFAULT_SKILLS_BRANCH}/${name}`;
}

async function findSkillByUrl(url: string): Promise<{
  readonly name: string;
  readonly fullPath: string;
  readonly commitSha: string | null;
  readonly versionHash: string | null;
  readonly fileCount: number;
  readonly frontmatter: unknown;
} | null> {
  return await findSkillByUrlState(context, url);
}

async function findSystemStorageByName(name: string): Promise<{
  readonly headVersionId: string | null;
  readonly s3Prefix: string;
  readonly size: number;
  readonly versionSize: number | null;
  readonly archiveSize: number | null;
} | null> {
  return await findSystemStorageByNameState(context, name);
}

describe("GET /api/cron/sync-skills", () => {
  beforeEach(() => {
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", BUCKET);
    context.mocks.s3.send.mockReset();
    context.mocks.s3.send.mockResolvedValue({});
  });

  it("skips sync when the stored commit SHA is unchanged", async () => {
    const fixture = useCronSyncSkillsFixture();
    const commitSha = newCommitSha();
    const sentinelCommitSha = newCommitSha();
    await publishSentinelSkill(fixture, sentinelCommitSha);
    setupMswHandlers(commitSha, createFullTarball(fixture, []));
    await expect(syncOwnedSkills(fixture)).resolves.toMatchObject({
      synced: fixture.requiredSeedSkillNames.length,
      failed: 0,
    });
    context.mocks.s3.send.mockClear();

    const response = await syncOwnedSkills(fixture);

    expect(response).toStrictEqual({
      success: true,
      commitSha,
      synced: 0,
      skipped: 0,
      failed: 0,
      removed: 0,
      total: 0,
    });
    expect(s3CallsByName("PutObjectCommand")).toHaveLength(0);
    setupGitRefsHandler(sentinelCommitSha);
    await expect(
      syncOwnedSkillsState(context, {
        skillNamePrefix: fixture.sentinelSkillName,
        requiredSkillNames: [],
      }),
    ).resolves.toStrictEqual({
      success: true,
      commitSha: sentinelCommitSha,
      synced: 0,
      skipped: 0,
      failed: 0,
      removed: 0,
      total: 0,
    });
  });

  it("does not skip when the matching commit is outside the active URL prefix", async () => {
    const fixture = useCronSyncSkillsFixture();
    const commitSha = newCommitSha();
    await publishSentinelSkill(fixture, commitSha);
    setupMswHandlers(
      commitSha,
      createFullTarball(fixture, [fixture.alphaSkill]),
    );

    const response = await syncOwnedSkills(fixture);

    expect(response).toStrictEqual({
      success: true,
      commitSha,
      synced: fixture.requiredSeedSkillNames.length + 1,
      skipped: 0,
      failed: 0,
      removed: 0,
      total: fixture.requiredSeedSkillNames.length + 1,
    });
    expectUploadedSkill(fixture.alphaSkill);
    await expectCompletedCommit(fixture, commitSha);
  });

  it("syncs new skills from the repository tarball", async () => {
    const fixture = useCronSyncSkillsFixture();
    const commitSha = newCommitSha();
    await publishSeedSkills(fixture);
    setupMswHandlers(
      commitSha,
      createFullTarball(fixture, [fixture.alphaSkill, fixture.betaSkill]),
    );

    const response = await syncOwnedSkills(fixture);

    expect(response).toStrictEqual({
      success: true,
      commitSha,
      synced: 2,
      skipped: fixture.requiredSeedSkillNames.length,
      failed: 0,
      removed: 0,
      total: fixture.requiredSeedSkillNames.length + 2,
    });

    expectUploadedSkill(fixture.alphaSkill);
    expectUploadedSkill(fixture.betaSkill);
    expect(s3CallsByName("PutObjectCommand")).toHaveLength(4);
    await expectCompletedCommit(fixture, commitSha);
  });

  it("syncs isolated counterparts for the current default seed skills", async () => {
    const fixture = useCronSyncSkillsFixture();
    const commitSha = newCommitSha();
    setupMswHandlers(commitSha, createFullTarball(fixture, []));
    const response = await syncOwnedSkills(fixture);

    expect(response).toStrictEqual({
      success: true,
      commitSha,
      synced: fixture.requiredSeedSkillNames.length,
      skipped: 0,
      failed: 0,
      removed: 0,
      total: fixture.requiredSeedSkillNames.length,
    });
    const archives = seedSkillEntries(fixture).map((skill) => {
      return expectUploadedSkill(skill);
    });
    const objectPrefixes = archives.map(({ archiveKey }) => {
      return archiveKey.slice(
        0,
        archiveKey.lastIndexOf("/", archiveKey.lastIndexOf("/") - 1),
      );
    });
    expect(new Set(objectPrefixes).size).toBe(
      fixture.requiredSeedSkillNames.length,
    );
    expect(s3CallsByName("PutObjectCommand")).toHaveLength(
      fixture.requiredSeedSkillNames.length * 2,
    );
    await expectCompletedCommit(fixture, commitSha);
  });

  it("excludes repository directories without a SKILL.md file", async () => {
    const fixture = useCronSyncSkillsFixture();
    const commitSha = newCommitSha();
    const nonSkillDirectory = {
      name: `${fixture.skillNamePrefix}no-skill-md`,
      files: [{ path: "README.md", content: "Not a skill." }],
    };
    await publishSeedSkills(fixture);
    setupMswHandlers(
      commitSha,
      createFullTarball(fixture, [
        fixture.alphaSkill,
        fixture.betaSkill,
        nonSkillDirectory,
      ]),
    );

    const response = await syncOwnedSkills(fixture);

    expect(response).toStrictEqual({
      success: true,
      commitSha,
      synced: 2,
      skipped: fixture.requiredSeedSkillNames.length,
      failed: 0,
      removed: 0,
      total: fixture.requiredSeedSkillNames.length + 2,
    });
    expectUploadedSkill(fixture.alphaSkill);
    expectUploadedSkill(fixture.betaSkill);
    expect(s3CallsByName("PutObjectCommand")).toHaveLength(4);
    await expectCompletedCommit(fixture, commitSha);
  });

  it("retries the same commit after a partial sync failure", async () => {
    const fixture = useCronSyncSkillsFixture();
    const commitSha = newCommitSha();
    const badSkillName = `${fixture.skillNamePrefix}bad-yaml`;
    const badSkill = {
      name: badSkillName,
      files: [
        {
          path: "SKILL.md",
          content: [
            "---",
            `name: ${badSkillName}`,
            "description:",
            "  - not_a_string",
            "- BAD_LINE",
            "---",
            "",
            "# Bad YAML Skill",
          ].join("\n"),
        },
      ],
    };
    await publishSeedSkills(fixture);
    setupMswHandlers(
      commitSha,
      createFullTarball(fixture, [fixture.alphaSkill, badSkill]),
    );

    const response = await syncOwnedSkills(fixture);

    expect(response).toStrictEqual({
      success: true,
      commitSha,
      synced: 1,
      skipped: fixture.requiredSeedSkillNames.length,
      failed: 1,
      removed: 0,
      total: fixture.requiredSeedSkillNames.length + 2,
    });
    expectUploadedSkill(fixture.alphaSkill);
    expect(s3CallsByName("PutObjectCommand")).toHaveLength(2);
    context.mocks.s3.send.mockClear();

    const repairedSkill = {
      ...badSkill,
      files: [
        {
          path: "SKILL.md",
          content: `---\nname: ${badSkillName}\ndescription: Repaired skill\n---\n\n# Repaired Skill`,
        },
      ],
    };
    setupMswHandlers(
      commitSha,
      createFullTarball(fixture, [fixture.alphaSkill, repairedSkill]),
    );

    const retryResponse = await syncOwnedSkills(fixture);

    expect(retryResponse).toStrictEqual({
      success: true,
      commitSha,
      synced: 1,
      skipped: fixture.requiredSeedSkillNames.length + 1,
      failed: 0,
      removed: 0,
      total: fixture.requiredSeedSkillNames.length + 2,
    });
    expectUploadedSkill(repairedSkill);
    expect(s3CallsByName("PutObjectCommand")).toHaveLength(2);
    await expectCompletedCommit(fixture, commitSha);
  });

  it("retains archive expansion limits when indexing unchanged skill versions", async () => {
    const fixture = useCronSyncSkillsFixture();
    const oversized: MockSkillEntry = {
      ...fixture.alphaSkill,
      files: [
        ...fixture.alphaSkill.files,
        { path: "large.bin", content: "x".repeat(65 * 1024 * 1024) },
      ],
    };
    // The old API can leave a current version without an index. Production
    // sync cannot create that historical state after synchronous indexing ships.
    await seedCurrentSkillVersions(fixture, [oversized]);
    const commitSha = newCommitSha();
    setupMswHandlers(commitSha, createFullTarball(fixture, [oversized]));
    const response = await syncOwnedSkills(fixture);
    expect(response).toMatchObject({ success: true, skipped: 1, failed: 0 });
    await expect(
      findSkillByUrl(testSkillUrl(oversized.name)),
    ).resolves.toMatchObject({ commitSha });
    // Indexability is internal worker state with no production read endpoint.
    // The tiny metadata projection must not admit this oversized archive.
    await expect(
      readPiResourceIndexStatusFixture(computeMockSkillVersionHash(oversized)),
    ).resolves.toBe("unindexable");
  }, 30_000);

  it("only uploads changed skills during incremental sync", async () => {
    const fixture = useCronSyncSkillsFixture();
    const firstCommitSha = newCommitSha();
    await publishSeedSkills(fixture);
    setupMswHandlers(
      firstCommitSha,
      createFullTarball(fixture, [fixture.alphaSkill, fixture.betaSkill]),
    );
    await syncOwnedSkills(fixture);

    context.mocks.s3.send.mockClear();
    const nextCommitSha = newCommitSha();
    const modifiedAlpha = {
      name: fixture.alphaSkill.name,
      files: [
        {
          path: "SKILL.md",
          content: [
            "---",
            `name: ${fixture.alphaSkill.name}`,
            "description: Updated alpha skill",
            "---",
            "",
            "# Alpha Skill v2",
          ].join("\n"),
        },
        { path: "index.ts", content: 'console.log("alpha v2");' },
      ],
    };
    setupMswHandlers(
      nextCommitSha,
      createFullTarball(fixture, [modifiedAlpha, fixture.betaSkill]),
    );

    const response = await syncOwnedSkills(fixture);

    expect(response).toStrictEqual({
      success: true,
      commitSha: nextCommitSha,
      synced: 1,
      skipped: fixture.requiredSeedSkillNames.length + 1,
      failed: 0,
      removed: 0,
      total: fixture.requiredSeedSkillNames.length + 2,
    });
    expect(s3CallsByName("PutObjectCommand")).toHaveLength(2);

    expectUploadedSkill(modifiedAlpha);
    await expectCompletedCommit(fixture, nextCommitSha);
  });

  it("reuses a previously registered skill version after A to B to A", async () => {
    const fixture = useCronSyncSkillsFixture();
    await seedCurrentSeedSkillVersions(fixture);
    const firstCommitSha = newCommitSha();
    setupMswHandlers(
      firstCommitSha,
      createFullTarball(fixture, [fixture.alphaSkill]),
    );
    await syncOwnedSkills(fixture);
    const firstVersion = buildMockSkillVersion(fixture, fixture.alphaSkill);
    const firstStorage = await findSystemStorageByName(
      firstVersion.storageName,
    );
    if (!firstStorage?.archiveSize) {
      throw new Error("Expected the first registered skill version");
    }

    const modifiedAlpha: MockSkillEntry = {
      ...fixture.alphaSkill,
      files: fixture.alphaSkill.files.map((file) => {
        return file.path === "SKILL.md"
          ? { ...file, content: `${file.content}\n\nVersion B.` }
          : file;
      }),
    };
    setupMswHandlers(
      newCommitSha(),
      createFullTarball(fixture, [modifiedAlpha]),
    );
    await syncOwnedSkills(fixture);
    context.mocks.s3.send.mockClear();

    const finalCommitSha = newCommitSha();
    setupMswHandlers(
      finalCommitSha,
      createFullTarball(fixture, [fixture.alphaSkill]),
    );
    const result = await syncOwnedSkills(fixture);

    expect(result).toMatchObject({ success: true, synced: 1, failed: 0 });
    expect(s3CallsByName("PutObjectCommand")).toHaveLength(0);
    expect(s3CallsByName("HeadObjectCommand")).toHaveLength(0);
    await expect(
      findSystemStorageByName(firstVersion.storageName),
    ).resolves.toMatchObject({
      headVersionId: firstVersion.versionHash,
      archiveSize: firstStorage.archiveSize,
    });
    await expect(
      findSkillByUrl(testSkillUrl(fixture.alphaSkill.name)),
    ).resolves.toMatchObject({ commitSha: finalCommitSha });
  });

  it.each(["archive.tar.gz", "manifest.json"])(
    "registers a new skill version only after its %s upload succeeds",
    async (filename) => {
      const fixture = useCronSyncSkillsFixture();
      await publishSeedSkills(fixture);
      const commitSha = newCommitSha();
      const tarball = createFullTarball(fixture, [fixture.alphaSkill]);
      setupMswHandlers(commitSha, tarball);
      const version = buildMockSkillVersion(fixture, fixture.alphaSkill);
      context.mocks.s3.send.mockImplementation((command: unknown) => {
        const key = commandInput(command).Key;
        if (
          commandName(command) === "PutObjectCommand" &&
          typeof key === "string" &&
          key.endsWith(`/${version.versionHash}/${filename}`)
        ) {
          return Promise.reject(new Error("Upload did not succeed"));
        }
        return Promise.resolve({});
      });
      await expect(syncOwnedSkills(fixture)).resolves.toMatchObject({
        synced: 0,
        failed: 1,
      });
      expect(s3CallsByName("PutObjectCommand")).toHaveLength(2);
      context.mocks.s3.send.mockClear();

      context.mocks.s3.send.mockResolvedValue({});
      await expect(syncOwnedSkills(fixture)).resolves.toMatchObject({
        synced: 1,
        failed: 0,
      });
      expectUploadedSkill(fixture.alphaSkill);
      expect(s3CallsByName("PutObjectCommand")).toHaveLength(2);
      await expectCompletedCommit(fixture, commitSha);
    },
  );

  it("records ready stable-context demand in the system-skill V2 transaction", async () => {
    const fixture = useCronSyncSkillsFixture();
    const firstCommitSha = newCommitSha();
    await seedCurrentSeedSkillVersions(fixture);
    setupMswHandlers(
      firstCommitSha,
      createFullTarball(fixture, [fixture.alphaSkill]),
    );
    await syncOwnedSkills(fixture);
    const alphaV1 = buildMockSkillVersion(fixture, fixture.alphaSkill);
    const alphaStorage = await findSystemStorageByName(alphaV1.storageName);
    if (!alphaStorage?.archiveSize) {
      throw new Error("Expected indexed system-skill V1 storage");
    }
    const orgId = `cron-skill-demand-${randomUUID()}`;
    const userId = `cron-skill-user-${randomUUID()}`;
    const user = bdd.user({ orgId, userId, orgRole: "org:admin" });
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(user, {
      displayName: "System skill demand Agent",
    });
    const headId = await seedPiStableContextStorageDemandFixture({
      orgId,
      userId,
      agentId: agent.agentId,
      storageName: alphaV1.storageName,
      versionId: alphaV1.versionHash,
      archiveSize: alphaStorage.archiveSize,
      resourceOrgId: SYSTEM_ORG_ID,
      resourceUserId: VOLUME_ORG_USER_ID,
      ready: true,
    });

    const alphaV2: MockSkillEntry = {
      name: fixture.alphaSkill.name,
      files: fixture.alphaSkill.files.map((file) => {
        return file.path === "SKILL.md"
          ? { ...file, content: `${file.content}\n\nV2 demand.` }
          : file;
      }),
    };
    const secondCommitSha = newCommitSha();
    setupMswHandlers(secondCommitSha, createFullTarball(fixture, [alphaV2]));
    await syncOwnedSkills(fixture);
    const expectedV2 = buildMockSkillVersion(fixture, alphaV2);
    await expect(
      readPiStableContextStorageDemandFixture(headId),
    ).resolves.toMatchObject({
      status: "pending",
      artifactDigest: null,
      input: {
        storageMounts: [{ versionId: expectedV2.versionHash }],
      },
    });

    const work = await accept(
      setupApp({ context, routes: testPiResourceIndexWorkRoutes })(
        testPiResourceIndexWorkContract,
      ).run({
        body: {
          versionIds: [expectedV2.versionHash],
          stableContextOwner: { orgId, userId, agentId: agent.agentId },
        },
      }),
      [200],
    );
    const completedHead = await readPiStableContextStorageDemandFixture(headId);
    expect({ work: work.body.stableContext, completedHead }).toMatchObject({
      work: {
        claimed: 1,
        ready: 1,
        pending: 0,
        unindexable: 0,
        failed: 0,
        stale: 0,
      },
      completedHead: {
        status: "ready",
        input: {
          storageMounts: [{ versionId: expectedV2.versionHash }],
        },
      },
    });
  });

  it("removes skills deleted from the source repository and cleans S3 objects", async () => {
    const fixture = useCronSyncSkillsFixture();
    const firstCommitSha = newCommitSha();
    await seedCurrentSeedSkillVersions(fixture);
    setupMswHandlers(
      firstCommitSha,
      createFullTarball(fixture, [fixture.alphaSkill, fixture.betaSkill]),
    );
    await syncOwnedSkills(fixture);

    const betaVersion = buildMockSkillVersion(fixture, fixture.betaSkill);
    const betaStorage = await findSystemStorageByName(betaVersion.storageName);
    if (!betaStorage?.archiveSize) {
      throw new Error("Expected the indexed beta skill storage");
    }
    const demandOrgId = `cron-skill-removal-${randomUUID()}`;
    const demandUserId = `cron-skill-removal-user-${randomUUID()}`;
    const demandUser = bdd.user({
      orgId: demandOrgId,
      userId: demandUserId,
      orgRole: "org:admin",
    });
    bdd.acceptAgentStorageWrites();
    const demandAgent = await bdd.createAgent(demandUser, {
      displayName: "Removed system skill Agent",
    });
    const demandHeadId = await seedPiStableContextStorageDemandFixture({
      orgId: demandOrgId,
      userId: demandUserId,
      agentId: demandAgent.agentId,
      storageName: betaVersion.storageName,
      versionId: betaVersion.versionHash,
      archiveSize: betaStorage.archiveSize,
      resourceOrgId: SYSTEM_ORG_ID,
      resourceUserId: VOLUME_ORG_USER_ID,
      ready: true,
    });
    const betaObjectKeys = [
      `${betaStorage.s3Prefix}/${betaVersion.versionHash}/archive.tar.gz`,
      `${betaStorage.s3Prefix}/${betaVersion.versionHash}/manifest.json`,
    ];
    setupS3ListObjects(betaObjectKeys);
    const sentinelCommitSha = newCommitSha();
    await setOwnedSkillsCommitSha(fixture, sentinelCommitSha, [
      fixture.sentinelSkillName,
    ]);
    const nextCommitSha = newCommitSha();
    setupMswHandlers(
      nextCommitSha,
      createFullTarball(fixture, [fixture.alphaSkill]),
    );

    const response = await syncOwnedSkills(fixture);

    expect(response).toStrictEqual({
      success: true,
      commitSha: nextCommitSha,
      synced: 0,
      skipped: fixture.requiredSeedSkillNames.length + 1,
      failed: 0,
      removed: 1,
      total: fixture.requiredSeedSkillNames.length + 1,
    });
    await expect(
      findSkillByUrl(testSkillUrl(fixture.betaSkill.name)),
    ).resolves.toBeNull();
    await expect(
      findSkillByUrl(testSkillUrl(fixture.alphaSkill.name)),
    ).resolves.not.toBeNull();
    await expect(
      findSkillByUrl(testSkillUrl(fixture.sentinelSkillName)),
    ).resolves.toMatchObject({ commitSha: sentinelCommitSha });
    await expect(
      readPiStableContextStorageDemandFixture(demandHeadId),
    ).resolves.toMatchObject({
      status: "missing",
      input: null,
      inputDigest: null,
      artifactDigest: null,
    });

    const deleteCommand = s3CallsByName("DeleteObjectsCommand")[0];
    expect(commandInput(deleteCommand)).toMatchObject({
      Bucket: BUCKET,
      Delete: {
        Objects: betaObjectKeys.map((key) => {
          return { Key: key };
        }),
      },
    });
  });

  it("keeps DB orphan removal when S3 cleanup fails", async () => {
    const fixture = useCronSyncSkillsFixture();
    const firstCommitSha = newCommitSha();
    await publishSeedSkills(fixture);
    setupMswHandlers(
      firstCommitSha,
      createFullTarball(fixture, [fixture.alphaSkill, fixture.betaSkill]),
    );
    await syncOwnedSkills(fixture);

    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (commandName(command) === "ListObjectsV2Command") {
        return Promise.reject(new Error("S3 connection failed"));
      }
      return Promise.resolve({});
    });
    const nextCommitSha = newCommitSha();
    setupMswHandlers(
      nextCommitSha,
      createFullTarball(fixture, [fixture.alphaSkill]),
    );

    const response = await syncOwnedSkills(fixture);

    expect(response).toStrictEqual({
      success: true,
      commitSha: nextCommitSha,
      synced: 0,
      skipped: fixture.requiredSeedSkillNames.length + 1,
      failed: 0,
      removed: 1,
      total: fixture.requiredSeedSkillNames.length + 1,
    });
    await expectCompletedCommit(fixture, nextCommitSha);
    context.mocks.s3.send.mockResolvedValue({});
    context.mocks.s3.send.mockClear();
    const restoredCommitSha = newCommitSha();
    setupMswHandlers(
      restoredCommitSha,
      createFullTarball(fixture, [fixture.alphaSkill, fixture.betaSkill]),
    );
    await expect(syncOwnedSkills(fixture)).resolves.toStrictEqual({
      success: true,
      commitSha: restoredCommitSha,
      synced: 1,
      skipped: fixture.requiredSeedSkillNames.length + 1,
      failed: 0,
      removed: 0,
      total: fixture.requiredSeedSkillNames.length + 2,
    });
    expectUploadedSkill(fixture.betaSkill);
    expect(s3CallsByName("PutObjectCommand")).toHaveLength(2);
  });

  it("restores missing required skills after a source rollback", async () => {
    const fixture = useCronSyncSkillsFixture();
    const omittedSkills = fixture.requiredSeedSkillNames.slice(0, 2);
    const omittedSkillSet = new Set(omittedSkills);
    const keptSkills = fixture.requiredSeedSkillNames.filter((name) => {
      return !omittedSkillSet.has(name);
    });
    const initialCommitSha = newCommitSha();
    setupMswHandlers(initialCommitSha, createFullTarball(fixture, []));
    await syncOwnedSkills(fixture);

    const removalCommitSha = newCommitSha();
    setupMswHandlers(
      removalCommitSha,
      createMockTarball(
        fixture,
        keptSkills.map((name) => {
          return {
            name,
            files: [
              {
                path: "SKILL.md",
                content: `---\nname: ${name}\ndescription: ${name} skill\n---\n\n# ${name}\n`,
              },
            ],
          };
        }),
      ),
    );

    const removalResponse = await syncOwnedSkills(fixture);

    expect(removalResponse).toStrictEqual({
      success: true,
      commitSha: removalCommitSha,
      synced: 0,
      skipped: keptSkills.length,
      failed: 0,
      removed: omittedSkills.length,
      total: keptSkills.length,
    });
    await expectCompletedCommit(fixture, removalCommitSha);
    context.mocks.s3.send.mockClear();

    setupMswHandlers(initialCommitSha, createFullTarball(fixture, []));
    const rollbackResponse = await syncOwnedSkills(fixture);

    expect(rollbackResponse).toStrictEqual({
      success: true,
      commitSha: initialCommitSha,
      synced: omittedSkills.length,
      skipped: keptSkills.length,
      failed: 0,
      removed: 0,
      total: fixture.requiredSeedSkillNames.length,
    });
    for (const skill of seedSkillEntries(fixture)) {
      if (omittedSkillSet.has(skill.name)) {
        expectUploadedSkill(skill);
      }
    }
    expect(s3CallsByName("PutObjectCommand")).toHaveLength(
      omittedSkills.length * 2,
    );
    await expectCompletedCommit(fixture, initialCommitSha);
  });
});
