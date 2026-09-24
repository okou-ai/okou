import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHAT_EVENT_SCHEMA_VERSION_HEADER,
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
} from "@okouai/api-contracts/contracts/chat-event-schema-version";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import { HttpResponse, http } from "msw";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";

import { server } from "../../../mocks/server";
import { chatCommand } from "../index";

const THREAD_ID = "00000000-0000-4000-8000-000000000001";
const SNAPSHOT_URL = `http://localhost:3000/api/chat-threads/${THREAD_ID}/event-snapshot`;
const ROWS_URL = `http://localhost:3000/api/chat-threads/${THREAD_ID}/event-rows`;
const SNAPSHOT_DOWNLOAD_URL =
  "https://r2.example.test/chat-events/snapshot.ndjson.gz";
const CHAT_EVENT_SCHEMA_HEADERS = {
  [CHAT_EVENT_SCHEMA_VERSION_HEADER]:
    CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString(),
};
const CACHE_SCHEMA_VERSION_FILE = ".okou-chat-event-schema-version";
const CACHE_SCHEMA_VERSION_BODY = `${CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString()}\n`;

function rawEventRow(seqId: number): ChatEventRow {
  return {
    id: `00000000-0000-4000-8000-${String(seqId).padStart(12, "0")}`,
    chatThreadId: THREAD_ID,
    runId: null,
    revokesEventId: null,
    eventType: "output.message",
    payload: { content: `message ${seqId}` },
    contextType: null,
    contextId: null,
    runEventSequenceNumber: null,
    runEventId: null,
    seqId,
    createdAt: "2026-08-12T10:00:00.000Z",
  };
}

function failedEventRow(seqId: number): ChatEventRow {
  return {
    id: `00000000-0000-4000-8000-${String(seqId).padStart(12, "0")}`,
    chatThreadId: THREAD_ID,
    runId: "00000000-0000-4000-8000-000000000099",
    revokesEventId: null,
    eventType: "run.failed",
    payload: { error: `provider unavailable ${seqId}` },
    failureReason: "future_reason",
    contextType: null,
    contextId: null,
    runEventSequenceNumber: null,
    runEventId: null,
    seqId,
    createdAt: "2026-08-12T10:00:00.000Z",
  };
}

function discordEventRow(seqId: number): ChatEventRow {
  return {
    ...rawEventRow(seqId),
    eventType: "input.prompt",
    contextType: "discord",
    contextId: "00000000-0000-4000-8000-000000000098",
    payload: {
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: "Review this Discord message" },
          {
            type: "source",
            kind: "discord",
            href: "https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333",
          },
        ],
      },
    },
  };
}

function snapshotNdjson(rows: readonly ChatEventRow[]) {
  return `${rows
    .map((row) => {
      return JSON.stringify(row);
    })
    .join("\n")}\n`;
}

async function createOutputDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "okou-chat-messages-"));
  onTestFinished(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function markCurrentCache(threadDirectory: string): Promise<void> {
  await writeFile(
    join(threadDirectory, CACHE_SCHEMA_VERSION_FILE),
    CACHE_SCHEMA_VERSION_BODY,
    "utf8",
  );
}

describe("okou chat messages command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);

  beforeEach(() => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_CHAT_THREAD_ID", THREAD_ID);
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    mockExit.mockClear();
    vi.unstubAllEnvs();
  });

  it("synchronizes a snapshot and hot event files", async () => {
    const outputDirectory = await createOutputDirectory();
    const snapshotLastRow = failedEventRow(2);
    const snapshotRows = [discordEventRow(1), snapshotLastRow];
    const hotRow = failedEventRow(3);
    server.use(
      http.get(SNAPSHOT_URL, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        expect(request.headers.get(CHAT_EVENT_SCHEMA_VERSION_HEADER)).toBe(
          CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString(),
        );
        return HttpResponse.json(
          {
            url: SNAPSHOT_DOWNLOAD_URL,
            expiresInSeconds: 900,
            lastEventId: snapshotLastRow.id,
            lastSeqId: 2,
          },
          { headers: CHAT_EVENT_SCHEMA_HEADERS },
        );
      }),
      http.get(SNAPSHOT_DOWNLOAD_URL, () => {
        return new HttpResponse(snapshotNdjson(snapshotRows));
      }),
      http.get(ROWS_URL, ({ request }) => {
        const url = new URL(request.url);
        expect(request.headers.get(CHAT_EVENT_SCHEMA_VERSION_HEADER)).toBe(
          CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString(),
        );
        expect(url.searchParams.get("sinceSeqId")).toBe("2");
        expect(url.searchParams.get("sinceEventId")).toBe(snapshotLastRow.id);
        expect(url.searchParams.get("limit")).toBe("50");
        return HttpResponse.json(
          {
            rows: [hotRow],
            cursor: {
              lastEventId: hotRow.id,
              lastSeqId: hotRow.seqId,
            },
            hasMore: false,
          },
          { headers: CHAT_EVENT_SCHEMA_HEADERS },
        );
      }),
    );

    await chatCommand.parseAsync([
      "node",
      "cli",
      "messages",
      "--output-dir",
      outputDirectory,
    ]);

    const threadDirectory = join(outputDirectory, THREAD_ID);
    expect((await readdir(threadDirectory)).sort()).toStrictEqual([
      CACHE_SCHEMA_VERSION_FILE,
      "event-SEQ_ID_3.json",
      "snapshot-to-2.ndjson",
    ]);
    await expect(
      readFile(join(threadDirectory, "snapshot-to-2.ndjson"), "utf8"),
    ).resolves.toBe(snapshotNdjson(snapshotRows));
    await expect(
      readFile(join(threadDirectory, "event-SEQ_ID_3.json"), "utf8"),
    ).resolves.toBe(`${JSON.stringify(hotRow)}\n`);
    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain(join(threadDirectory, "snapshot-to-2.ndjson"));
    expect(output).toContain(join(threadDirectory, "event-SEQ_ID_3.json"));
  });

  it("persists an empty canonical snapshot and advances visible rows", async () => {
    const outputDirectory = await createOutputDirectory();
    const visibleRow = rawEventRow(4);
    const cursors: {
      readonly eventId: string | null;
      readonly seqId: string | null;
    }[] = [];
    server.use(
      http.get(SNAPSHOT_URL, () => {
        return HttpResponse.json(
          {
            url: SNAPSHOT_DOWNLOAD_URL,
            expiresInSeconds: 900,
            lastEventId: null,
            lastSeqId: 0,
          },
          { headers: CHAT_EVENT_SCHEMA_HEADERS },
        );
      }),
      http.get(SNAPSHOT_DOWNLOAD_URL, () => {
        return new HttpResponse("");
      }),
      http.get(ROWS_URL, ({ request }) => {
        const url = new URL(request.url);
        cursors.push({
          eventId: url.searchParams.get("sinceEventId"),
          seqId: url.searchParams.get("sinceSeqId"),
        });
        return HttpResponse.json(
          {
            rows: [visibleRow],
            cursor: {
              lastEventId: visibleRow.id,
              lastSeqId: visibleRow.seqId,
            },
            hasMore: false,
          },
          { headers: CHAT_EVENT_SCHEMA_HEADERS },
        );
      }),
    );

    await chatCommand.parseAsync([
      "node",
      "cli",
      "messages",
      "--output-dir",
      outputDirectory,
    ]);

    expect(cursors).toStrictEqual([
      {
        eventId: null,
        seqId: "0",
      },
    ]);
    const threadDirectory = join(outputDirectory, THREAD_ID);
    expect((await readdir(threadDirectory)).sort()).toStrictEqual([
      CACHE_SCHEMA_VERSION_FILE,
      "event-SEQ_ID_4.json",
      "snapshot-to-0.ndjson",
    ]);
    await expect(
      readFile(join(threadDirectory, "snapshot-to-0.ndjson"), "utf8"),
    ).resolves.toBe("");
  });

  it("uses the latest local event and sequence cursor for an incremental sync", async () => {
    const outputDirectory = await createOutputDirectory();
    const threadDirectory = join(outputDirectory, THREAD_ID);
    await mkdir(threadDirectory, { recursive: true });
    await markCurrentCache(threadDirectory);
    await writeFile(
      join(threadDirectory, "snapshot-to-2.ndjson"),
      snapshotNdjson([rawEventRow(1), rawEventRow(2)]),
      "utf8",
    );
    await writeFile(
      join(threadDirectory, "event-SEQ_ID_3.json"),
      `${JSON.stringify(rawEventRow(3))}\n`,
      "utf8",
    );
    const cursors: { eventId: string | null; seqId: string | null }[] = [];
    server.use(
      http.get(SNAPSHOT_URL, () => {
        throw new Error("Snapshot endpoint must not be called");
      }),
      http.get(ROWS_URL, ({ request }) => {
        const url = new URL(request.url);
        const seqId = url.searchParams.get("sinceSeqId");
        if (seqId === null) {
          throw new Error("Expected a rows cursor");
        }
        cursors.push({
          eventId: url.searchParams.get("sinceEventId"),
          seqId,
        });
        return HttpResponse.json(
          {
            rows: [rawEventRow(4)],
            cursor: {
              lastEventId: rawEventRow(4).id,
              lastSeqId: 4,
            },
            hasMore: false,
          },
          { headers: CHAT_EVENT_SCHEMA_HEADERS },
        );
      }),
    );

    await chatCommand.parseAsync([
      "node",
      "cli",
      "messages",
      "--output-dir",
      outputDirectory,
      "--json",
    ]);

    expect(cursors).toStrictEqual([{ eventId: rawEventRow(3).id, seqId: "3" }]);
    expect((await readdir(threadDirectory)).sort()).toStrictEqual([
      CACHE_SCHEMA_VERSION_FILE,
      "event-SEQ_ID_3.json",
      "event-SEQ_ID_4.json",
      "snapshot-to-2.ndjson",
    ]);
    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      {
        threadId: THREAD_ID,
        directory: threadDirectory,
        files: [
          join(threadDirectory, "snapshot-to-2.ndjson"),
          join(threadDirectory, "event-SEQ_ID_3.json"),
          join(threadDirectory, "event-SEQ_ID_4.json"),
        ],
      },
    );
  });

  it("continues a monotonic local history across sequence gaps", async () => {
    const outputDirectory = await createOutputDirectory();
    const threadDirectory = join(outputDirectory, THREAD_ID);
    await mkdir(threadDirectory, { recursive: true });
    await markCurrentCache(threadDirectory);
    await writeFile(
      join(threadDirectory, "snapshot-to-2.ndjson"),
      snapshotNdjson([rawEventRow(1), rawEventRow(2)]),
      "utf8",
    );
    await writeFile(
      join(threadDirectory, "event-SEQ_ID_4.json"),
      `${JSON.stringify(rawEventRow(4))}\n`,
      "utf8",
    );
    await writeFile(join(threadDirectory, "notes.txt"), "keep me", "utf8");
    const cursors: string[] = [];
    server.use(
      http.get(SNAPSHOT_URL, () => {
        throw new Error("Snapshot endpoint must not be called");
      }),
      http.get(ROWS_URL, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("sinceSeqId");
        if (cursor === null) {
          throw new Error("Expected a rows cursor");
        }
        cursors.push(cursor);
        expect(cursor).toBe("4");
        return HttpResponse.json(
          {
            rows: [rawEventRow(7), rawEventRow(10)],
            cursor: {
              lastEventId: rawEventRow(10).id,
              lastSeqId: 10,
            },
            hasMore: false,
          },
          { headers: CHAT_EVENT_SCHEMA_HEADERS },
        );
      }),
    );

    await chatCommand.parseAsync([
      "node",
      "cli",
      "messages",
      "--output-dir",
      outputDirectory,
    ]);

    expect(cursors).toStrictEqual(["4"]);
    expect((await readdir(threadDirectory)).sort()).toStrictEqual([
      CACHE_SCHEMA_VERSION_FILE,
      "event-SEQ_ID_10.json",
      "event-SEQ_ID_4.json",
      "event-SEQ_ID_7.json",
      "notes.txt",
      "snapshot-to-2.ndjson",
    ]);
  });

  it("rejects event rows that do not strictly increase", async () => {
    const outputDirectory = await createOutputDirectory();
    const threadDirectory = join(outputDirectory, THREAD_ID);
    await mkdir(threadDirectory, { recursive: true });
    await markCurrentCache(threadDirectory);
    await writeFile(
      join(threadDirectory, "event-SEQ_ID_4.json"),
      `${JSON.stringify(rawEventRow(4))}\n`,
      "utf8",
    );
    server.use(
      http.get(SNAPSHOT_URL, () => {
        throw new Error("Snapshot endpoint must not be called");
      }),
      http.get(ROWS_URL, () => {
        return HttpResponse.json(
          {
            rows: [rawEventRow(7), rawEventRow(6)],
            cursor: {
              lastEventId: rawEventRow(6).id,
              lastSeqId: 6,
            },
            hasMore: false,
          },
          { headers: CHAT_EVENT_SCHEMA_HEADERS },
        );
      }),
    );

    await expect(async () => {
      await chatCommand.parseAsync([
        "node",
        "cli",
        "messages",
        "--output-dir",
        outputDirectory,
      ]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain(
      "Chat event rows must have strictly increasing sequence IDs",
    );
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(await readdir(threadDirectory)).toStrictEqual([
      CACHE_SCHEMA_VERSION_FILE,
      "event-SEQ_ID_4.json",
    ]);
  });

  it("rejects a missing Chat Event response schema version", async () => {
    const outputDirectory = await createOutputDirectory();
    const threadDirectory = join(outputDirectory, THREAD_ID);
    await mkdir(threadDirectory, { recursive: true });
    await markCurrentCache(threadDirectory);
    await writeFile(
      join(threadDirectory, "event-SEQ_ID_4.json"),
      `${JSON.stringify(rawEventRow(4))}\n`,
      "utf8",
    );
    server.use(
      http.get(ROWS_URL, () => {
        return HttpResponse.json({
          rows: [],
          cursor: {
            lastEventId: rawEventRow(4).id,
            lastSeqId: 4,
          },
          hasMore: false,
        });
      }),
    );

    await expect(async () => {
      await chatCommand.parseAsync([
        "node",
        "cli",
        "messages",
        "--output-dir",
        outputDirectory,
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "Unexpected Chat Event schema version null",
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("rebuilds an expired local generation and preserves unmanaged files", async () => {
    const outputDirectory = await createOutputDirectory();
    const threadDirectory = join(outputDirectory, THREAD_ID);
    await mkdir(threadDirectory, { recursive: true });
    await markCurrentCache(threadDirectory);
    await writeFile(
      join(threadDirectory, "snapshot-to-2.ndjson"),
      snapshotNdjson([rawEventRow(1), rawEventRow(2)]),
      "utf8",
    );
    await writeFile(
      join(threadDirectory, "event-SEQ_ID_3.json"),
      `${JSON.stringify(rawEventRow(3))}\n`,
      "utf8",
    );
    await writeFile(join(threadDirectory, "notes.txt"), "keep me", "utf8");
    const freshSnapshotRow = rawEventRow(10);
    const freshSnapshot = snapshotNdjson([freshSnapshotRow]);
    const cursors: { eventId: string | null; seqId: string | null }[] = [];
    server.use(
      http.get(SNAPSHOT_URL, () => {
        return HttpResponse.json(
          {
            url: SNAPSHOT_DOWNLOAD_URL,
            expiresInSeconds: 900,
            lastEventId: freshSnapshotRow.id,
            lastSeqId: 10,
          },
          { headers: CHAT_EVENT_SCHEMA_HEADERS },
        );
      }),
      http.get(SNAPSHOT_DOWNLOAD_URL, () => {
        return new HttpResponse(freshSnapshot);
      }),
      http.get(ROWS_URL, ({ request }) => {
        const url = new URL(request.url);
        const seqId = url.searchParams.get("sinceSeqId");
        if (seqId === null) {
          throw new Error("Expected a rows cursor");
        }
        cursors.push({
          eventId: url.searchParams.get("sinceEventId"),
          seqId,
        });
        if (seqId === "3") {
          return HttpResponse.json(
            {
              error: {
                code: "CHAT_EVENTS_EXPIRED",
                message: "Chat events cursor has expired",
              },
            },
            { status: 410, headers: CHAT_EVENT_SCHEMA_HEADERS },
          );
        }
        expect(seqId).toBe("10");
        const row = rawEventRow(11);
        return HttpResponse.json(
          {
            rows: [row],
            cursor: {
              lastEventId: row.id,
              lastSeqId: row.seqId,
            },
            hasMore: false,
          },
          { headers: CHAT_EVENT_SCHEMA_HEADERS },
        );
      }),
    );

    await chatCommand.parseAsync([
      "node",
      "cli",
      "messages",
      "--output-dir",
      outputDirectory,
    ]);

    expect(cursors).toStrictEqual([
      { eventId: rawEventRow(3).id, seqId: "3" },
      { eventId: freshSnapshotRow.id, seqId: "10" },
    ]);
    expect((await readdir(threadDirectory)).sort()).toStrictEqual([
      CACHE_SCHEMA_VERSION_FILE,
      "event-SEQ_ID_11.json",
      "notes.txt",
      "snapshot-to-10.ndjson",
    ]);
    await expect(
      readFile(join(threadDirectory, "notes.txt"), "utf8"),
    ).resolves.toBe("keep me");
  });

  it("requires a thread ID from the flag or the current web chat", async () => {
    vi.stubEnv("OKOU_CHAT_THREAD_ID", undefined);

    await expect(async () => {
      await chatCommand.parseAsync(["node", "cli", "messages"]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain("OKOU_CHAT_THREAD_ID is not set");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("rejects a response without the schema version header", async () => {
    const outputDirectory = await createOutputDirectory();
    server.use(
      http.get(SNAPSHOT_URL, () => {
        return HttpResponse.json(
          {
            error: {
              code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
              message: "Chat event snapshot not found",
            },
          },
          { status: 404 },
        );
      }),
    );

    await expect(async () => {
      await chatCommand.parseAsync([
        "node",
        "cli",
        "messages",
        "--output-dir",
        outputDirectory,
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "Unexpected Chat Event schema version null",
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
