import { createHash } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type {
  PiMemoryRecallOutcome,
  PiMemoryRecallSelection,
  PiPreheatedResourceSnapshot,
} from "./api-types";
import {
  piMemorySummaryTokenCount,
  PI_MEMORY_ROOT,
  PI_MEMORY_SUMMARY_MAX_BYTES,
  PI_MEMORY_SUMMARY_SOURCE_MAX_TOKENS,
  renderPiMemoryRecall,
} from "./memory-recall";

interface PiMemoryRecallResolution {
  readonly block: string | null;
  readonly outcome: PiMemoryRecallOutcome;
}

type ReadyPiMemoryRecall = Extract<
  PiMemoryRecallSelection,
  { readonly status: "ready" }
>;

function frozenMetadata(
  selection: PiMemoryRecallSelection | undefined,
): Pick<
  PiMemoryRecallOutcome,
  "memoryStorageId" | "sourceHash" | "sourceSize" | "storageVersionId"
> {
  if (selection === undefined) {
    return {};
  }
  return {
    ...(typeof selection.memoryStorageId === "string"
      ? { memoryStorageId: selection.memoryStorageId }
      : {}),
    ...(typeof selection.storageVersionId === "string"
      ? { storageVersionId: selection.storageVersionId }
      : {}),
    ...(selection.status === "ready" && typeof selection.sourceHash === "string"
      ? { sourceHash: selection.sourceHash }
      : {}),
    ...(selection.status === "ready" && typeof selection.sourceSize === "number"
      ? { sourceSize: selection.sourceSize }
      : {}),
  };
}

function noBlock(
  mode: PiMemoryRecallOutcome["mode"],
  selection: PiMemoryRecallSelection | undefined,
  status: PiMemoryRecallOutcome["status"],
  parity: PiMemoryRecallOutcome["parity"],
  reason: PiMemoryRecallOutcome["reason"],
): PiMemoryRecallResolution {
  return {
    block: null,
    outcome: {
      mode,
      status,
      parity,
      reason,
      ...frozenMetadata(selection),
      injectedTokenCount: 0,
    },
  };
}

function readySelectionIsStructurallyValid(
  selection: ReadyPiMemoryRecall,
): boolean {
  return (
    typeof selection.memoryStorageId === "string" &&
    selection.memoryStorageId.length > 0 &&
    typeof selection.storageVersionId === "string" &&
    selection.storageVersionId.length > 0 &&
    typeof selection.content === "string" &&
    selection.content.length <= PI_MEMORY_SUMMARY_MAX_BYTES &&
    typeof selection.sourceHash === "string" &&
    /^[a-f0-9]{64}$/.test(selection.sourceHash) &&
    Number.isInteger(selection.sourceSize) &&
    selection.sourceSize > 0 &&
    selection.sourceSize <= PI_MEMORY_SUMMARY_MAX_BYTES &&
    Number.isInteger(selection.tokenCount) &&
    selection.tokenCount > 0 &&
    selection.tokenCount <= PI_MEMORY_SUMMARY_SOURCE_MAX_TOKENS
  );
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function authenticateReadyBytes(
  mode: PiMemoryRecallOutcome["mode"],
  selection: ReadyPiMemoryRecall,
  bytes: Uint8Array,
): PiMemoryRecallResolution {
  if (!readySelectionIsStructurallyValid(selection)) {
    return noBlock(mode, selection, "invalid", "mismatch", "selection-invalid");
  }
  if (bytes.byteLength > PI_MEMORY_SUMMARY_MAX_BYTES) {
    return noBlock(mode, selection, "invalid", "mismatch", "oversized");
  }
  if (bytes.byteLength !== selection.sourceSize) {
    return noBlock(mode, selection, "stale", "mismatch", "size-mismatch");
  }

  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return noBlock(mode, selection, "invalid", "mismatch", "invalid-utf8");
  }
  if (content.trim().length === 0) {
    return noBlock(mode, selection, "invalid", "mismatch", "empty");
  }
  if (sha256(bytes) !== selection.sourceHash) {
    return noBlock(mode, selection, "stale", "mismatch", "hash-mismatch");
  }
  if (content !== selection.content) {
    return noBlock(mode, selection, "stale", "mismatch", "hash-mismatch");
  }

  // The full source is authenticated here; the prompt budget is applied later
  // by the shared renderer, which injects a bounded excerpt of this source.
  const tokenCount = piMemorySummaryTokenCount(content);
  if (tokenCount !== selection.tokenCount) {
    return noBlock(mode, selection, "stale", "mismatch", "token-mismatch");
  }
  const rendered = renderPiMemoryRecall(content);
  if (rendered === null) {
    return noBlock(mode, selection, "invalid", "mismatch", "empty");
  }
  return {
    block: rendered.block,
    outcome: {
      mode,
      status: "hit",
      parity: "frozen-match",
      reason: "matched",
      ...frozenMetadata(selection),
      injectedTokenCount: rendered.injectedTokenCount,
    },
  };
}

function resolveSelectionWithoutBytes(
  mode: PiMemoryRecallOutcome["mode"],
  selection: PiMemoryRecallSelection | undefined,
): PiMemoryRecallResolution | undefined {
  if (selection === undefined) {
    return noBlock(mode, selection, "miss", "not-applicable", "missing");
  }
  if (selection.status === "no-content") {
    if (
      typeof selection.memoryStorageId !== "string" ||
      selection.memoryStorageId.length === 0 ||
      typeof selection.storageVersionId !== "string" ||
      selection.storageVersionId.length === 0
    ) {
      return noBlock(
        mode,
        selection,
        "invalid",
        "mismatch",
        "selection-invalid",
      );
    }
    return noBlock(
      mode,
      selection,
      "miss",
      "frozen-no-content",
      "frozen-no-content",
    );
  }
  if (!readySelectionIsStructurallyValid(selection)) {
    return noBlock(mode, selection, "invalid", "mismatch", "selection-invalid");
  }
  return undefined;
}

export function resolvePiApiMemoryRecall(
  snapshot: PiPreheatedResourceSnapshot,
): PiMemoryRecallResolution {
  if (snapshot.schemaVersion === 1) {
    return noBlock("api-first", undefined, "miss", "not-applicable", "v1");
  }
  const withoutBytes = resolveSelectionWithoutBytes(
    "api-first",
    snapshot.memoryRecall,
  );
  if (withoutBytes !== undefined) {
    return withoutBytes;
  }
  return authenticateReadyBytes(
    "api-first",
    snapshot.memoryRecall as ReadyPiMemoryRecall,
    Buffer.from((snapshot.memoryRecall as ReadyPiMemoryRecall).content, "utf8"),
  );
}

function pathIsInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot.length > 0 && !fromRoot.startsWith("..") && !isAbsolute(fromRoot)
  );
}

function filesystemFailure(
  selection: PiMemoryRecallSelection,
  error: unknown,
): PiMemoryRecallResolution {
  const code =
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : undefined;
  if (code === "ENOENT" || code === "ENOTDIR") {
    return noBlock("sandbox", selection, "miss", "mismatch", "missing");
  }
  if (code === "ELOOP") {
    return noBlock("sandbox", selection, "invalid", "mismatch", "symlink");
  }
  return noBlock("sandbox", selection, "invalid", "mismatch", "filesystem");
}

async function readBoundedFile(handle: FileHandle): Promise<Buffer> {
  const output = Buffer.alloc(PI_MEMORY_SUMMARY_MAX_BYTES + 1);
  let offset = 0;
  while (offset < output.length) {
    const { bytesRead } = await handle.read(
      output,
      offset,
      output.length - offset,
      offset,
    );
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  return output.subarray(0, offset);
}

/** Read only the frozen root summary from the pinned sandbox mount, once. */
export async function loadPiSandboxMemoryRecall(
  selection: PiMemoryRecallSelection | undefined,
  memoryRoot = PI_MEMORY_ROOT,
): Promise<PiMemoryRecallResolution> {
  const withoutBytes = resolveSelectionWithoutBytes("sandbox", selection);
  if (withoutBytes !== undefined) {
    return withoutBytes;
  }
  const ready = selection as ReadyPiMemoryRecall;
  const root = resolve(memoryRoot);
  const summaryPath = resolve(root, "memory_summary.md");
  if (!pathIsInside(root, summaryPath)) {
    return noBlock("sandbox", ready, "invalid", "mismatch", "path-escape");
  }

  try {
    const rootStat = await fs.lstat(root);
    if (rootStat.isSymbolicLink()) {
      return noBlock("sandbox", ready, "invalid", "mismatch", "symlink");
    }
    if (!rootStat.isDirectory()) {
      return noBlock("sandbox", ready, "invalid", "mismatch", "non-regular");
    }
    const realRoot = await fs.realpath(root);
    const fileStat = await fs.lstat(summaryPath);
    if (fileStat.isSymbolicLink()) {
      return noBlock("sandbox", ready, "invalid", "mismatch", "symlink");
    }
    if (!fileStat.isFile()) {
      return noBlock("sandbox", ready, "invalid", "mismatch", "non-regular");
    }
    const realSummaryPath = await fs.realpath(summaryPath);
    if (!pathIsInside(realRoot, realSummaryPath)) {
      return noBlock("sandbox", ready, "invalid", "mismatch", "path-escape");
    }

    const handle = await fs.open(
      summaryPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      const openedStat = await handle.stat();
      if (
        !openedStat.isFile() ||
        openedStat.dev !== fileStat.dev ||
        openedStat.ino !== fileStat.ino
      ) {
        return noBlock("sandbox", ready, "invalid", "mismatch", "non-regular");
      }
      const bytes = await readBoundedFile(handle);
      if (bytes.byteLength > PI_MEMORY_SUMMARY_MAX_BYTES) {
        return noBlock("sandbox", ready, "invalid", "mismatch", "oversized");
      }
      return authenticateReadyBytes("sandbox", ready, bytes);
    } finally {
      await handle.close();
    }
  } catch (error) {
    return filesystemFailure(ready, error);
  }
}
