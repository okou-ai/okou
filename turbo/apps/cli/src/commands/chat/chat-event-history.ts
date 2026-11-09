import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { chatEventRowSchema } from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
  CANONICAL_CODEX_MEMORY_MOUNT_PATH,
  CANONICAL_PI_MEMORY_MOUNT_PATH,
} from "@okouai/api-contracts/contracts/runners";
import {
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
  type ChatEventCursor,
} from "@okouai/api-contracts/contracts/chat-event-schema-version";

import {
  getChatEventSnapshot,
  listChatEventRows,
} from "../../lib/api/domains/chat";

const CHAT_EVENT_ROWS_PAGE_LIMIT = 50;
const THREAD_START_SEQ_ID = 0;
const SNAPSHOT_FILE_PATTERN = /^snapshot-to-(\d+)\.ndjson$/;
const EVENT_FILE_PATTERN = /^event-SEQ_ID_(\d+)\.json$/;
const CACHE_FORMAT_FILE = ".okou-chat-event-schema-version";
const CHAT_HISTORY_OUTPUT_EXAMPLE = "/tmp/okou-chat-history";
// Every Run saves these roots as the member's memory, so raw history synced
// into one would be persisted and reloaded as memory in later Runs.
const AGENT_MEMORY_ROOTS = [
  CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
  CANONICAL_CODEX_MEMORY_MOUNT_PATH,
  CANONICAL_PI_MEMORY_MOUNT_PATH,
] as const;

function cacheFormatBody(): string {
  return `${CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString()}\n`;
}

type ManagedHistoryFile =
  | {
      readonly name: string;
      readonly kind: "snapshot";
      readonly seqId: number;
    }
  | {
      readonly name: string;
      readonly kind: "event";
      readonly seqId: number;
    };

interface RawChatHistorySyncResult {
  readonly directory: string;
  readonly files: readonly string[];
}

type LocalHistoryState =
  | { readonly kind: "empty" }
  | { readonly kind: "invalid" }
  | { readonly kind: "valid"; readonly cursor: ChatEventCursor };

interface ParsedSnapshot {
  readonly lastEventId: string | null;
  readonly lastRowSeqId: number | null;
}

type SnapshotCursorState =
  | { readonly kind: "invalid" }
  | { readonly kind: "valid"; readonly cursor: ChatEventCursor };

function managedHistoryFile(name: string): ManagedHistoryFile | null {
  const snapshot = SNAPSHOT_FILE_PATTERN.exec(name);
  if (snapshot) {
    return {
      name,
      kind: "snapshot",
      seqId: Number(snapshot[1]),
    };
  }
  const event = EVENT_FILE_PATTERN.exec(name);
  if (event) {
    return {
      name,
      kind: "event",
      seqId: Number(event[1]),
    };
  }
  return null;
}

async function listManagedHistoryFiles(
  directory: string,
): Promise<ManagedHistoryFile[]> {
  const names = await readdir(directory);
  return names
    .flatMap((name) => {
      const file = managedHistoryFile(name);
      return file ? [file] : [];
    })
    .sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === "snapshot" ? -1 : 1;
      }
      return left.seqId - right.seqId;
    });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/** Resolves symlinks through the nearest existing ancestor of `path`. */
async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  const missingSegments: string[] = [];
  let existing = absolute;
  for (;;) {
    try {
      return join(await realpath(existing), ...missingSegments);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(existing);
      if (parent === existing) {
        return absolute;
      }
      missingSegments.unshift(basename(existing));
      existing = parent;
    }
  }
}

function isSameOrInside(path: string, root: string): boolean {
  const fromRoot = relative(root, path);
  return (
    fromRoot === "" ||
    (!isAbsolute(fromRoot) && fromRoot.split(sep)[0] !== "..")
  );
}

async function assertOutsideAgentMemory(
  outputDirectory: string,
): Promise<void> {
  const target = await canonicalPath(outputDirectory);
  for (const root of AGENT_MEMORY_ROOTS) {
    if (isSameOrInside(target, await canonicalPath(root))) {
      throw new Error(
        `Chat history output directory ${target} is inside the agent memory directory ${root}. ` +
          "Memory is saved after every run, so synced history would persist as memory. " +
          `Choose a directory outside memory, for example: okou chat messages --output-dir ${CHAT_HISTORY_OUTPUT_EXAMPLE}`,
      );
    }
  }
}

async function hasCurrentCacheFormat(directory: string): Promise<boolean> {
  try {
    const body = await readFile(join(directory, CACHE_FORMAT_FILE), "utf8");
    return body === cacheFormatBody();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function publishCacheFormat(directory: string): Promise<void> {
  const stagedDirectory = await mkdtemp(
    join(directory, ".okou-chat-event-schema-version-"),
  );
  try {
    const staged = join(stagedDirectory, CACHE_FORMAT_FILE);
    await writeFile(staged, cacheFormatBody(), "utf8");
    await rename(staged, join(directory, CACHE_FORMAT_FILE));
  } finally {
    await rm(stagedDirectory, { recursive: true, force: true });
  }
}

async function invalidateCacheFormat(directory: string): Promise<void> {
  await rm(join(directory, CACHE_FORMAT_FILE), { force: true });
}

function parseSnapshot(args: {
  readonly text: string;
  readonly threadId: string;
}): ParsedSnapshot {
  if (args.text.length === 0) {
    return { lastEventId: null, lastRowSeqId: null };
  }
  if (!args.text.endsWith("\n")) {
    throw new Error("Chat event snapshot must be newline-delimited JSON");
  }
  let lastEventId: string | undefined;
  let lastRowSeqId: number | undefined;
  for (const line of args.text.slice(0, -1).split("\n")) {
    const row = chatEventRowSchema.parse(JSON.parse(line));
    if (row.chatThreadId !== args.threadId) {
      throw new Error("Chat event snapshot belongs to another thread");
    }
    if (lastRowSeqId !== undefined && row.seqId <= lastRowSeqId) {
      throw new Error(
        "Chat event snapshot rows must be ordered by sequence ID",
      );
    }
    lastEventId = row.id;
    lastRowSeqId = row.seqId;
  }
  return {
    lastEventId: lastEventId ?? null,
    lastRowSeqId: lastRowSeqId ?? null,
  };
}

async function localSnapshotCursor(args: {
  readonly directory: string;
  readonly threadId: string;
  readonly snapshot: Extract<ManagedHistoryFile, { readonly kind: "snapshot" }>;
}): Promise<SnapshotCursorState> {
  try {
    const parsed = parseSnapshot({
      text: await readFile(join(args.directory, args.snapshot.name), "utf8"),
      threadId: args.threadId,
    });
    if (args.snapshot.seqId === THREAD_START_SEQ_ID) {
      return parsed.lastEventId === null && parsed.lastRowSeqId === null
        ? {
            kind: "valid",
            cursor: { lastEventId: null, lastSeqId: THREAD_START_SEQ_ID },
          }
        : { kind: "invalid" };
    }
    if (
      parsed.lastEventId === null ||
      parsed.lastRowSeqId !== args.snapshot.seqId
    ) {
      return { kind: "invalid" };
    }
    return {
      kind: "valid",
      cursor: {
        lastEventId: parsed.lastEventId,
        lastSeqId: args.snapshot.seqId,
      },
    };
  } catch {
    return { kind: "invalid" };
  }
}

async function localHistoryState(args: {
  readonly directory: string;
  readonly threadId: string;
  readonly files: readonly ManagedHistoryFile[];
}): Promise<LocalHistoryState> {
  if (args.files.length === 0) {
    return { kind: "empty" };
  }

  const snapshots = args.files.filter((file) => {
    return file.kind === "snapshot";
  });
  if (snapshots.length > 1) {
    return { kind: "invalid" };
  }
  const events = args.files.filter((file) => {
    return file.kind === "event";
  });
  let cursor: ChatEventCursor = {
    lastEventId: null,
    lastSeqId: THREAD_START_SEQ_ID,
  };
  const snapshot = snapshots[0];
  if (snapshot !== undefined) {
    const state = await localSnapshotCursor({
      directory: args.directory,
      threadId: args.threadId,
      snapshot,
    });
    if (state.kind === "invalid") {
      return state;
    }
    cursor = state.cursor;
  }
  let previousSeqId = cursor.lastSeqId;
  for (const event of events) {
    if (event.seqId <= previousSeqId) {
      return { kind: "invalid" };
    }
    try {
      const text = await readFile(join(args.directory, event.name), "utf8");
      if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) {
        return { kind: "invalid" };
      }
      const row = chatEventRowSchema.parse(JSON.parse(text.slice(0, -1)));
      if (row.chatThreadId !== args.threadId || row.seqId !== event.seqId) {
        return { kind: "invalid" };
      }
      cursor = {
        lastEventId: row.id,
        lastSeqId: row.seqId,
      };
    } catch {
      return { kind: "invalid" };
    }
    previousSeqId = event.seqId;
  }
  return snapshot !== undefined || events.length > 0
    ? { kind: "valid", cursor }
    : { kind: "invalid" };
}

async function downloadSnapshot(args: {
  readonly url: string;
  readonly threadId: string;
  readonly expectedLastEventId: string | null;
  readonly expectedLastSeqId: number;
}): Promise<string> {
  const response = await fetch(args.url);
  if (!response.ok) {
    throw new Error(
      `Chat event snapshot download failed with status ${response.status}`,
    );
  }
  const text = await response.text();
  const parsed = parseSnapshot({
    text,
    threadId: args.threadId,
  });
  const parsedLastSeqId = parsed.lastRowSeqId ?? THREAD_START_SEQ_ID;
  if (
    parsed.lastEventId !== args.expectedLastEventId ||
    parsedLastSeqId !== args.expectedLastSeqId
  ) {
    throw new Error("Chat event snapshot terminal event ID does not match");
  }
  if (
    parsed.lastRowSeqId !== null &&
    parsed.lastRowSeqId > args.expectedLastSeqId
  ) {
    throw new Error("Chat event snapshot exceeds its physical cursor");
  }
  if (
    parsed.lastRowSeqId === args.expectedLastSeqId &&
    parsed.lastEventId !== args.expectedLastEventId
  ) {
    throw new Error("Chat event snapshot terminal event ID does not match");
  }
  return text;
}

async function syncRows(args: {
  readonly threadId: string;
  readonly directory: string;
  readonly cursor: ChatEventCursor;
}): Promise<{
  readonly kind: "complete" | "expired";
}> {
  let cursor = args.cursor;
  for (;;) {
    const page = await listChatEventRows(
      cursor.lastEventId === null
        ? {
            threadId: args.threadId,
            sinceEventId: null,
            sinceSeqId: 0,
            limit: CHAT_EVENT_ROWS_PAGE_LIMIT,
          }
        : {
            threadId: args.threadId,
            sinceEventId: cursor.lastEventId,
            sinceSeqId: cursor.lastSeqId,
            limit: CHAT_EVENT_ROWS_PAGE_LIMIT,
          },
    );
    if (page.kind === "expired") {
      return { kind: "expired" };
    }
    let previousSeqId = cursor.lastSeqId;
    for (const row of page.rows) {
      if (row.seqId <= previousSeqId) {
        throw new Error(
          "Chat event rows must have strictly increasing sequence IDs",
        );
      }
      previousSeqId = row.seqId;
    }
    const stagedDirectory = await mkdtemp(
      join(args.directory, ".okou-chat-history-page-"),
    );
    try {
      await Promise.all(
        page.rows.map((row) => {
          return writeFile(
            join(stagedDirectory, `event-SEQ_ID_${row.seqId}.json`),
            `${JSON.stringify(row)}\n`,
            "utf8",
          );
        }),
      );
      for (const row of page.rows) {
        const name = `event-SEQ_ID_${row.seqId}.json`;
        await rename(join(stagedDirectory, name), join(args.directory, name));
      }
    } finally {
      await rm(stagedDirectory, { recursive: true, force: true });
    }
    cursor = page.cursor;
    if (!page.hasMore) {
      return { kind: "complete" };
    }
  }
}

async function replaceManagedHistoryFiles(args: {
  readonly targetDirectory: string;
  readonly stagedDirectory: string;
}): Promise<void> {
  const [existing, staged] = await Promise.all([
    listManagedHistoryFiles(args.targetDirectory),
    listManagedHistoryFiles(args.stagedDirectory),
  ]);
  // Removing the newest rows first and installing the new generation oldest
  // first preserves cursor-prefix ordering during replacement.
  for (const file of [...existing].reverse()) {
    await rm(join(args.targetDirectory, file.name));
  }
  for (const file of staged) {
    await rename(
      join(args.stagedDirectory, file.name),
      join(args.targetDirectory, file.name),
    );
  }
}

async function rebuildRawChatHistory(args: {
  readonly threadId: string;
  readonly outputDirectory: string;
  readonly threadDirectory: string;
}): Promise<void> {
  const temporaryDirectory = await mkdtemp(
    join(args.outputDirectory, ".okou-chat-history-"),
  );
  try {
    const snapshot = await getChatEventSnapshot({
      threadId: args.threadId,
    });
    let cursor: ChatEventCursor = {
      lastEventId: null,
      lastSeqId: THREAD_START_SEQ_ID,
    };
    if (snapshot.kind === "snapshot") {
      const downloaded = await downloadSnapshot({
        url: snapshot.url,
        threadId: args.threadId,
        expectedLastEventId: snapshot.lastEventId,
        expectedLastSeqId: snapshot.lastSeqId,
      });
      const snapshotFileName = `snapshot-to-${snapshot.lastSeqId}.ndjson`;
      await writeFile(
        join(temporaryDirectory, snapshotFileName),
        downloaded,
        "utf8",
      );
      cursor =
        snapshot.lastEventId === null
          ? { lastEventId: null, lastSeqId: THREAD_START_SEQ_ID }
          : {
              lastEventId: snapshot.lastEventId,
              lastSeqId: snapshot.lastSeqId,
            };
    }

    const result = await syncRows({
      threadId: args.threadId,
      directory: temporaryDirectory,
      cursor,
    });
    if (result.kind === "expired") {
      throw new Error(
        "Chat event rows cursor expired immediately after snapshot download",
      );
    }
    await invalidateCacheFormat(args.threadDirectory);
    await replaceManagedHistoryFiles({
      targetDirectory: args.threadDirectory,
      stagedDirectory: temporaryDirectory,
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function syncRawChatHistory(args: {
  readonly threadId: string;
  readonly outputDirectory: string;
}): Promise<RawChatHistorySyncResult> {
  await assertOutsideAgentMemory(args.outputDirectory);
  await mkdir(args.outputDirectory, { recursive: true });
  const threadDirectory = join(args.outputDirectory, args.threadId);
  await mkdir(threadDirectory, { recursive: true });
  const existing = await listManagedHistoryFiles(threadDirectory);
  const state = (await hasCurrentCacheFormat(threadDirectory))
    ? await localHistoryState({
        directory: threadDirectory,
        threadId: args.threadId,
        files: existing,
      })
    : ({ kind: "invalid" } as const);

  if (state.kind !== "valid") {
    await rebuildRawChatHistory({
      threadId: args.threadId,
      outputDirectory: args.outputDirectory,
      threadDirectory,
    });
  } else {
    const result = await syncRows({
      threadId: args.threadId,
      directory: threadDirectory,
      cursor: state.cursor,
    });
    if (result.kind === "expired") {
      await rebuildRawChatHistory({
        threadId: args.threadId,
        outputDirectory: args.outputDirectory,
        threadDirectory,
      });
    }
  }

  await publishCacheFormat(threadDirectory);

  const files = (await listManagedHistoryFiles(threadDirectory)).map((file) => {
    return join(threadDirectory, file.name);
  });
  return { directory: threadDirectory, files };
}
