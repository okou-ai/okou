import { openDB, type IDBPDatabase } from "idb";
import { expect, test, vi } from "vitest";
import { testContext } from "../../__tests__/test-helpers.ts";
import { createChatIdbOpener } from "../chat-idb-opener.ts";
import {
  CHAT_EVENT_CURSOR_STORE,
  CHAT_EVENT_ROWS_ORDER_INDEX,
  CHAT_EVENT_ROWS_STORE,
  CHAT_IDB_VERSION,
  CHAT_THREAD_EVENT_SYNC_STORE,
  CHAT_THREAD_EVENTS_ORDER_INDEX,
  CHAT_THREAD_EVENTS_STORE,
  CHAT_THREAD_SNAPSHOT_STORE,
} from "../chat-idb-schema.ts";

const context = testContext();

function closeOnAbort(database: IDBPDatabase): IDBPDatabase {
  context.signal.addEventListener("abort", () => {
    database.close();
  });
  return database;
}

test("Local conversation data is isolated by user and workspace", async () => {
  const onVersionChange = vi.fn<() => void>();
  const opener = createChatIdbOpener({ onVersionChange });
  const identitySuffix = context.resourceId;
  const primary = closeOnAbort(
    await opener.openChatIdb(
      `alice-${identitySuffix}`,
      `workspace-alpha-${identitySuffix}`,
    ),
  );
  const otherWorkspace = closeOnAbort(
    await opener.openChatIdb(
      `alice-${identitySuffix}`,
      `workspace-beta-${identitySuffix}`,
    ),
  );
  const otherUser = closeOnAbort(
    await opener.openChatIdb(
      `bob-${identitySuffix}`,
      `workspace-alpha-${identitySuffix}`,
    ),
  );
  const privateSnapshot = {
    id: "private-thread",
    title: "Alice's private conversation",
  };

  await primary.put(CHAT_THREAD_SNAPSHOT_STORE, privateSnapshot);

  await expect(
    primary.get(CHAT_THREAD_SNAPSHOT_STORE, privateSnapshot.id),
  ).resolves.toStrictEqual(privateSnapshot);
  await expect(
    otherWorkspace.get(CHAT_THREAD_SNAPSHOT_STORE, privateSnapshot.id),
  ).resolves.toBeUndefined();
  await expect(
    otherUser.get(CHAT_THREAD_SNAPSHOT_STORE, privateSnapshot.id),
  ).resolves.toBeUndefined();
  expect(onVersionChange).not.toHaveBeenCalled();
});

test("A local chat-cache upgrade closes the old connection and notifies its owner", async () => {
  const identitySuffix = context.resourceId;
  const userId = `upgrade-user-${identitySuffix}`;
  const orgId = `upgrade-workspace-${identitySuffix}`;
  const databaseName = `vm0-chat-${userId}-${orgId}`;
  const oldDatabase = await openDB(databaseName, CHAT_IDB_VERSION - 1);
  oldDatabase.close();
  const onVersionChange = vi.fn<() => void>();
  const database = closeOnAbort(
    await createChatIdbOpener({ onVersionChange }).openChatIdb(userId, orgId),
  );

  expect(Array.from(database.objectStoreNames).sort()).toStrictEqual(
    [
      CHAT_EVENT_CURSOR_STORE,
      CHAT_EVENT_ROWS_STORE,
      CHAT_THREAD_EVENT_SYNC_STORE,
      CHAT_THREAD_EVENTS_STORE,
      CHAT_THREAD_SNAPSHOT_STORE,
    ].sort(),
  );
  expect(
    database
      .transaction(CHAT_EVENT_ROWS_STORE)
      .store.indexNames.contains(CHAT_EVENT_ROWS_ORDER_INDEX),
  ).toBeTruthy();

  const write = database.transaction(CHAT_THREAD_EVENTS_STORE, "readwrite");
  await Promise.all([
    write.store.put({ id: "event-three", seqId: 3 }),
    write.store.put({ id: "event-one", seqId: 1 }),
    write.store.put({ id: "event-two", seqId: 2 }),
    write.done,
  ]);
  const orderedEvents = await database.getAllFromIndex(
    CHAT_THREAD_EVENTS_STORE,
    CHAT_THREAD_EVENTS_ORDER_INDEX,
  );
  expect(orderedEvents).toStrictEqual([
    { id: "event-one", seqId: 1 },
    { id: "event-two", seqId: 2 },
    { id: "event-three", seqId: 3 },
  ]);

  const newerDatabase = closeOnAbort(
    await openDB(databaseName, CHAT_IDB_VERSION + 1),
  );

  expect(newerDatabase.version).toBe(CHAT_IDB_VERSION + 1);
  expect(onVersionChange).toHaveBeenCalledOnce();
});
