import {
  openDB,
  type DBSchema,
  type IDBPDatabase,
  type OpenDBCallbacks,
} from "idb";
import { observeClientOperation } from "../../lib/client-telemetry.ts";
import { logger } from "../log.ts";
import { CHAT_IDB_VERSION, upgradeChatIdb } from "./chat-idb-schema.ts";

const L = logger("ChatIdbStore");

type OpenChatIdbDatabase = <DBTypes extends DBSchema | unknown = unknown>(
  name: string,
  version?: number,
  callbacks?: OpenDBCallbacks<DBTypes>,
) => Promise<IDBPDatabase<DBTypes>>;

interface ChatIdbOpenerOptions {
  readonly openDatabase?: OpenChatIdbDatabase;
  // Notify the caller after closing a connection whose schema changed.
  readonly onVersionChange: () => void;
}

interface ChatIdbOpener {
  readonly openChatIdb: (
    userId: string,
    orgId: string,
  ) => Promise<IDBPDatabase>;
}

function chatIdbName(userId: string, orgId: string): string {
  return `vm0-chat-${userId}-${orgId}`;
}

/**
 * Open the per-credential chat IndexedDB database.
 */
export function createChatIdbOpener(
  options: ChatIdbOpenerOptions,
): ChatIdbOpener {
  const openDatabase = options.openDatabase ?? openDB;
  const onVersionChange = options.onVersionChange;

  return {
    async openChatIdb(userId, orgId) {
      const dbName = chatIdbName(userId, orgId);
      L.debug("openDB", { dbName });
      const db = await observeClientOperation(
        { event_name: "indexeddb.open", database: "chat" },
        () => {
          return openDatabase(dbName, CHAT_IDB_VERSION, {
            upgrade(db, oldVersion) {
              L.debug("openDB:upgrade", { dbName });
              upgradeChatIdb(db, oldVersion);
            },
            blocked(currentVersion, blockedVersion) {
              L.warn("openDB:blocked", {
                dbName,
                currentVersion,
                blockedVersion,
              });
            },
          });
        },
      );
      db.addEventListener(
        "versionchange",
        (event) => {
          L.warn("versionchange", {
            dbName,
            currentVersion: event.oldVersion,
            nextVersion: event.newVersion,
          });
          db.close();
          onVersionChange();
        },
        { once: true },
      );
      return db;
    },
  };
}
