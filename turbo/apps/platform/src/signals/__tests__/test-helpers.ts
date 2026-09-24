import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import type { ChatEventCursor } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { createStore, type Store } from "ccstate";
import { afterEach, beforeAll, beforeEach } from "vitest";
import { installPlatformLifecycle } from "../../test/platform-lifecycle.ts";
import { installSharedDatabaseWorkerBootstrap } from "../../test/shared-database-worker-bootstrap.ts";
import { logger, resetLoggerForTest } from "../log";
import { resetLocalStorageForTest$ } from "../external/local-storage";
import { resetSessionStorageForTest$ } from "../external/session-storage.ts";
import { resetAllMockHandlers } from "../../mocks/handlers";
import { createTestMocks, type TestMocks } from "./test-mocks.ts";

const L = logger("Test");
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function testCursorEventId(row: ChatEventRow): string {
  if (UUID_PATTERN.test(row.id)) {
    return row.id;
  }
  const suffix = row.seqId.toString(16).padStart(12, "0").slice(-12);
  return `00000000-0000-4000-8000-${suffix}`;
}

export function chatEventRowsResponse(
  rows: readonly ChatEventRow[],
  query: {
    readonly sinceSeqId: number;
    readonly sinceEventId?: string;
  },
  options: {
    readonly cursor?: ChatEventCursor;
    readonly hasMore?: boolean;
  } = {},
): {
  readonly rows: ChatEventRow[];
  readonly cursor: ChatEventCursor;
  readonly hasMore: boolean;
} {
  const lastRow = rows.at(-1);
  let cursor: ChatEventCursor;
  if (options.cursor !== undefined) {
    cursor = options.cursor;
  } else if (lastRow !== undefined) {
    cursor = {
      // Many old UI fixtures use human-readable row IDs even though real DB
      // cursors are UUIDs. Normalize only the mock cursor boundary.
      lastEventId: testCursorEventId(lastRow),
      lastSeqId: lastRow.seqId,
    };
  } else if (query.sinceEventId !== undefined) {
    cursor = {
      lastEventId: query.sinceEventId,
      lastSeqId: query.sinceSeqId,
    };
  } else {
    cursor = { lastEventId: null, lastSeqId: 0 };
  }
  return {
    rows: [...rows],
    cursor,
    hasMore: options.hasMore ?? false,
  };
}

export interface TestContext {
  readonly mocks: TestMocks;
  readonly resourceId: string;
  readonly signal: AbortSignal;
  readonly store: Store;
  readonly workerStore: Store;
}

export function testContext(): TestContext {
  let store: Store | null = null;
  let workerStore: Store | null = null;
  let mocks: TestMocks | null = null;
  let resourceId: string | null = null;
  let controller = new AbortController();

  const context: TestContext = {
    get mocks(): TestMocks {
      if (!mocks) {
        mocks = createTestMocks(() => {
          return context.signal;
        });
        context.signal.addEventListener(
          "abort",
          () => {
            resetAllMockHandlers();
          },
          { once: true },
        );
      }
      return mocks;
    },
    get resourceId(): string {
      resourceId ??= crypto.randomUUID();
      return resourceId;
    },
    get signal(): AbortSignal {
      return controller.signal;
    },
    get store(): Store {
      if (!store) {
        L.debug("create store");
        store = createStore();
        context.signal.addEventListener("abort", () => {
          store?.set(resetLocalStorageForTest$);
          store?.set(resetSessionStorageForTest$);
          resetLoggerForTest();

          store = null;
        });
      }
      return store;
    },
    get workerStore(): Store {
      if (!workerStore) {
        L.debug("create worker store");
        workerStore = createStore();
        context.signal.addEventListener(
          "abort",
          () => {
            workerStore = null;
          },
          { once: true },
        );
      }
      return workerStore;
    },
  };

  beforeEach(() => {
    installPlatformLifecycle(context.signal);
    installSharedDatabaseWorkerBootstrap(context.signal);
  });

  afterEach(() => {
    L.debug("cleanup context");
    const error = new Error("Aborted due to finished test");
    error.name = "AbortError";
    controller.abort(error);
    mocks = null;
    resourceId = null;
    controller = new AbortController();
  });

  return context;
}

/**
 * Loads the real mermaid parser behind the test stub before a file's first
 * test. The stub delegates `parse` to the real module, whose one-time
 * transform is too slow for the first diagram assertion's waitFor budget, so
 * files that render diagrams pay it in setup instead.
 */
export function warmMermaidParser(): void {
  beforeAll(async () => {
    const { default: mermaid } = await import("@okouai/mermaid-lite");
    await mermaid.parse("flowchart TD\n  A --> B", { suppressErrors: true });
  });
}
