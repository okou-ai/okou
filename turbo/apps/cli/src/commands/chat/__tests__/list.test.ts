import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import chalk from "chalk";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../mocks/server";
import { chatCommand } from "../index";

const THREAD_ID = "00000000-0000-4000-8000-000000000201";
const SECOND_THREAD_ID = "00000000-0000-4000-8000-000000000202";
const OTHER_THREAD_ID = "00000000-0000-4000-8000-000000000203";
const THIRD_THREAD_ID = "00000000-0000-4000-8000-000000000204";
const INITIAL_EVENT_ID = "00000000-0000-4000-8000-000000000301";
const RENAME_EVENT_ID = "00000000-0000-4000-8000-000000000302";
const SORT_EVENT_ID = "00000000-0000-4000-8000-000000000303";
const REFRESH_EVENT_ID = "00000000-0000-4000-8000-000000000304";
const INITIAL_SEQ_ID = 1;
const RENAME_SEQ_ID = 2;
const SORT_SEQ_ID = 3;
const REFRESH_SEQ_ID = 4;
const SNAPSHOT_URL = "http://localhost:3000/api/chat-threads/snapshot";
const EVENTS_URL = "http://localhost:3000/api/chat-threads/events";
const INDICATORS_URL = "http://localhost:3000/api/indicators";

function okouToken(): string {
  const payload = Buffer.from(
    JSON.stringify({
      userId: "user_test",
      runId: "00000000-0000-4000-8000-000000000401",
      orgId: "org_test",
      scope: "okou",
      capabilities: ["chat-thread:read"],
      iat: 1,
      exp: 4_102_444_800,
    }),
  ).toString("base64url");
  return `vm0_sandbox_e30.${payload}.signature`;
}

function snapshotThread(options: {
  readonly id: string;
  readonly title: string;
  readonly sortAt: string;
  readonly archived?: boolean;
  readonly hidden?: boolean;
}) {
  return {
    archived: false,
    ...options,
    createdAt: options.sortAt,
    updatedAt: options.sortAt,
    pinnedAt: null,
    renamedAt: null,
    selectedModel: null,
  };
}

function event(options: {
  readonly id: string;
  readonly seqId: number;
  readonly kind: "renamed" | "sort_touched";
  readonly chatThreadId: string;
  readonly title: string | null;
  readonly createdAt: string;
}) {
  return {
    ...options,
    selectedModel: null,
  };
}

function mockR2Snapshot(snapshot: {
  readonly chatThreads: readonly ReturnType<typeof snapshotThread>[];
  readonly latestEventId: string | null;
  readonly latestSeqId: number | null;
}) {
  const url = `https://r2.example.com/chat-thread-snapshots/${crypto.randomUUID()}.json`;
  server.use(
    http.get(url, () => {
      return HttpResponse.json({ chatThreads: snapshot.chatThreads });
    }),
  );
  return {
    url,
    expiresInSeconds: 900,
    latestEventId: snapshot.latestEventId,
    latestSeqId: snapshot.latestSeqId,
  };
}

function mockStableThreadSnapshot(
  threads: readonly ReturnType<typeof snapshotThread>[],
): void {
  server.use(
    http.get(SNAPSHOT_URL, () => {
      return HttpResponse.json(
        mockR2Snapshot({
          chatThreads: threads,
          latestEventId: INITIAL_EVENT_ID,
          latestSeqId: INITIAL_SEQ_ID,
        }),
      );
    }),
    http.get(EVENTS_URL, () => {
      return HttpResponse.json({ events: [], hasMore: false });
    }),
  );
}

describe("okou chat list command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  let cacheDirectory: string;

  beforeEach(async () => {
    chalk.level = 0;
    cacheDirectory = await mkdtemp(join(tmpdir(), "chat-list-"));
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", okouToken());
    vi.stubEnv("XDG_CACHE_HOME", cacheDirectory);
  });

  it("preserves future membership events through HTTP validation and a reopened cache", async () => {
    const projectId = "00000000-0000-4000-8000-000000000071";
    const threads = [
      snapshotThread({
        id: THREAD_ID,
        title: "Project planning",
        sortAt: "2026-11-02T00:00:00.000Z",
      }),
    ];
    server.use(
      http.get(SNAPSHOT_URL, () => {
        return HttpResponse.json(
          mockR2Snapshot({
            chatThreads: threads,
            latestEventId: INITIAL_EVENT_ID,
            latestSeqId: 1,
          }),
        );
      }),
      http.get(EVENTS_URL, ({ request }) => {
        return HttpResponse.json({
          events:
            new URL(request.url).searchParams.get("sinceSeqId") === "1"
              ? [
                  {
                    id: RENAME_EVENT_ID,
                    seqId: 2,
                    kind: "project_updated",
                    projectId,
                    chatThreadId: THREAD_ID,
                    title: null,
                    createdAt: "2026-11-02T01:00:00.000Z",
                  },
                ]
              : [],
          hasMore: false,
        });
      }),
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      mockConsoleLog.mockClear();
      await chatCommand.parseAsync(["node", "okou", "list", "--json"]);
      const output = mockConsoleLog.mock.calls.flat().join("\n");
      expect(JSON.parse(output).threads).toEqual([
        expect.objectContaining({
          id: THREAD_ID,
          projectId,
          sortAt: "2026-11-02T00:00:00.000Z",
        }),
      ]);
    }
  });

  afterEach(async () => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    mockExit.mockClear();
    vi.unstubAllEnvs();
    await rm(cacheDirectory, { recursive: true, force: true });
  });

  it("excludes hidden threads before counting and limiting list output", async () => {
    mockStableThreadSnapshot([
      snapshotThread({
        id: THREAD_ID,
        title: "Visible chat",
        sortAt: "2026-11-02T00:00:00.000Z",
      }),
      snapshotThread({
        id: SECOND_THREAD_ID,
        title: "Hidden Learning chat",
        sortAt: "2026-11-02T01:00:00.000Z",
        hidden: true,
      }),
    ]);

    await chatCommand.parseAsync([
      "node",
      "cli",
      "list",
      "--limit",
      "1",
      "--json",
    ]);

    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toEqual({
      total: 1,
      threads: [expect.objectContaining({ id: THREAD_ID })],
    });
  });

  it("lists no threads when the organization has no snapshot row", async () => {
    server.use(
      http.get(SNAPSHOT_URL, () => {
        return HttpResponse.json({
          chatThreads: [],
          latestEventId: null,
          latestSeqId: null,
        });
      }),
      http.get(EVENTS_URL, () => {
        return HttpResponse.json({ events: [], hasMore: false });
      }),
    );

    await chatCommand.parseAsync(["node", "cli", "list", "--json"]);
    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      {
        total: 0,
        threads: [],
      },
    );
  });

  it("replays incremental events from the cache for the workspace", async () => {
    let snapshotRequests = 0;
    let eventRequests = 0;
    server.use(
      http.get(SNAPSHOT_URL, () => {
        snapshotRequests++;
        return HttpResponse.json(
          mockR2Snapshot({
            chatThreads: [
              snapshotThread({
                id: THREAD_ID,
                title: "Initial title",
                sortAt: "2026-07-24T03:00:00.000Z",
              }),
              snapshotThread({
                id: SECOND_THREAD_ID,
                title: "Second title",
                sortAt: "2026-07-24T02:00:00.000Z",
              }),
              snapshotThread({
                id: OTHER_THREAD_ID,
                title: "Another thread",
                sortAt: "2026-07-24T04:00:00.000Z",
              }),
            ],
            latestEventId: INITIAL_EVENT_ID,
            latestSeqId: INITIAL_SEQ_ID,
          }),
        );
      }),
      http.get(EVENTS_URL, ({ request }) => {
        eventRequests++;
        const cursor = new URL(request.url).searchParams.get("sinceSeqId");
        if (eventRequests === 1) {
          expect(cursor).toBe(String(INITIAL_SEQ_ID));
          return HttpResponse.json({
            events: [
              event({
                id: RENAME_EVENT_ID,
                seqId: RENAME_SEQ_ID,
                kind: "renamed",
                chatThreadId: THREAD_ID,
                title: "Renamed title",
                createdAt: "2026-07-24T03:30:00.000Z",
              }),
            ],
            hasMore: false,
          });
        }

        expect(cursor).toBe(String(RENAME_SEQ_ID));
        return HttpResponse.json({
          events: [
            event({
              id: SORT_EVENT_ID,
              seqId: SORT_SEQ_ID,
              kind: "sort_touched",
              chatThreadId: SECOND_THREAD_ID,
              title: null,
              createdAt: "2026-07-24T05:00:00.000Z",
            }),
          ],
          hasMore: false,
        });
      }),
    );

    await chatCommand.parseAsync([
      "node",
      "cli",
      "list",
      "--limit",
      "1",
      "--json",
    ]);

    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      {
        total: 3,
        threads: [
          expect.objectContaining({
            id: OTHER_THREAD_ID,
            title: "Another thread",
          }),
        ],
      },
    );

    mockConsoleLog.mockClear();
    await chatCommand.parseAsync(["node", "cli", "list", "--json"]);

    const secondOutput = JSON.parse(
      String(mockConsoleLog.mock.calls[0]?.[0]),
    ) as {
      readonly threads: readonly { readonly id: string }[];
    };
    expect(
      secondOutput.threads.map((thread) => {
        return thread.id;
      }),
    ).toStrictEqual([SECOND_THREAD_ID, OTHER_THREAD_ID, THREAD_ID]);
    expect(snapshotRequests).toBe(1);
    expect(eventRequests).toBe(2);
  });

  it("reloads the snapshot when the cached event cursor expires", async () => {
    let snapshotRequests = 0;
    let eventRequests = 0;
    server.use(
      http.get(SNAPSHOT_URL, () => {
        snapshotRequests++;
        return HttpResponse.json(
          mockR2Snapshot({
            chatThreads: [
              snapshotThread({
                id: THREAD_ID,
                title:
                  snapshotRequests === 1 ? "Cached title" : "Refreshed title",
                sortAt: "2026-07-24T03:00:00.000Z",
              }),
            ],
            latestEventId:
              snapshotRequests === 1 ? INITIAL_EVENT_ID : REFRESH_EVENT_ID,
            latestSeqId:
              snapshotRequests === 1 ? INITIAL_SEQ_ID : REFRESH_SEQ_ID,
          }),
        );
      }),
      http.get(EVENTS_URL, ({ request }) => {
        eventRequests++;
        const cursor = new URL(request.url).searchParams.get("sinceSeqId");
        if (eventRequests === 2) {
          expect(cursor).toBe(String(INITIAL_SEQ_ID));
          return HttpResponse.json(
            {
              error: {
                message: "Chat thread events cursor has expired",
                code: "CHAT_THREAD_EVENTS_EXPIRED",
              },
            },
            { status: 410 },
          );
        }
        expect(cursor).toBe(
          String(eventRequests === 1 ? INITIAL_SEQ_ID : REFRESH_SEQ_ID),
        );
        return HttpResponse.json({ events: [], hasMore: false });
      }),
    );

    await chatCommand.parseAsync(["node", "cli", "list", "--json"]);
    mockConsoleLog.mockClear();
    await chatCommand.parseAsync(["node", "cli", "list", "--json"]);

    const output = JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0])) as {
      readonly threads: readonly { readonly title: string }[];
    };
    expect(output.threads[0]?.title).toBe("Refreshed title");
    expect(snapshotRequests).toBe(2);
    expect(eventRequests).toBe(3);
  });

  it("filters unread threads before the limit and orders equal timestamps deterministically", async () => {
    const unreadAt = "2026-07-24T06:00:00.000Z";
    mockStableThreadSnapshot([
      snapshotThread({
        id: THIRD_THREAD_ID,
        title: "Newest but read",
        sortAt: "2026-07-24T07:00:00.000Z",
      }),
      snapshotThread({
        id: THREAD_ID,
        title: "Unread one",
        sortAt: "2026-07-24T03:00:00.000Z",
      }),
      snapshotThread({
        id: SECOND_THREAD_ID,
        title: "Unread two",
        sortAt: "2026-07-24T02:00:00.000Z",
      }),
      snapshotThread({
        id: OTHER_THREAD_ID,
        title: "Another thread unread",
        sortAt: "2026-07-24T08:00:00.000Z",
      }),
    ]);
    let indicatorRequests = 0;
    server.use(
      http.get(INDICATORS_URL, ({ request }) => {
        indicatorRequests++;
        expect(new URL(request.url).searchParams.size).toBe(0);
        return HttpResponse.json({
          agents: {},
          threads: {
            [THREAD_ID]: "unread",
            [SECOND_THREAD_ID]: "unread",
            [OTHER_THREAD_ID]: "unread",
          },
          unreadAt: {
            [THREAD_ID]: unreadAt,
            [SECOND_THREAD_ID]: unreadAt,
            [OTHER_THREAD_ID]: "2026-07-24T09:00:00.000Z",
          },
        });
      }),
    );

    await chatCommand.parseAsync([
      "node",
      "cli",
      "list",
      "--unread",
      "--limit",
      "1",
      "--json",
    ]);

    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      {
        total: 3,
        threads: [
          expect.objectContaining({
            id: OTHER_THREAD_ID,
            unreadAt: "2026-07-24T09:00:00.000Z",
          }),
        ],
      },
    );

    mockConsoleLog.mockClear();
    await chatCommand.parseAsync([
      "node",
      "cli",
      "list",
      "--unread",
      "--limit",
      "3",
    ]);
    const humanOutput = mockConsoleLog.mock.calls.flat().join("\n");
    expect(humanOutput).toContain("UNREAD AT");
    expect(humanOutput).toContain("2026-07-24T06:00:00Z");
    expect(humanOutput.indexOf(SECOND_THREAD_ID)).toBeLessThan(
      humanOutput.indexOf(THREAD_ID),
    );
    expect(indicatorRequests).toBe(2);
  });

  it("lists unread threads in the workspace with one indicators request", async () => {
    const threads = Array.from({ length: 6 }, (_, index) => {
      return snapshotThread({
        id: `00000000-0000-4000-8000-${String(210 + index).padStart(12, "0")}`,
        title: `Thread ${index}`,
        sortAt: new Date(
          Date.parse("2026-07-24T01:00:00.000Z") + index * 1000,
        ).toISOString(),
      });
    });
    mockStableThreadSnapshot(threads);
    let requestCount = 0;
    server.use(
      http.get(INDICATORS_URL, () => {
        requestCount += 1;
        return HttpResponse.json({
          agents: {},
          threads: Object.fromEntries(
            threads.map((thread) => {
              return [thread.id, "unread"];
            }),
          ),
          unreadAt: Object.fromEntries(
            threads.map((thread) => {
              return [thread.id, thread.sortAt];
            }),
          ),
        });
      }),
    );

    await chatCommand.parseAsync(["node", "cli", "list", "--unread", "--json"]);
    expect(requestCount).toBe(1);
    const output = JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0])) as {
      readonly total: number;
      readonly threads: readonly {
        readonly id: string;
        readonly unreadAt: string;
      }[];
    };
    expect(output.total).toBe(6);
    expect(output.threads).toHaveLength(6);
    expect(output.threads[0]).toMatchObject({
      id: threads.at(-1)?.id,
      unreadAt: threads.at(-1)?.sortAt,
    });
  });

  it("keeps human output unchanged without new flags and reports empty unread results", async () => {
    mockStableThreadSnapshot([
      snapshotThread({
        id: THREAD_ID,
        title: "Existing human row",
        sortAt: "2026-07-24T03:00:00.000Z",
      }),
    ]);
    server.use(
      http.get(INDICATORS_URL, () => {
        return HttpResponse.json({ agents: {}, threads: {}, unreadAt: {} });
      }),
    );

    await chatCommand.parseAsync(["node", "cli", "list"]);
    const existingOutput = mockConsoleLog.mock.calls.flat().join("\n");
    expect(existingOutput).toContain("THREAD ID");
    expect(existingOutput).toContain("SORTED");
    expect(existingOutput).toContain("PINNED");
    expect(existingOutput).not.toContain("UNREAD AT");

    mockConsoleLog.mockClear();
    await chatCommand.parseAsync(["node", "cli", "list", "--unread"]);
    expect(mockConsoleLog).toHaveBeenCalledWith("No unread chat threads found");
  });

  it("lists only archived threads with --archived", async () => {
    mockStableThreadSnapshot([
      snapshotThread({
        id: THREAD_ID,
        title: "✅ Active row",
        sortAt: "2026-07-24T03:00:00.000Z",
      }),
      snapshotThread({
        id: OTHER_THREAD_ID,
        title: "Archived row",
        sortAt: "2026-07-24T04:00:00.000Z",
        archived: true,
      }),
    ]);

    await chatCommand.parseAsync([
      "node",
      "cli",
      "list",
      "--archived",
      "--json",
    ]);
    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      {
        total: 1,
        threads: [
          expect.objectContaining({
            id: OTHER_THREAD_ID,
            title: "Archived row",
            archived: true,
          }),
        ],
      },
    );

    mockConsoleLog.mockClear();
    await chatCommand.parseAsync(["node", "cli", "list"]);
    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("ARCHIVED");
    expect(output).toContain("✅ Active row");
    expect(output).toContain("Archived row");
  });

  it("reports invalid chat cache scope errors", async () => {
    vi.stubEnv("OKOU_TOKEN", "vm0_sandbox_malformed");

    await expect(async () => {
      await chatCommand.parseAsync(["node", "cli", "list"]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain(
      "OKOU_TOKEN does not contain a valid chat cache scope",
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });
  it("enumerates every Project page across Agents, including archived history", async () => {
    const projectId = "00000000-0000-4000-8000-000000000071";
    const all = Array.from({ length: 101 }, (_, index) => {
      return {
        ...snapshotThread({
          id: `00000000-0000-4000-8000-${String(1000 + index).padStart(12, "0")}`,
          title: `Related ${index}`,
          sortAt: "2026-11-02T00:00:00.000Z",
          archived: index === 100,
        }),
        projectId,
      };
    });
    all.unshift({
      ...snapshotThread({
        id: OTHER_THREAD_ID,
        title: "Hidden Project chat",
        sortAt: "2026-11-02T01:00:00.000Z",
        hidden: true,
      }),
      projectId,
    });
    server.use(
      http.get(`http://localhost:3000/api/projects/${projectId}`, () => {
        return HttpResponse.json({
          id: projectId,
          name: "Launch",
          createdAt: "2026-11-02T00:00:00.000Z",
          updatedAt: "2026-11-02T00:00:00.000Z",
        });
      }),
      http.get(
        `http://localhost:3000/api/projects/${projectId}/threads`,
        ({ request }) => {
          const after = new URL(request.url).searchParams.get("after");
          return HttpResponse.json(
            after
              ? { threads: all.slice(100), nextAfter: null }
              : { threads: all.slice(0, 100), nextAfter: all[99]!.id },
          );
        },
      ),
    );
    await chatCommand.parseAsync([
      "node",
      "cli",
      "list",
      "--project-id",
      projectId,
      "--limit",
      "all",
      "--json",
    ]);
    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toMatchObject(
      { total: 101, complete: true },
    );
    expect(
      JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0])).threads,
    ).toHaveLength(101);
  });
});
