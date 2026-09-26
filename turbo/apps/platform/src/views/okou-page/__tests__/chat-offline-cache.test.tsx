import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { CURRENT_CHAT_EVENT_SCHEMA_VERSION } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  chatThreadByIdContract,
  chatThreadEventsContract,
  chatThreadsContract,
  type ChatThreadSnapshotProjection,
} from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor } from "@testing-library/react";
import { openDB } from "idb";
import { expect, test } from "vitest";
import {
  startPage,
  type SetupPageAuth,
} from "../../../__tests__/page-helper.ts";
import {
  mockChatThreadSnapshotResponse,
  chatEventRowsResponse,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  CHAT_EVENT_CURSOR_STORE,
  CHAT_EVENT_ROWS_STORE,
  CHAT_IDB_VERSION,
  CHAT_THREAD_SNAPSHOT_STORE,
  upgradeChatIdb,
} from "../../../signals/external/chat-idb-schema.ts";
import {
  mockChatEventRows,
  normalizeMockChatEvents,
} from "./chat-event-test-helpers.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const EMPTY_CONVERSATION = "Send a message to start the conversation";

interface CacheIdentity {
  readonly auth: Exclude<SetupPageAuth, null>;
  readonly orgId: string;
  readonly userId: string;
}

function cacheIdentity(label: string): CacheIdentity {
  const suffix = context.resourceId;
  const userId = `offline-${label}-user-${suffix}`;
  const orgId = `offline-${label}-org-${suffix}`;
  return {
    userId,
    orgId,
    auth: {
      user: { id: userId, fullName: "Offline Cache User" },
      organization: {
        activeOrg: { id: orgId, name: "Offline Cache Workspace" },
        memberships: [{ id: orgId }],
      },
    },
  };
}

function threadSnapshot(
  id: string,
  title: string,
): ChatThreadSnapshotProjection {
  return {
    id,
    agentId: AGENT_ID,
    title,
    sortAt: "2026-08-20T12:00:00.000Z",
    createdAt: "2026-08-20T11:00:00.000Z",
    updatedAt: "2026-08-20T12:00:00.000Z",
    pinnedAt: null,
    archived: false,
    renamedAt: null,
    selectedModel: "claude-sonnet-5",
    serviceTier: null,
    computerUseHostId: null,
    cloudBrowserEnabled: false,
    selectedVideoModel: null,
    selectedImageModel: null,
  };
}

function completedConversationRows(
  threadId: string,
  prompt: string,
  answer: string,
): ChatEventRow[] {
  const runId = "d0000000-0000-4000-a000-000000000901";
  return mockChatEventRows(
    normalizeMockChatEvents(
      [
        {
          id: "e0000000-0000-4000-a000-000000000901",
          threadId,
          role: "user",
          content: prompt,
          runId,
          seqId: 1,
          createdAt: "2026-08-20T12:00:01.000Z",
        },
        {
          id: "e0000000-0000-4000-a000-000000000902",
          threadId,
          role: "assistant",
          content: answer,
          runId,
          seqId: 2,
          createdAt: "2026-08-20T12:00:02.000Z",
        },
        {
          id: "e0000000-0000-4000-a000-000000000903",
          threadId,
          role: "assistant",
          content: null,
          runId,
          runLifecycleEvent: "completed",
          seqId: 3,
          createdAt: "2026-08-20T12:00:03.000Z",
        },
      ],
      threadId,
    ),
  );
}

async function seedChatCache(
  identity: CacheIdentity,
  thread: ChatThreadSnapshotProjection,
  rows: readonly ChatEventRow[] = [],
): Promise<void> {
  const database = await openDB(
    `vm0-chat-${identity.userId}-${identity.orgId}`,
    CHAT_IDB_VERSION,
    {
      upgrade(db, oldVersion) {
        upgradeChatIdb(db, oldVersion);
      },
    },
  );
  try {
    const stores = [
      CHAT_THREAD_SNAPSHOT_STORE,
      ...(rows.length > 0
        ? [CHAT_EVENT_ROWS_STORE, CHAT_EVENT_CURSOR_STORE]
        : []),
    ];
    const transaction = database.transaction(stores, "readwrite");
    const lastRow = rows.at(-1);
    await Promise.all([
      transaction.objectStore(CHAT_THREAD_SNAPSHOT_STORE).put({
        id: "current",
        chatThreads: [thread],
        latestEventId: null,
        latestSeqId: null,
      }),
      ...rows.map((row) => {
        return transaction.objectStore(CHAT_EVENT_ROWS_STORE).put(row);
      }),
      ...(lastRow
        ? [
            transaction.objectStore(CHAT_EVENT_CURSOR_STORE).put({
              threadId: thread.id,
              schemaVersion: CURRENT_CHAT_EVENT_SCHEMA_VERSION,
              lastEventId: lastRow.id,
              lastSeqId: lastRow.seqId,
            }),
          ]
        : []),
      transaction.done,
    ]);
  } finally {
    database.close();
  }
}

function mockNoBrowserSession(): void {
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "BROWSER_NOT_FOUND",
        message: "Managed browser not found",
      },
    });
  });
}

function mockThreadSnapshot(
  readThreads: () => readonly ChatThreadSnapshotProjection[],
  options: {
    readonly gate?: Promise<void>;
    readonly onRequest?: () => void;
  } = {},
): void {
  context.mocks.api(chatThreadsContract.snapshot, async ({ respond }) => {
    options.onRequest?.();
    await options.gate;
    return respond(
      200,
      mockChatThreadSnapshotResponse(context, {
        chatThreads: [...readThreads()],
        latestEventId: null,
        latestSeqId: null,
      }),
    );
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
}

function mockConversationRows(
  rows: readonly ChatEventRow[],
  options: {
    readonly gate?: Promise<void>;
    readonly onRequest?: () => void;
  } = {},
): void {
  context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
    return respond(404, {
      error: {
        message: "Chat event snapshot not found",
        code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
      },
    });
  });
  context.mocks.api(
    chatThreadEventsContract.rows,
    async ({ query, respond }) => {
      options.onRequest?.();
      await options.gate;
      return respond(
        200,
        chatEventRowsResponse(
          rows.filter((row) => {
            return row.seqId > query.sinceSeqId;
          }),
          query,
        ),
      );
    },
  );
}

async function visibleAppSkeleton(): Promise<HTMLElement> {
  const skeleton = await screen.findByRole("status", { name: "Loading" });
  expect(skeleton).toHaveAttribute("data-testid", "app-skeleton");
  expect(skeleton).not.toHaveAttribute("aria-hidden");
  return skeleton;
}

async function visibleChatSkeleton(): Promise<HTMLElement> {
  return await waitFor(() => {
    const skeleton = document.querySelector<HTMLElement>(
      "[data-chat-skeleton]",
    );
    if (!skeleton) {
      throw new Error("Chat loading placeholder is not visible");
    }
    expect(skeleton).toBeVisible();
    return skeleton;
  });
}

async function expectAppSkeletonDismissed(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId("app-skeleton")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });
}

test("A missing chat is reported only after its current availability is confirmed", async () => {
  const identity = cacheIdentity("confirmed-missing");
  const threadId = "b0000000-0000-4000-a000-000000000912";
  const availabilityRequested = context.mocks.deferred<void>();
  const availabilityReady = context.mocks.deferred<void>();
  mockNoBrowserSession();
  mockThreadSnapshot(
    () => {
      return [];
    },
    {
      gate: availabilityReady.promise,
      onRequest: () => {
        availabilityRequested.resolve();
      },
    },
  );

  await startPage({
    context,
    path: `/chats/${threadId}`,
    host: "app.okou.ai",
    auth: identity.auth,
  });

  await visibleAppSkeleton();

  await availabilityRequested.promise;

  expect(
    screen.queryByRole("heading", { name: "Chat thread not found" }),
  ).not.toBeInTheDocument();

  availabilityReady.resolve();

  const notFound = await screen.findByRole("heading", {
    name: "Chat thread not found",
  });
  expect(notFound).toBeVisible();
  await expectAppSkeletonDismissed();
  expect(
    screen.queryByRole("textbox", { name: "Message" }),
  ).not.toBeInTheDocument();
});

test("Downloaded chat history replaces loading without a blank gap", async () => {
  const identity = cacheIdentity("download-history");
  const thread = threadSnapshot(
    "b0000000-0000-4000-a000-000000000914",
    "Downloaded history chat",
  );
  const prompt = "Prepare the release checklist";
  const answer = "The release checklist is ready for review.";
  const historyReady = context.mocks.deferred<void>();
  const housekeepingStarted = context.mocks.deferred<void>();
  const housekeepingReady = context.mocks.deferred<void>();
  mockNoBrowserSession();
  mockThreadSnapshot(() => {
    return [thread];
  });
  mockConversationRows(completedConversationRows(thread.id, prompt, answer), {
    gate: historyReady.promise,
  });
  context.mocks.api(chatThreadByIdContract.get, async ({ respond }) => {
    housekeepingStarted.resolve();
    await housekeepingReady.promise;
    return respond(200, {
      lastReadAt: "2026-08-20T12:00:00.000Z",
      cancellationRecoveryPending: false,
    });
  });

  await startPage({
    context,
    path: `/chats/${thread.id}`,
    host: "app.okou.ai",
    auth: identity.auth,
  });

  const loading = await visibleChatSkeleton();

  historyReady.resolve();

  const downloadedAnswer = await screen.findByText(answer);
  expect(downloadedAnswer).toBeVisible();
  expect(screen.getByText(prompt)).toBeVisible();
  expect(loading).not.toBeInTheDocument();
  await expectAppSkeletonDismissed();
  await housekeepingStarted.promise;
  expect(screen.queryByText(EMPTY_CONVERSATION)).not.toBeInTheDocument();
});

test("A stale remembered thread is replaced by its current availability", async () => {
  const identity = cacheIdentity("stale-thread");
  const thread = threadSnapshot(
    "b0000000-0000-4000-a000-000000000915",
    "Outdated remembered title",
  );
  await seedChatCache(identity, thread);
  const availabilityRequested = context.mocks.deferred<void>();
  const availabilityReady = context.mocks.deferred<void>();
  mockNoBrowserSession();
  mockThreadSnapshot(
    () => {
      return [];
    },
    {
      gate: availabilityReady.promise,
      onRequest: () => {
        availabilityRequested.resolve();
      },
    },
  );
  mockConversationRows([]);

  await startPage({
    context,
    path: `/chats/${thread.id}`,
    host: "app.okou.ai",
    auth: identity.auth,
  });

  await visibleAppSkeleton();

  await availabilityRequested.promise;
  await waitFor(() => {
    expect(screen.getByTestId("chat-thread-header-title")).toHaveTextContent(
      "Outdated remembered title",
    );
  });
  const composer = await screen.findByRole("textbox", { name: "Message" });
  expect(composer).toBeEnabled();
  availabilityReady.resolve();

  const notFound = await screen.findByRole("heading", {
    name: "Chat thread not found",
  });
  expect(notFound).toBeVisible();
  await expectAppSkeletonDismissed();
  expect(
    screen.queryByRole("textbox", { name: "Message" }),
  ).not.toBeInTheDocument();
});

test("Saved messages appear without an empty-state flash", async () => {
  const identity = cacheIdentity("saved-history");
  const thread = threadSnapshot(
    "b0000000-0000-4000-a000-000000000918",
    "Saved history chat",
  );
  const savedResponse = "The saved response is available immediately.";
  const rows = completedConversationRows(
    thread.id,
    "Read the saved response",
    savedResponse,
  );
  await seedChatCache(identity, thread, rows);
  const housekeepingStarted = context.mocks.deferred<void>();
  const housekeepingReady = context.mocks.deferred<void>();
  mockNoBrowserSession();
  mockThreadSnapshot(() => {
    return [thread];
  });
  mockConversationRows(rows);
  context.mocks.api(chatThreadByIdContract.get, async ({ respond }) => {
    housekeepingStarted.resolve();
    await housekeepingReady.promise;
    return respond(200, {
      lastReadAt: "2026-08-20T12:00:00.000Z",
      cancellationRecoveryPending: false,
    });
  });

  // Startup stays blocked on the gated housekeeping request, so this test awaits
  // the rendered page instead of full startup before asserting cached content.
  const page = await startPage({
    context,
    path: `/chats/${thread.id}`,
    host: "app.okou.ai",
    auth: identity.auth,
  });

  await visibleAppSkeleton();
  await page.content;

  await housekeepingStarted.promise;
  const visibleSavedResponse = await screen.findByText(savedResponse);
  expect(visibleSavedResponse).toBeVisible();
  await expectAppSkeletonDismissed();

  expect(
    document.querySelector("[data-chat-skeleton]"),
  ).not.toBeInTheDocument();
  expect(screen.queryByText(EMPTY_CONVERSATION)).not.toBeInTheDocument();
});
