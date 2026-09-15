import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, posix } from "node:path";

import { PI_MEMORY_SUMMARY_MAX_BYTES } from "@okouai/api-contracts/contracts/runners";
import {
  MAX_FILE_SIZE_BYTES,
  STORAGE_MANIFEST_MAX_FILES,
  STORAGE_MANIFEST_MAX_PATH_BYTES,
} from "@okouai/api-contracts/contracts/storages";
import { parse as parseYaml } from "yaml";

import { piMemoryPhase2SelectionDigest } from "./phase2-memory-selection";
import {
  PI_MEMORY_PHASE2_MAX_CHANGED_SKILL_BYTES,
  PI_MEMORY_PHASE2_MAX_CHANGED_SKILL_FILE_BYTES,
  PI_MEMORY_PHASE2_MAX_CHANGED_SKILL_FILES,
  PI_MEMORY_PHASE2_MEMORY_MAX_BYTES,
  PI_MEMORY_PHASE2_PREPARED_MAX_BYTES,
  PI_MEMORY_PHASE2_WORKSPACE_DIFF_MAX_BYTES,
  type PiMemoryPhase2BaseFile,
  type PiMemoryPhase2LocalConsolidationArgs,
  type PiMemoryPhase2DiffSummary,
  type PiMemoryPhase2PreparedFile,
  type PiMemoryPhase2PreparedManifest,
  type PiMemoryPhase2SelectedSnapshot,
} from "./phase2-memory-types";

import {
  Phase2OutputInvalidError,
  phase2DiagnosticForError,
  phase2FileClass,
} from "./phase2-memory-diagnostics";

export const PI_MEMORY_PHASE2_MAX_SELECTED_CANDIDATES = 256;
export const PI_MEMORY_PHASE2_MAX_SELECTED_UTF8_BYTES = 21_036_800;
export const PI_MEMORY_PHASE2_EVIDENCE_SLUG_MAX_BYTES = 48;

const MANIFEST_DIGEST_ENCODING = "vm0.pi-memory.phase2.manifest.v1";
const PI_EVIDENCE_PREFIX = "rollout_summaries/pi/";
const MEMORY_FILE = "MEMORY.md";
const SUMMARY_FILE = "memory_summary.md";
const SAFE_SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_SKILL_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const MAX_SKILL_NAME_BYTES = 64;
const WINDOWS_DRIVE = /^[A-Za-z]:/u;
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export interface SnapshotPhase2Input {
  readonly memoryStorageId: string;
  readonly baseFiles: readonly SnapshotBaseFile[];
  readonly selected: readonly SnapshotSelected[];
  readonly model: Readonly<PiMemoryPhase2LocalConsolidationArgs["model"]>;
  readonly signal: AbortSignal;
  readonly selectionDigest: string;
  readonly baseTotalBytes: number;
}

export interface SnapshotBaseFile {
  readonly path: string;
  readonly hash: string;
  readonly size: number;
  readonly bytes: Buffer;
}

export interface SnapshotSelected {
  readonly piSessionId: string;
  readonly sourceRunId: string;
  readonly sourceHistoryHash: string;
  readonly sourceCompletedAt: string;
  readonly rawMemory: string;
  readonly rolloutSummary: string;
  readonly rolloutSlug: string | null;
}

export interface Phase2PrivateWorkspace {
  readonly root: string;
  readonly memoryRoot: string;
  readonly inputsRoot: string;
  readonly base: ReadonlyMap<string, Buffer>;
  readonly agentBaseline: ReadonlyMap<string, Buffer>;
  readonly diff: PiMemoryPhase2DiffSummary;
}

interface ValidatedPreparedSet {
  readonly files: readonly PiMemoryPhase2PreparedFile[];
  readonly manifest: PiMemoryPhase2PreparedManifest;
  readonly contentIdentity: string;
}

export class Phase2InputInvalidError extends Error {}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function uint32(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeUInt32BE(value);
  return result;
}

function framedHash(encoding: string, parts: readonly Buffer[]): string {
  const version = Buffer.from(encoding, "utf8");
  return createHash("sha256")
    .update(Buffer.concat([uint32(version.length), version, ...parts]))
    .digest("hex");
}

function assertSafeFilePath(path: string): void {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    WINDOWS_DRIVE.test(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.includes("//") ||
    posix.normalize(path) !== path
  ) {
    throw new Phase2InputInvalidError();
  }
  const segments = path.split("/");
  if (
    segments.some((segment) => {
      return segment.length === 0 || segment === "." || segment === "..";
    })
  ) {
    throw new Phase2InputInvalidError();
  }
}

function safeUtf8(value: string): boolean {
  try {
    return textDecoder.decode(Buffer.from(value, "utf8")) === value;
  } catch {
    return false;
  }
}

function comparePathHash(
  left: Pick<SnapshotBaseFile, "path" | "hash">,
  right: Pick<SnapshotBaseFile, "path" | "hash">,
): number {
  const pathOrder = compareText(left.path, right.path);
  return pathOrder === 0 ? compareText(left.hash, right.hash) : pathOrder;
}

function foldedPath(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase("en");
}

function validatePathKeys(paths: readonly string[]): void {
  const inventory = new Set(paths);
  if (inventory.size !== paths.length) {
    throw new Phase2InputInvalidError();
  }
  for (const path of paths) {
    for (
      let separator = path.indexOf("/");
      separator !== -1;
      separator = path.indexOf("/", separator + 1)
    ) {
      if (inventory.has(path.slice(0, separator))) {
        throw new Phase2InputInvalidError();
      }
    }
  }
}

function validatePathCollection(paths: readonly string[]): void {
  for (const path of paths) {
    assertSafeFilePath(path);
  }
  for (const collection of [paths, paths.map(foldedPath)]) {
    validatePathKeys(collection);
  }
}

function snapshotBaseFiles(files: readonly PiMemoryPhase2BaseFile[]): {
  readonly files: readonly SnapshotBaseFile[];
  readonly totalBytes: number;
} {
  if (files.length > STORAGE_MANIFEST_MAX_FILES) {
    throw new Phase2InputInvalidError();
  }
  let pathBytes = 0;
  let totalBytes = 0;
  for (const file of files) {
    if (
      file.type !== "file" ||
      !(file.bytes instanceof Uint8Array) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > MAX_FILE_SIZE_BYTES ||
      !SAFE_SHA256.test(file.hash)
    ) {
      throw new Phase2InputInvalidError();
    }
    assertSafeFilePath(file.path);
    pathBytes += byteLength(file.path);
    totalBytes += file.size;
    if (
      pathBytes > STORAGE_MANIFEST_MAX_PATH_BYTES ||
      totalBytes > PI_MEMORY_PHASE2_PREPARED_MAX_BYTES ||
      !Number.isSafeInteger(totalBytes)
    ) {
      throw new Phase2InputInvalidError();
    }
  }
  validatePathCollection(
    files.map((file) => {
      return file.path;
    }),
  );
  const snapshot: SnapshotBaseFile[] = files.map((file) => {
    const bytes = Buffer.from(file.bytes);
    if (bytes.length !== file.size || hashBytes(bytes) !== file.hash) {
      throw new Phase2InputInvalidError();
    }
    return Object.freeze({
      path: file.path,
      hash: file.hash,
      size: file.size,
      bytes,
    });
  });
  snapshot.sort(comparePathHash);
  return { files: Object.freeze(snapshot), totalBytes };
}

function assertSelectedCandidateShape(
  candidate: PiMemoryPhase2SelectedSnapshot,
): void {
  if (
    !(candidate.sourceCompletedAt instanceof Date) ||
    typeof candidate.piSessionId !== "string" ||
    typeof candidate.sourceRunId !== "string" ||
    typeof candidate.sourceHistoryHash !== "string" ||
    typeof candidate.rawMemory !== "string" ||
    typeof candidate.rolloutSummary !== "string" ||
    (candidate.rolloutSlug !== null &&
      typeof candidate.rolloutSlug !== "string")
  ) {
    throw new Phase2InputInvalidError();
  }
}

function assertSelectedCandidateContent(
  candidate: PiMemoryPhase2SelectedSnapshot,
  sessionIds: ReadonlySet<string>,
): void {
  if (
    candidate.piSessionId.length === 0 ||
    byteLength(candidate.piSessionId) > 255 ||
    candidate.sourceRunId.length === 0 ||
    byteLength(candidate.sourceRunId) > 255 ||
    !SAFE_SHA256.test(candidate.sourceHistoryHash) ||
    !Number.isFinite(candidate.sourceCompletedAt.getTime()) ||
    !safeUtf8(candidate.piSessionId) ||
    !safeUtf8(candidate.sourceRunId) ||
    !safeUtf8(candidate.rawMemory) ||
    !safeUtf8(candidate.rolloutSummary) ||
    (candidate.rolloutSlug !== null && !safeUtf8(candidate.rolloutSlug)) ||
    sessionIds.has(candidate.piSessionId)
  ) {
    throw new Phase2InputInvalidError();
  }
}

function snapshotSelected(
  selected: readonly PiMemoryPhase2SelectedSnapshot[],
): readonly SnapshotSelected[] {
  if (selected.length > PI_MEMORY_PHASE2_MAX_SELECTED_CANDIDATES) {
    throw new Phase2InputInvalidError();
  }
  const result: SnapshotSelected[] = [];
  const sessionIds = new Set<string>();
  let totalBytes = 0;
  for (const candidate of selected) {
    assertSelectedCandidateShape(candidate);
    assertSelectedCandidateContent(candidate, sessionIds);
    const completedAt = new Date(candidate.sourceCompletedAt.getTime());
    sessionIds.add(candidate.piSessionId);
    totalBytes +=
      byteLength(candidate.rawMemory) +
      byteLength(candidate.rolloutSummary) +
      byteLength(candidate.rolloutSlug ?? "");
    if (totalBytes > PI_MEMORY_PHASE2_MAX_SELECTED_UTF8_BYTES) {
      throw new Phase2InputInvalidError();
    }
    result.push(
      Object.freeze({
        piSessionId: candidate.piSessionId,
        sourceRunId: candidate.sourceRunId,
        sourceHistoryHash: candidate.sourceHistoryHash,
        sourceCompletedAt: completedAt.toISOString(),
        rawMemory: candidate.rawMemory,
        rolloutSummary: candidate.rolloutSummary,
        rolloutSlug: candidate.rolloutSlug,
      }),
    );
  }
  result.sort((left, right) => {
    return compareText(left.piSessionId, right.piSessionId);
  });
  return Object.freeze(result);
}

function snapshotModel(
  model: PiMemoryPhase2LocalConsolidationArgs["model"],
): Readonly<PiMemoryPhase2LocalConsolidationArgs["model"]> {
  const snapshot = structuredClone(model);
  if (snapshot.requestHeaders) Object.freeze(snapshot.requestHeaders);
  if (snapshot.bedrockAuth) Object.freeze(snapshot.bedrockAuth);
  return Object.freeze(snapshot);
}

export function snapshotPiMemoryPhase2Input(
  args: PiMemoryPhase2LocalConsolidationArgs,
  signal: AbortSignal,
): SnapshotPhase2Input {
  if (args.memoryStorageId.length === 0) {
    throw new Phase2InputInvalidError();
  }
  const base = snapshotBaseFiles(args.baseFiles);
  const selected = snapshotSelected(args.selected);
  return Object.freeze({
    memoryStorageId: args.memoryStorageId,
    baseFiles: base.files,
    selected,
    model: snapshotModel(args.model),
    signal,
    selectionDigest: piMemoryPhase2SelectionDigest(selected),
    baseTotalBytes: base.totalBytes,
  });
}

function safeEvidenceSlug(value: string | null): string | null {
  if (value === null || value.length === 0) {
    return null;
  }
  return `slug-${hashBytes(Buffer.from(value, "utf8")).slice(
    0,
    PI_MEMORY_PHASE2_EVIDENCE_SLUG_MAX_BYTES - 5,
  )}`;
}

export function piEvidencePath(
  piSessionId: string,
  rolloutSlug: string | null = null,
): string {
  const hash = hashBytes(Buffer.from(piSessionId, "utf8"));
  const slug = safeEvidenceSlug(rolloutSlug);
  return `${PI_EVIDENCE_PREFIX}${hash}${slug === null ? "" : `-${slug}`}.md`;
}

function renderPiEvidence(candidate: SnapshotSelected): Buffer {
  return Buffer.from(
    [
      `pi_session_id: ${JSON.stringify(candidate.piSessionId)}`,
      `source_run_id: ${JSON.stringify(candidate.sourceRunId)}`,
      `source_history_hash: ${JSON.stringify(candidate.sourceHistoryHash)}`,
      `source_completed_at: ${JSON.stringify(candidate.sourceCompletedAt)}`,
      "",
      candidate.rolloutSummary,
      "",
    ].join("\n"),
    "utf8",
  );
}

function renderPrivateRaw(selected: readonly SnapshotSelected[]): Buffer {
  const sections = selected.map((candidate) => {
    return [
      `## Pi session ${JSON.stringify(candidate.piSessionId)}`,
      `source_run_id: ${JSON.stringify(candidate.sourceRunId)}`,
      `source_history_hash: ${JSON.stringify(candidate.sourceHistoryHash)}`,
      `source_completed_at: ${JSON.stringify(candidate.sourceCompletedAt)}`,
      "",
      candidate.rawMemory,
    ].join("\n");
  });
  return Buffer.from(
    `# Private Pi Raw Memories\n\n${sections.join("\n\n")}\n`,
    "utf8",
  );
}

function requiredArtifactState(files: ReadonlyMap<string, Buffer>): string[] {
  const states: string[] = [];
  const memory = files.get(MEMORY_FILE);
  if (!memory || !validMemory(memory)) {
    states.push(`${MEMORY_FILE}: missing-or-invalid`);
  }
  const summary = files.get(SUMMARY_FILE);
  if (!summary || !validSummary(summary)) {
    states.push(`${SUMMARY_FILE}: missing-or-invalid`);
  }
  return states;
}

function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) {
    return value;
  }
  for (
    let length = Math.max(0, maxBytes);
    length >= Math.max(0, maxBytes - 3);
    length -= 1
  ) {
    try {
      return textDecoder.decode(bytes.subarray(0, length));
    } catch {
      continue;
    }
  }
  return "";
}

export function truncatePiMemoryPhase2WorkspaceDiff(value: string): {
  readonly content: Buffer;
  readonly truncated: boolean;
} {
  const content = Buffer.from(value, "utf8");
  if (content.length <= PI_MEMORY_PHASE2_WORKSPACE_DIFF_MAX_BYTES) {
    return { content, truncated: false };
  }
  const suffix = "\n[workspace diff truncated]\n";
  const prefix = utf8Prefix(
    value,
    PI_MEMORY_PHASE2_WORKSPACE_DIFF_MAX_BYTES - byteLength(suffix),
  );
  return {
    content: Buffer.from(`${prefix}${suffix}`, "utf8"),
    truncated: true,
  };
}

function renderPrivateDiff(
  base: ReadonlyMap<string, Buffer>,
  agentBaseline: ReadonlyMap<string, Buffer>,
): { readonly content: Buffer; readonly summary: PiMemoryPhase2DiffSummary } {
  const added: string[] = [];
  const changed: string[] = [];
  const deleted: string[] = [];
  for (const [path, content] of agentBaseline) {
    const previous = base.get(path);
    if (!previous) {
      added.push(path);
    } else if (!previous.equals(content)) {
      changed.push(path);
    }
  }
  for (const path of base.keys()) {
    if (!agentBaseline.has(path)) {
      deleted.push(path);
    }
  }
  added.sort();
  changed.sort();
  deleted.sort();
  const lines = [
    "# Private Pi Memory Workspace Diff",
    "",
    "Generated by the Phase 2 engine. Read first; do not edit.",
    "",
    "## Pi evidence changes",
    ...added.map((path) => {
      return `- added ${path}`;
    }),
    ...changed.map((path) => {
      return `- changed ${path}`;
    }),
    ...deleted.map((path) => {
      return `- deleted ${path}`;
    }),
    ...(added.length + changed.length + deleted.length === 0 ? ["- none"] : []),
    "",
    "## Required consolidated outputs",
    ...requiredArtifactState(agentBaseline).map((state) => {
      return `- ${state}`;
    }),
    ...(requiredArtifactState(agentBaseline).length === 0 ? ["- valid"] : []),
    "",
  ];
  const unbounded = lines.join("\n");
  const bounded = truncatePiMemoryPhase2WorkspaceDiff(unbounded);
  const content = bounded.content;
  return {
    content,
    summary: {
      added: added.length,
      changed: changed.length,
      deleted: deleted.length,
      renderedBytes: content.length,
      truncated: bounded.truncated,
      digest: hashBytes(content),
    },
  };
}

async function writeWorkspaceFile(
  root: string,
  path: string,
  content: Uint8Array,
): Promise<void> {
  const target = join(root, ...path.split("/"));
  await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, content, { mode: 0o600 });
}

async function makeGitCopyReadOnly(memoryRoot: string): Promise<void> {
  const gitRoot = join(memoryRoot, ".git");
  try {
    const rootStat = await fs.lstat(gitRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Phase2InputInvalidError();
    }
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
  const directories = [gitRoot];
  const files: string[] = [];
  while (directories.length > 0) {
    const directory = directories.pop();
    if (!directory) {
      break;
    }
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const stat = await fs.lstat(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new Phase2InputInvalidError();
      }
      if (stat.isDirectory()) {
        directories.push(path);
      } else {
        files.push(path);
      }
    }
  }
  await Promise.all(
    files.map((path) => {
      return fs.chmod(path, 0o400);
    }),
  );
  const allDirectories = [gitRoot];
  while (allDirectories.length > 0) {
    const directory = allDirectories.pop();
    if (!directory) {
      break;
    }
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        allDirectories.push(join(directory, entry.name));
      }
    }
    await fs.chmod(directory, 0o500);
  }
}

export async function createPiMemoryPhase2Workspace(
  root: string,
  input: SnapshotPhase2Input,
): Promise<Phase2PrivateWorkspace> {
  const memoryRoot = join(root, "memory");
  const inputsRoot = join(root, "inputs");
  await fs.mkdir(memoryRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(inputsRoot, { recursive: true, mode: 0o700 });
  const base = new Map<string, Buffer>();
  for (const file of input.baseFiles) {
    base.set(file.path, Buffer.from(file.bytes));
    await writeWorkspaceFile(memoryRoot, file.path, file.bytes);
  }

  const agentBaseline = new Map(base);
  for (const path of agentBaseline.keys()) {
    if (path.startsWith(PI_EVIDENCE_PREFIX)) {
      agentBaseline.delete(path);
    }
  }
  await fs.rm(join(memoryRoot, "rollout_summaries", "pi"), {
    recursive: true,
    force: true,
  });
  for (const candidate of input.selected) {
    const path = piEvidencePath(candidate.piSessionId, candidate.rolloutSlug);
    const content = renderPiEvidence(candidate);
    agentBaseline.set(path, content);
    await writeWorkspaceFile(memoryRoot, path, content);
  }

  const privateRaw = renderPrivateRaw(input.selected);
  await writeWorkspaceFile(inputsRoot, "raw-memories.md", privateRaw);
  const diff = renderPrivateDiff(base, agentBaseline);
  await writeWorkspaceFile(inputsRoot, "workspace-diff.md", diff.content);
  await makeGitCopyReadOnly(memoryRoot);
  return {
    root,
    memoryRoot,
    inputsRoot,
    base,
    agentBaseline,
    diff: diff.summary,
  };
}

function decodeUtf8(content: Uint8Array): string | null {
  try {
    return textDecoder.decode(content);
  } catch {
    return null;
  }
}

function validMemory(content: Buffer): boolean {
  const decoded = decodeUtf8(content);
  return (
    decoded !== null &&
    decoded.trim().length > 0 &&
    content.length <= PI_MEMORY_PHASE2_MEMORY_MAX_BYTES
  );
}

function summaryFailure(content: Buffer) {
  const details = { fileClass: "summary" as const };
  const decoded = decodeUtf8(content);
  if (decoded === null)
    return new Phase2OutputInvalidError("summary_encoding", details);
  if (decoded.split(/\r?\n/u)[0] !== "v1")
    return new Phase2OutputInvalidError("summary_header", details);
  if (content.length > PI_MEMORY_SUMMARY_MAX_BYTES) {
    return new Phase2OutputInvalidError("summary_bytes", {
      ...details,
      actual: content.length,
      limit: PI_MEMORY_SUMMARY_MAX_BYTES,
    });
  }
  // The exact o200k budget belongs to the summary excerpt injected into a
  // prompt, not to the stored source. A valid source within the byte ceiling
  // publishes in full and the shared recall renderer bounds what is injected.
  return undefined;
}

function validSummary(content: Buffer): boolean {
  return summaryFailure(content) === undefined;
}

export function baseHasValidConsolidatedArtifacts(
  files: ReadonlyMap<string, Buffer>,
): boolean {
  const memory = files.get(MEMORY_FILE);
  const summary = files.get(SUMMARY_FILE);
  return (
    memory !== undefined &&
    summary !== undefined &&
    validMemory(memory) &&
    validSummary(summary)
  );
}

function outputPathAllowed(path: string): boolean {
  return (
    path === MEMORY_FILE || path === SUMMARY_FILE || path.startsWith("skills/")
  );
}

function validChangedSkillPath(path: string): boolean {
  const segments = path.split("/").slice(1);
  const [skillName, ...children] = segments;
  return (
    skillName !== undefined &&
    byteLength(skillName) <= MAX_SKILL_NAME_BYTES &&
    SAFE_SKILL_NAME.test(skillName) &&
    children.length > 0 &&
    children.every((segment) => {
      return SAFE_SKILL_COMPONENT.test(segment);
    })
  );
}

function validSkillManifest(content: Buffer, expectedName: string): boolean {
  const decoded = decodeUtf8(content);
  if (decoded === null || !decoded.startsWith("---")) {
    return false;
  }
  try {
    const frontmatter = decoded.match(
      /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u,
    )?.[1];
    if (frontmatter === undefined) {
      return false;
    }
    const parsed: unknown = parseYaml(frontmatter);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return false;
    }
    const fields = parsed as Record<string, unknown>;
    return (
      fields.name === expectedName &&
      typeof fields.description === "string" &&
      fields.description.trim().length > 0
    );
  } catch {
    return false;
  }
}

async function inventoryFiles(
  memoryRoot: string,
): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  const pending: Array<{ readonly path: string; readonly relative: string }> = [
    { path: memoryRoot, relative: "" },
  ];
  let pathBytes = 0;
  let totalBytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) {
      break;
    }
    const directoryStat = await fs.lstat(directory.path, { bigint: true });
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Phase2OutputInvalidError("unsafe_tree", { fileClass: "tree" });
    }
    const entries = await fs.readdir(directory.path, { withFileTypes: true });
    entries.sort((left, right) => {
      return compareText(left.name, right.name);
    });
    for (const entry of entries) {
      const relative = directory.relative
        ? `${directory.relative}/${entry.name}`
        : entry.name;
      try {
        assertSafeFilePath(relative);
      } catch {
        throw new Phase2OutputInvalidError("unsafe_path", {
          fileClass: phase2FileClass(relative),
        });
      }
      const path = join(directory.path, entry.name);
      const stat = await fs.lstat(path, { bigint: true });
      if (stat.isSymbolicLink()) {
        throw new Phase2OutputInvalidError("unsafe_tree", {
          fileClass: phase2FileClass(relative),
        });
      }
      if (stat.isDirectory()) {
        pending.push({ path, relative });
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1n) {
        throw new Phase2OutputInvalidError("unsafe_tree", {
          fileClass: phase2FileClass(relative),
        });
      }
      if (stat.size > BigInt(MAX_FILE_SIZE_BYTES)) {
        throw new Phase2OutputInvalidError("file_size", {
          fileClass: phase2FileClass(relative),
          actual: Number(stat.size),
          limit: MAX_FILE_SIZE_BYTES,
        });
      }
      const content = await fs.readFile(path);
      if (BigInt(content.length) !== stat.size) {
        throw new Phase2OutputInvalidError("file_integrity", {
          fileClass: phase2FileClass(relative),
        });
      }
      pathBytes += byteLength(relative);
      totalBytes += content.length;
      if (result.size >= STORAGE_MANIFEST_MAX_FILES) {
        throw new Phase2OutputInvalidError("inventory_files", {
          actual: result.size + 1,
          limit: STORAGE_MANIFEST_MAX_FILES,
        });
      }
      if (pathBytes > STORAGE_MANIFEST_MAX_PATH_BYTES) {
        throw new Phase2OutputInvalidError("inventory_paths", {
          actual: pathBytes,
          limit: STORAGE_MANIFEST_MAX_PATH_BYTES,
        });
      }
      if (totalBytes > PI_MEMORY_PHASE2_PREPARED_MAX_BYTES) {
        throw new Phase2OutputInvalidError("inventory_bytes", {
          actual: totalBytes,
          limit: PI_MEMORY_PHASE2_PREPARED_MAX_BYTES,
        });
      }
      result.set(relative, content);
    }
  }
  try {
    validatePathCollection([...result.keys()]);
  } catch {
    throw new Phase2OutputInvalidError("unsafe_path", { fileClass: "tree" });
  }
  return result;
}

/** Read the exact mounted memory tree without reconstructing it from Storage. */
export async function snapshotMountedPiMemoryPhase2Base(
  memoryRoot: string,
): Promise<readonly PiMemoryPhase2BaseFile[]> {
  let files: Map<string, Buffer>;
  try {
    files = await inventoryFiles(memoryRoot);
  } catch {
    throw new Phase2InputInvalidError();
  }
  return [...files]
    .map(([path, bytes]) => {
      return Object.freeze({
        type: "file" as const,
        path,
        hash: hashBytes(bytes),
        size: bytes.length,
        bytes: Buffer.from(bytes),
      });
    })
    .sort(comparePathHash);
}

async function removeEmptyDirectories(
  root: string,
  relative = "",
): Promise<void> {
  const directory = relative ? join(root, ...relative.split("/")) : root;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    await removeEmptyDirectories(root, child);
  }
  if (relative && (await fs.readdir(directory)).length === 0) {
    await fs.rmdir(directory);
  }
}

/**
 * Commit an already validated result to the mounted memory tree. The exact
 * base is rechecked first so the sandbox cannot apply a prepared result to a
 * different mount epoch.
 */
export async function applyValidatedPiMemoryPhase2Result(args: {
  readonly memoryRoot: string;
  readonly memoryStorageId: string;
  readonly baseFiles: readonly PiMemoryPhase2BaseFile[];
  readonly files: readonly PiMemoryPhase2PreparedFile[];
  readonly contentIdentity: string;
}): Promise<void> {
  try {
    const expectedBase = snapshotBaseFiles(args.baseFiles).files;
    // Keep our own authenticated bytes across filesystem awaits. Readonly
    // metadata does not make a caller's Uint8Array immutable.
    const prepared = new Map<string, Buffer>();
    for (const file of args.files) {
      const bytes = Buffer.from(file.bytes);
      if (
        bytes.length !== file.size ||
        hashBytes(bytes) !== file.hash ||
        prepared.has(file.path)
      ) {
        throw new Phase2OutputInvalidError("file_integrity", {
          fileClass: phase2FileClass(file.path),
        });
      }
      prepared.set(file.path, bytes);
    }

    const mountedBefore = await inventoryFiles(args.memoryRoot);
    const expectedBaseMap = new Map(
      expectedBase.map((file) => {
        return [file.path, file.bytes] as const;
      }),
    );
    if (!mapsEqual(mountedBefore, expectedBaseMap)) {
      throw new Phase2OutputInvalidError("base_mismatch");
    }

    for (const path of mountedBefore.keys()) {
      if (!prepared.has(path)) {
        try {
          await fs.unlink(join(args.memoryRoot, ...path.split("/")));
        } catch (error) {
          const diagnostic = phase2DiagnosticForError(
            error,
            "mounted_apply",
            phase2FileClass(path),
          );
          throw new Phase2OutputInvalidError(
            diagnostic.reason,
            diagnostic,
            "mounted_apply",
          );
        }
      }
    }
    for (const [path, bytes] of prepared) {
      // Exact-base verification above makes these bytes authoritative. Preserve
      // unchanged files (including read-only Git objects) and their permissions.
      if (mountedBefore.get(path)?.equals(bytes)) continue;
      try {
        await writeWorkspaceFile(args.memoryRoot, path, bytes);
      } catch (error) {
        const diagnostic = phase2DiagnosticForError(
          error,
          "mounted_apply",
          phase2FileClass(path),
        );
        throw new Phase2OutputInvalidError(
          diagnostic.reason,
          diagnostic,
          "mounted_apply",
        );
      }
    }
    await removeEmptyDirectories(args.memoryRoot);

    const mountedAfter = await inventoryFiles(args.memoryRoot);
    const committed = manifestForFiles(args.memoryStorageId, mountedAfter);
    if (
      !mapsEqual(mountedAfter, prepared) ||
      committed.contentIdentity !== args.contentIdentity
    ) {
      throw new Phase2OutputInvalidError("final_identity");
    }
  } catch (error) {
    const diagnostic = phase2DiagnosticForError(error, "mounted_apply");
    throw new Phase2OutputInvalidError(
      diagnostic.reason,
      diagnostic,
      "mounted_apply",
    );
  }
}

function validateImmutablePaths(
  finalFiles: ReadonlyMap<string, Buffer>,
  baseline: ReadonlyMap<string, Buffer>,
): void {
  const allPaths = new Set([...finalFiles.keys(), ...baseline.keys()]);
  for (const path of allPaths) {
    if (outputPathAllowed(path)) {
      continue;
    }
    const before = baseline.get(path);
    const after = finalFiles.get(path);
    if (!before || !after || !before.equals(after)) {
      throw new Phase2OutputInvalidError("immutable_changed", {
        fileClass: phase2FileClass(path),
      });
    }
  }
}

function validateChangedSkills(
  finalFiles: ReadonlyMap<string, Buffer>,
  baseline: ReadonlyMap<string, Buffer>,
): void {
  const changed = [...new Set([...finalFiles.keys(), ...baseline.keys()])]
    .filter((path) => {
      return path.startsWith("skills/");
    })
    .filter((path) => {
      const before = baseline.get(path);
      const after = finalFiles.get(path);
      return !before || !after || !before.equals(after);
    });
  if (changed.length > PI_MEMORY_PHASE2_MAX_CHANGED_SKILL_FILES) {
    throw new Phase2OutputInvalidError("skill_files", {
      fileClass: "skill",
      actual: changed.length,
      limit: PI_MEMORY_PHASE2_MAX_CHANGED_SKILL_FILES,
    });
  }
  let totalBytes = 0;
  const newSkillNames = new Set<string>();
  const changedSkillManifests = new Set<string>();
  for (const path of changed) {
    if (!validChangedSkillPath(path)) {
      throw new Phase2OutputInvalidError("skill_path", { fileClass: "skill" });
    }
    const content = finalFiles.get(path);
    if (content) {
      if (content.length > PI_MEMORY_PHASE2_MAX_CHANGED_SKILL_FILE_BYTES) {
        throw new Phase2OutputInvalidError("skill_file_bytes", {
          fileClass: "skill",
          actual: content.length,
          limit: PI_MEMORY_PHASE2_MAX_CHANGED_SKILL_FILE_BYTES,
        });
      }
      if (decodeUtf8(content) === null) {
        throw new Phase2OutputInvalidError("skill_encoding", {
          fileClass: "skill",
        });
      }
      totalBytes += content.length;
      const skillName = path.split("/")[1];
      if (skillName !== undefined && path === `skills/${skillName}/SKILL.md`) {
        changedSkillManifests.add(skillName);
      }
      if (
        skillName !== undefined &&
        ![...baseline.keys()].some((basePath) => {
          return basePath.startsWith(`skills/${skillName}/`);
        })
      ) {
        newSkillNames.add(skillName);
      }
    }
  }
  if (totalBytes > PI_MEMORY_PHASE2_MAX_CHANGED_SKILL_BYTES) {
    throw new Phase2OutputInvalidError("skill_bytes", {
      fileClass: "skill",
      actual: totalBytes,
      limit: PI_MEMORY_PHASE2_MAX_CHANGED_SKILL_BYTES,
    });
  }
  for (const skillName of changedSkillManifests) {
    const manifest = finalFiles.get(`skills/${skillName}/SKILL.md`);
    if (!manifest || !validSkillManifest(manifest, skillName)) {
      throw new Phase2OutputInvalidError("skill_manifest", {
        fileClass: "skill",
      });
    }
  }
  for (const skillName of newSkillNames) {
    const manifest = finalFiles.get(`skills/${skillName}/SKILL.md`);
    if (!manifest || !validSkillManifest(manifest, skillName)) {
      throw new Phase2OutputInvalidError("skill_manifest", {
        fileClass: "skill",
      });
    }
  }
}

function manifestForFiles(
  storageId: string,
  files: ReadonlyMap<string, Buffer>,
): ValidatedPreparedSet {
  const prepared = [...files].map(([path, content]) => {
    const hash = hashBytes(content);
    return Object.freeze({
      path,
      hash,
      size: content.length,
      bytes: Buffer.from(content),
    });
  });
  prepared.sort(comparePathHash);
  const preparedFiles = Object.freeze(prepared);
  const manifestFiles = Object.freeze(
    preparedFiles.map((file) => {
      return Object.freeze({
        path: file.path,
        hash: file.hash,
        size: file.size,
      });
    }),
  );
  const parts: Buffer[] = [uint32(manifestFiles.length)];
  for (const file of manifestFiles) {
    const path = Buffer.from(file.path, "utf8");
    const hash = Buffer.from(file.hash, "utf8");
    parts.push(
      uint32(path.length),
      path,
      uint32(hash.length),
      hash,
      uint32(file.size),
    );
  }
  const totalBytes = manifestFiles.reduce((sum, file) => {
    return sum + file.size;
  }, 0);
  const pathBytes = manifestFiles.reduce((sum, file) => {
    return sum + byteLength(file.path);
  }, 0);
  const contentLines = manifestFiles
    .map((file) => {
      return `${file.path}:${file.hash}`;
    })
    .sort();
  const contentIdentity = createHash("sha256")
    .update(`storage:${storageId}\n${contentLines.join("\n")}`)
    .digest("hex");
  return Object.freeze({
    files: preparedFiles,
    manifest: Object.freeze({
      version: 1,
      files: manifestFiles,
      fileCount: manifestFiles.length,
      pathBytes,
      totalBytes,
      digest: framedHash(MANIFEST_DIGEST_ENCODING, parts),
    }),
    contentIdentity,
  });
}

export async function validatePiMemoryPhase2Output(
  workspace: Phase2PrivateWorkspace,
  storageId: string,
): Promise<ValidatedPreparedSet> {
  try {
    const finalFiles = await inventoryFiles(workspace.memoryRoot);
    validateImmutablePaths(finalFiles, workspace.agentBaseline);
    const memory = finalFiles.get(MEMORY_FILE);
    const summary = finalFiles.get(SUMMARY_FILE);
    if (memory === undefined || summary === undefined) {
      throw new Phase2OutputInvalidError("required_artifact", {
        fileClass: memory === undefined ? "memory" : "summary",
      });
    }
    if (memory.length > PI_MEMORY_PHASE2_MEMORY_MAX_BYTES) {
      throw new Phase2OutputInvalidError("memory_bytes", {
        fileClass: "memory",
        actual: memory.length,
        limit: PI_MEMORY_PHASE2_MEMORY_MAX_BYTES,
      });
    }
    if (!validMemory(memory))
      throw new Phase2OutputInvalidError("memory_invalid", {
        fileClass: "memory",
      });
    const invalidSummary = summaryFailure(summary);
    if (invalidSummary) throw invalidSummary;
    validateChangedSkills(finalFiles, workspace.agentBaseline);
    return manifestForFiles(storageId, finalFiles);
  } catch (error) {
    if (error instanceof Phase2OutputInvalidError) throw error;
    const diagnostic = phase2DiagnosticForError(error, "output_validation");
    throw new Phase2OutputInvalidError(diagnostic.reason, diagnostic);
  }
}

export function preparedSetFromSnapshot(
  storageId: string,
  files: ReadonlyMap<string, Buffer>,
): ValidatedPreparedSet {
  return manifestForFiles(storageId, files);
}

export function mapsEqual(
  left: ReadonlyMap<string, Buffer>,
  right: ReadonlyMap<string, Buffer>,
): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [path, content] of left) {
    const other = right.get(path);
    if (!other || !content.equals(other)) {
      return false;
    }
  }
  return true;
}

async function makePrivateTreeWritable(path: string): Promise<void> {
  const stat = await fs.lstat(path);
  if (stat.isSymbolicLink()) {
    return;
  }
  if (stat.isDirectory()) {
    await fs.chmod(path, 0o700);
    const entries = await fs.readdir(path);
    for (const entry of entries) {
      await makePrivateTreeWritable(join(path, entry));
    }
    return;
  }
  if (stat.isFile()) {
    await fs.chmod(path, 0o600);
  }
}

export async function removePiMemoryPhase2Workspace(
  root: string,
): Promise<void> {
  try {
    await makePrivateTreeWritable(root);
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
  await fs.rm(root, { recursive: true, force: false });
}
