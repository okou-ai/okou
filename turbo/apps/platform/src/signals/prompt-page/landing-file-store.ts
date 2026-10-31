import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { now } from "../../lib/time.ts";
import { LandingFilesUnavailableError } from "./landing-file-handoff.ts";

interface LandingFileDatabase extends DBSchema {
  files: {
    key: string;
    value: {
      blob: Blob;
      name: string;
      type: string;
      lastModified: number;
      expiresAt: number;
    };
  };
}

async function withLandingFileStore<T>(
  operation: (database: IDBPDatabase<LandingFileDatabase>) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  const database = await openDB<LandingFileDatabase>(
    "okou-landing-additions",
    1,
    {
      upgrade(db) {
        db.createObjectStore("files");
      },
    },
  );
  if (signal.aborted) {
    database.close();
    signal.throwIfAborted();
  }
  const [result] = await Promise.allSettled([operation(database)]);
  database.close();
  signal.throwIfAborted();
  if (result.status === "rejected") {
    throw result.reason;
  }
  return result.value;
}

export async function saveLandingFileAdditions(
  draftId: string,
  files: readonly { key: string; file: File }[],
  signal: AbortSignal,
): Promise<void> {
  await withLandingFileStore(async (database) => {
    const transaction = database.transaction("files", "readwrite");
    await Promise.all([
      transaction.done,
      ...files.map(({ key, file }) => {
        return transaction.store.put(
          {
            blob: file.slice(),
            name: file.name,
            type: file.type,
            lastModified: file.lastModified,
            expiresAt: now() + 24 * 60 * 60 * 1000,
          },
          `${draftId}:${key}`,
        );
      }),
    ]);
  }, signal);
}

export async function readLandingFileAdditions(
  draftId: string,
  keys: readonly string[],
  signal: AbortSignal,
): Promise<File[]> {
  if (!keys.length) {
    return [];
  }
  return await withLandingFileStore(async (database) => {
    const records = await Promise.all(
      keys.map((key) => {
        return database.get("files", `${draftId}:${key}`);
      }),
    );
    return records.map((record) => {
      if (!record || record.expiresAt < now()) {
        throw new LandingFilesUnavailableError();
      }
      return new File([record.blob], record.name, {
        type: record.type,
        lastModified: record.lastModified,
      });
    });
  }, signal);
}

export async function removeLandingFileAddition(
  draftId: string,
  key: string,
  signal: AbortSignal,
): Promise<void> {
  await withLandingFileStore(async (database) => {
    await database.delete("files", `${draftId}:${key}`);
  }, signal);
}
