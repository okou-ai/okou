import { createHash } from "node:crypto";
import { posix } from "node:path";

import {
  CANONICAL_WORKING_DIR,
  PI_AGENT_DIR,
  PI_SKILLS_ROOT,
  piResourceSnapshotSchema,
  type PiMemoryRecallSelection,
  type StoredStorageMountEntry,
} from "@okouai/api-contracts/contracts/runners";
import type { PiResourceSnapshot } from "@okouai/db/jsonb-contracts/pi-resource-snapshot";
import type {
  PiResourceIndexFile,
  PiResourceVersionIndex,
} from "@okouai/db/jsonb-contracts/pi-resource-version-index";
import { piResourceSnapshots } from "@okouai/db/schema/pi-resource-snapshot";
import { computed, type Computed } from "ccstate";
import { eq } from "drizzle-orm";
import ignore, { type Ignore } from "ignore";

import {
  CONTEXT_FILE_NAMES,
  IGNORE_FILE_NAMES,
  indexPiResourceArchive,
  PI_RESOURCE_EXTRACTOR_VERSION,
  readPiDiscoveryText,
  RESOURCE_ARCHIVE_MAX_BYTES,
} from "../../lib/pi-resource-index";
import type { Db } from "../external/db";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import { safeSync, settle, startUntrackedBestEffortCleanup } from "../utils";

import {
  publishPiResourceVersionIndex,
  readPiResourceVersionIndexes,
} from "./pi-resource-version-index.service";

const RESOURCE_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;

interface VirtualFile {
  readonly path: string;
  readonly content: string;
}

type VirtualFiles = ReadonlyMap<string, PiResourceIndexFile>;

export class UnsupportedPiResourceError extends Error {}

export class PiResourceSnapshotPreparationError extends Error {}

function resourcePreparationError(cause: unknown): Error {
  return new PiResourceSnapshotPreparationError(
    "Pi resource snapshot archive could not be prepared",
    { cause },
  );
}

function snapshotIdentity(
  mounts: readonly StoredStorageMountEntry[],
  memoryRecall?: PiMemoryRecallSelection,
): string {
  const mountIdentity = mounts.map((mount) => {
    return {
      versionId: mount.versionId,
      mountPath: mount.mountPath,
      instructionsTargetFilename: mount.instructionsTargetFilename ?? null,
      writeback: mount.writeback ?? false,
      empty: mount.empty ?? false,
    };
  });
  if (memoryRecall === undefined) {
    return JSON.stringify({ schemaVersion: 1, mounts: mountIdentity });
  }
  return JSON.stringify({
    schemaVersion: 2,
    mounts: mountIdentity,
    memoryRecall,
  });
}

function pathsOverlap(first: string, second: string): boolean {
  return (
    first === second ||
    first.startsWith(`${second}/`) ||
    second.startsWith(`${first}/`)
  );
}

export function piResourceDiscoveryMounts(
  mounts: readonly StoredStorageMountEntry[],
): readonly StoredStorageMountEntry[] {
  const contextDirectoriesForDiscovery = [
    PI_AGENT_DIR,
    ...contextDirectories(CANONICAL_WORKING_DIR),
  ];
  const resourceRoots = [
    PI_SKILLS_ROOT,
    `${PI_AGENT_DIR}/extensions`,
    `${PI_AGENT_DIR}/prompts`,
    `${PI_AGENT_DIR}/settings.json`,
    `${PI_AGENT_DIR}/SYSTEM.md`,
    `${PI_AGENT_DIR}/APPEND_SYSTEM.md`,
    `${CANONICAL_WORKING_DIR}/.pi/skills`,
    `${CANONICAL_WORKING_DIR}/.pi/extensions`,
    `${CANONICAL_WORKING_DIR}/.pi/prompts`,
    `${CANONICAL_WORKING_DIR}/.pi/settings.json`,
    `${CANONICAL_WORKING_DIR}/.pi/SYSTEM.md`,
    `${CANONICAL_WORKING_DIR}/.pi/APPEND_SYSTEM.md`,
  ];
  return mounts.filter((mount) => {
    const mountPath = posix.resolve("/", mount.mountPath);
    return (
      contextDirectoriesForDiscovery.some((directory) => {
        return mountPath === directory || directory.startsWith(`${mountPath}/`);
      }) ||
      resourceRoots.some((root) => {
        return pathsOverlap(mountPath, root);
      })
    );
  });
}

export function piResourceSnapshotDigest(
  mounts: readonly StoredStorageMountEntry[],
  memoryRecall?: PiMemoryRecallSelection,
): string {
  return createHash("sha256")
    .update(snapshotIdentity(mounts, memoryRecall))
    .digest("hex");
}

async function downloadArchive(
  mount: StoredStorageMountEntry,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  if (!mount.archiveUrl) {
    return null;
  }
  const expectedSize = safeSync(() => {
    return expectedArchiveSize(mount);
  });
  if ("error" in expectedSize) {
    throw resourcePreparationError(expectedSize.error);
  }
  const fetched = await settle(
    fetch(mount.archiveUrl, {
      cache: "no-store",
      signal,
    }),
    signal,
  );
  if (!fetched.ok) {
    throw resourcePreparationError(fetched.error);
  }
  const response = fetched.value;
  if (!response.ok) {
    throw resourcePreparationError(
      new Error(`Pi resource snapshot archive returned ${response.status}`),
    );
  }
  const validated = safeSync(() => {
    validateArchiveContentLength(response, expectedSize.ok);
  });
  if ("error" in validated) {
    throw resourcePreparationError(validated.error);
  }
  const body = await settle(readArchiveBody(response, expectedSize.ok), signal);
  if (!body.ok) {
    throw resourcePreparationError(body.error);
  }
  return body.value;
}

function expectedArchiveSize(mount: StoredStorageMountEntry): number {
  if (
    mount.archiveSize === undefined ||
    mount.archiveSize > RESOURCE_ARCHIVE_MAX_BYTES
  ) {
    throw new Error("Pi resource snapshot archive exceeds its size limit");
  }
  return mount.archiveSize;
}

function cancelResponseBody(response: Response): void {
  startUntrackedBestEffortCleanup(response.body?.cancel() ?? Promise.resolve());
}

function validateArchiveContentLength(
  response: Response,
  expectedSize: number,
): void {
  const declaredLengthHeader = response.headers.get("content-length");
  const declaredLength =
    declaredLengthHeader === null ? undefined : Number(declaredLengthHeader);
  if (
    declaredLength !== undefined &&
    (!Number.isSafeInteger(declaredLength) || declaredLength < 0)
  ) {
    cancelResponseBody(response);
    throw new Error("Pi resource snapshot Content-Length is invalid");
  }
  if (
    declaredLength !== undefined &&
    declaredLength > RESOURCE_ARCHIVE_MAX_BYTES
  ) {
    cancelResponseBody(response);
    throw new Error("Pi resource snapshot archive exceeds its size limit");
  }
  if (declaredLength !== undefined && declaredLength !== expectedSize) {
    cancelResponseBody(response);
    throw new Error(
      `Pi resource snapshot Content-Length ${declaredLength} does not match Storage ${expectedSize}`,
    );
  }
}

async function readArchiveBody(
  response: Response,
  expectedSize: number,
): Promise<Buffer> {
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      if (size !== expectedSize) {
        throw new Error(
          `Pi resource snapshot archive size ${size} does not match Storage ${expectedSize}`,
        );
      }
      return Buffer.concat(chunks, size);
    }
    size += value.byteLength;
    if (size > RESOURCE_ARCHIVE_MAX_BYTES) {
      startUntrackedBestEffortCleanup(reader.cancel());
      throw new Error("Pi resource snapshot archive exceeds its size limit");
    }
    chunks.push(Buffer.from(value));
  }
}

function mountedPath(mountPath: string, archivePath: string): string | null {
  const normalizedMount = posix.resolve("/", mountPath);
  const result = posix.resolve(normalizedMount, archivePath);
  return result === normalizedMount || result.startsWith(`${normalizedMount}/`)
    ? result
    : null;
}

function applyMount(
  files: Map<string, PiResourceIndexFile>,
  mount: StoredStorageMountEntry,
  projection: PiResourceVersionIndex | null,
): void {
  const mountPath = posix.resolve("/", mount.mountPath);
  for (const path of files.keys()) {
    if (path === mountPath || path.startsWith(`${mountPath}/`)) {
      files.delete(path);
    }
  }
  if (!projection) {
    return;
  }
  const extracted = projection.files;
  if (mount.instructionsTargetFilename) {
    const target = mount.instructionsTargetFilename;
    const source =
      extracted.find((file) => {
        return file.path === target;
      }) ??
      extracted.find((file) => {
        return (
          file.path === (target === "AGENTS.md" ? "CLAUDE.md" : "AGENTS.md")
        );
      });
    if (source) {
      files.set(posix.join(mountPath, target), source);
    }
    return;
  }
  for (const file of extracted) {
    const path = mountedPath(mountPath, file.path);
    if (path) {
      files.set(path, file);
    }
  }
}

function contextFileInDirectory(
  files: VirtualFiles,
  directory: string,
): VirtualFile | null {
  for (const name of CONTEXT_FILE_NAMES) {
    const path = posix.join(directory, name);
    const content = files.get(path);
    if (content !== undefined) {
      return { path, content: readPiDiscoveryText(content) };
    }
  }
  return null;
}

function contextDirectories(cwd: string): string[] {
  const directories: string[] = [];
  let current = posix.resolve("/", cwd);
  while (true) {
    directories.unshift(current);
    const parent = posix.dirname(current);
    if (parent === current) {
      return directories;
    }
    current = parent;
  }
}

function discoverAgentsFiles(
  files: VirtualFiles,
): PiResourceSnapshot["agentsFiles"] {
  const selected: VirtualFile[] = [];
  const global = contextFileInDirectory(files, PI_AGENT_DIR);
  if (global) {
    selected.push(global);
  }
  for (const directory of contextDirectories(CANONICAL_WORKING_DIR)) {
    const file = contextFileInDirectory(files, directory);
    if (file && file.path !== global?.path) {
      selected.push(file);
    }
  }
  return selected;
}

function directChildren(
  files: VirtualFiles,
  directory: string,
): { readonly files: string[]; readonly directories: string[] } {
  const fileNames = new Set<string>();
  const directoryNames = new Set<string>();
  const prefix = directory.endsWith("/") ? directory : `${directory}/`;
  for (const path of files.keys()) {
    if (!path.startsWith(prefix)) {
      continue;
    }
    const relative = path.slice(prefix.length);
    const separator = relative.indexOf("/");
    if (separator === -1) {
      fileNames.add(relative);
    } else {
      directoryNames.add(relative.slice(0, separator));
    }
  }
  return {
    files: [...fileNames].sort(),
    directories: [...directoryNames].sort(),
  };
}

function prefixedIgnorePattern(line: string, prefix: string): string | null {
  const trimmed = line.trim();
  if (
    !trimmed ||
    (trimmed.startsWith("#") && !trimmed.startsWith(String.raw`\#`))
  ) {
    return null;
  }
  let pattern = line;
  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith(String.raw`\!`)) {
    pattern = pattern.slice(1);
  }
  if (pattern.startsWith("/")) {
    pattern = pattern.slice(1);
  }
  const prefixed = prefix ? `${prefix}${pattern}` : pattern;
  return negated ? `!${prefixed}` : prefixed;
}

function addIgnoreRules(args: {
  readonly files: VirtualFiles;
  readonly directory: string;
  readonly rootDirectory: string;
  readonly matcher: Ignore;
}): void {
  const relativeDirectory = posix.relative(args.rootDirectory, args.directory);
  const prefix = relativeDirectory ? `${relativeDirectory}/` : "";
  for (const filename of IGNORE_FILE_NAMES) {
    const content = args.files.get(posix.join(args.directory, filename));
    if (content === undefined) {
      continue;
    }
    const patterns = readPiDiscoveryText(content)
      .split(/\r?\n/)
      .map((line) => {
        return prefixedIgnorePattern(line, prefix);
      })
      .filter((line): line is string => {
        return line !== null;
      });
    if (patterns.length > 0) {
      args.matcher.add(patterns);
    }
  }
}

function skillFromFile(args: {
  readonly files: VirtualFiles;
  readonly filePath: string;
  readonly scope: "user" | "project";
}): PiResourceSnapshot["skills"][number] | null {
  const content = args.files.get(args.filePath);
  if (content === undefined) {
    return null;
  }
  const frontmatter = content.skill;
  if (!frontmatter) {
    throw new Error("Pi resource index is missing selected skill metadata");
  }
  if (frontmatter.kind === "invalid_utf8") {
    throw new TypeError("The encoded data was not valid for encoding utf-8");
  }
  if (frontmatter.kind !== "skill") {
    throw new Error("Pi skill frontmatter is invalid");
  }
  if (!frontmatter.description?.trim()) {
    return null;
  }
  const baseDir = posix.dirname(args.filePath);
  return {
    name: frontmatter.name ?? posix.basename(baseDir),
    description: frontmatter.description,
    filePath: args.filePath,
    baseDir,
    scope: args.scope,
    disableModelInvocation: frontmatter.disableModelInvocation === true,
  };
}

function discoverSkillsInDirectory(args: {
  readonly files: VirtualFiles;
  readonly directory: string;
  readonly includeRootFiles: boolean;
  readonly scope: "user" | "project";
  readonly ignoreMatcher?: Ignore;
  readonly rootDirectory?: string;
}): PiResourceSnapshot["skills"] {
  const matcher = args.ignoreMatcher ?? ignore();
  const rootDirectory = args.rootDirectory ?? args.directory;
  addIgnoreRules({
    files: args.files,
    directory: args.directory,
    rootDirectory,
    matcher,
  });
  const children = directChildren(args.files, args.directory);
  const relativePath = (name: string): string => {
    return posix.relative(rootDirectory, posix.join(args.directory, name));
  };
  if (
    children.files.includes("SKILL.md") &&
    !matcher.ignores(relativePath("SKILL.md"))
  ) {
    const skill = skillFromFile({
      files: args.files,
      filePath: posix.join(args.directory, "SKILL.md"),
      scope: args.scope,
    });
    return skill ? [skill] : [];
  }
  const rootSkills = args.includeRootFiles
    ? children.files.flatMap((name) => {
        if (!name.endsWith(".md") || matcher.ignores(relativePath(name))) {
          return [];
        }
        const skill = skillFromFile({
          files: args.files,
          filePath: posix.join(args.directory, name),
          scope: args.scope,
        });
        return skill ? [skill] : [];
      })
    : [];
  const nestedSkills = children.directories.flatMap((name) => {
    if (
      name.startsWith(".") ||
      name === "node_modules" ||
      matcher.ignores(`${relativePath(name)}/`)
    ) {
      return [];
    }
    return discoverSkillsInDirectory({
      ...args,
      directory: posix.join(args.directory, name),
      includeRootFiles: false,
      ignoreMatcher: matcher,
      rootDirectory,
    });
  });
  return [...rootSkills, ...nestedSkills];
}

function discoverSkills(files: VirtualFiles): PiResourceSnapshot["skills"] {
  const byName = new Map<string, PiResourceSnapshot["skills"][number]>();
  for (const input of [
    { directory: PI_SKILLS_ROOT, scope: "user" as const },
    {
      directory: posix.join(CANONICAL_WORKING_DIR, ".pi", "skills"),
      scope: "project" as const,
    },
  ]) {
    for (const skill of discoverSkillsInDirectory({
      files,
      ...input,
      includeRootFiles: true,
    })) {
      if (!byName.has(skill.name)) {
        byName.set(skill.name, skill);
      }
    }
  }
  return [...byName.values()];
}

function hasUnsupportedPiResources(files: VirtualFiles): boolean {
  const prefixes = [
    `${PI_AGENT_DIR}/extensions/`,
    `${PI_AGENT_DIR}/prompts/`,
    `${CANONICAL_WORKING_DIR}/.pi/extensions/`,
    `${CANONICAL_WORKING_DIR}/.pi/prompts/`,
  ];
  return [...files.keys()].some((path) => {
    return (
      path === `${PI_AGENT_DIR}/settings.json` ||
      path === `${PI_AGENT_DIR}/SYSTEM.md` ||
      path === `${PI_AGENT_DIR}/APPEND_SYSTEM.md` ||
      path === `${CANONICAL_WORKING_DIR}/.pi/settings.json` ||
      path === `${CANONICAL_WORKING_DIR}/.pi/SYSTEM.md` ||
      path === `${CANONICAL_WORKING_DIR}/.pi/APPEND_SYSTEM.md` ||
      prefixes.some((prefix) => {
        return path.startsWith(prefix);
      })
    );
  });
}

export function buildPiResourceSnapshot(
  mounts: readonly StoredStorageMountEntry[],
  archives: readonly (Buffer | null)[],
  memoryRecall?: PiMemoryRecallSelection,
): PiResourceSnapshot {
  return buildPiResourceSnapshotFromIndexes(
    mounts,
    archives.map((archive) => {
      return archive ? indexPiResourceArchive(archive) : null;
    }),
    memoryRecall,
  );
}

export function buildPiResourceSnapshotFromIndexes(
  mounts: readonly StoredStorageMountEntry[],
  projections: readonly (PiResourceVersionIndex | null)[],
  memoryRecall?: PiMemoryRecallSelection,
): PiResourceSnapshot {
  const files = new Map<string, PiResourceIndexFile>();
  for (const [index, mount] of mounts.entries()) {
    applyMount(files, mount, projections[index] ?? null);
  }
  if (hasUnsupportedPiResources(files)) {
    throw new UnsupportedPiResourceError(
      "Pi resource snapshot does not support settings, extensions, or prompts",
    );
  }
  const agentsFiles = discoverAgentsFiles(files);
  const skills = discoverSkills(files);
  const snapshot: PiResourceSnapshot =
    memoryRecall === undefined
      ? { schemaVersion: 1, agentsFiles, skills }
      : { schemaVersion: 2, agentsFiles, skills, memoryRecall };
  if (
    Buffer.byteLength(JSON.stringify(snapshot), "utf8") >
    RESOURCE_SNAPSHOT_MAX_BYTES
  ) {
    throw new Error("Pi resource snapshot exceeds its size limit");
  }
  return piResourceSnapshotSchema.parse(snapshot);
}

async function loadResourceVersionIndexes(
  args: {
    readonly db: Db;
    readonly mounts: readonly StoredStorageMountEntry[];
  },
  signal?: AbortSignal,
) {
  const { mounts } = args;
  const lookupStartedAt = performance.now();
  const { indexes, misses } = await readPiResourceVersionIndexes(
    args.db,
    mounts.map((mount) => {
      return mount.versionId;
    }),
    signal,
  );
  const indexLookupMs = performance.now() - lookupStartedAt;
  let archiveMissCount = 0;
  let archiveBytes = 0;
  let archiveDownloadMs = 0;
  let archiveDecodeMs = 0;
  const pending = new Map<string, Promise<PiResourceVersionIndex | null>>();
  const projections = await Promise.all(
    mounts.map(async (mount) => {
      if (!mount.archiveUrl) {
        return null;
      }
      const indexed = indexes.get(mount.versionId);
      if (indexed) {
        if (
          indexed.storageId !== mount.storageId ||
          indexed.archiveSize !== mount.archiveSize
        ) {
          throw resourcePreparationError(
            new Error(
              "Pi resource index does not match the captured Storage version",
            ),
          );
        }
        return indexed.projection;
      }
      // Pending asynchronous writes and pre-index rollout versions both need
      // exact-version reads. Remove the latter case after #33619's backfill
      // and old-API rollback gates; pending writes remain a normal cache miss.
      const previous = pending.get(mount.versionId);
      if (previous) {
        return await previous;
      }
      const build = async () => {
        archiveMissCount++;
        const downloadStartedAt = performance.now();
        const archive = await downloadArchive(mount, signal);
        archiveDownloadMs += performance.now() - downloadStartedAt;
        if (!archive) {
          return null;
        }
        archiveBytes += archive.length;
        const decodeStartedAt = performance.now();
        const projection = indexPiResourceArchive(archive);
        archiveDecodeMs += performance.now() - decodeStartedAt;
        await publishPiResourceVersionIndex(
          {
            db: args.db,
            versionId: mount.versionId,
            projection,
            archiveSize: archive.length,
            source: "captured-read",
          },
          signal,
        );
        return projection;
      };
      const building = build();
      pending.set(mount.versionId, building);
      return await building;
    }),
  );
  return {
    projections,
    dimensions: {
      index_lookup_ms: indexLookupMs,
      index_hit_count: indexes.size,
      index_pending_count: misses.pending,
      index_running_count: misses.running,
      index_unindexable_count: misses.unindexable,
      index_legacy_missing_count: misses.missing,
      archive_miss_count: archiveMissCount,
      archive_bytes: archiveBytes,
      archive_download_sum_ms: archiveDownloadMs,
      archive_decode_ms: archiveDecodeMs,
    },
  };
}

export function preparePiResourceSnapshot(
  args: {
    readonly db: Db;
    readonly mounts: readonly StoredStorageMountEntry[];
    readonly memoryRecall?: PiMemoryRecallSelection;
    readonly runId?: string;
  },
  signal?: AbortSignal,
): Computed<
  Promise<{ readonly digest: string; readonly snapshot: PiResourceSnapshot }>
> {
  return computed(
    async (): Promise<{
      readonly digest: string;
      readonly snapshot: PiResourceSnapshot;
    }> => {
      const startedAt = performance.now();
      const mounts = piResourceDiscoveryMounts(args.mounts);
      const digest = piResourceSnapshotDigest(mounts, args.memoryRecall);
      // Cache generations are private; the launch's captured digest stays stable.
      const cacheKey = createHash("sha256")
        .update(`pi-resource-index:${PI_RESOURCE_EXTRACTOR_VERSION}:${digest}`)
        .digest("hex");
      const [existing] = await args.db
        .select({ snapshot: piResourceSnapshots.snapshot })
        .from(piResourceSnapshots)
        .where(eq(piResourceSnapshots.digest, cacheKey))
        .limit(1);
      const cacheLookupMs = performance.now() - startedAt;
      if (existing) {
        if (args.runId) {
          recordSandboxOperation({
            sandboxType: "runner",
            actionType: "pi_resource_snapshot_prepare",
            runId: args.runId,
            success: true,
            durationMs: performance.now() - startedAt,
            dimensions: { cache_hit: true, cache_lookup_ms: cacheLookupMs },
          });
        }
        return {
          digest,
          snapshot: piResourceSnapshotSchema.parse(existing.snapshot),
        };
      }
      const { projections, dimensions } = await loadResourceVersionIndexes(
        { db: args.db, mounts },
        signal,
      );
      const composeStartedAt = performance.now();
      const snapshot = buildPiResourceSnapshotFromIndexes(
        mounts,
        projections,
        args.memoryRecall,
      );
      const composeMs = performance.now() - composeStartedAt;
      await args.db
        .insert(piResourceSnapshots)
        .values({ digest: cacheKey, snapshot })
        .onConflictDoNothing();
      if (args.runId) {
        recordSandboxOperation({
          sandboxType: "runner",
          actionType: "pi_resource_snapshot_prepare",
          runId: args.runId,
          success: true,
          durationMs: performance.now() - startedAt,
          dimensions: {
            cache_hit: false,
            cache_lookup_ms: cacheLookupMs,
            ...dimensions,
            compose_ms: composeMs,
          },
        });
      }
      return { digest, snapshot };
    },
  );
}
