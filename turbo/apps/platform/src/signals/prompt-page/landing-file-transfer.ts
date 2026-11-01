import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { now } from "../../lib/time.ts";
import { hash, search } from "../location.ts";
import { createDeferredPromise } from "../utils.ts";
import {
  landingFileSource,
  validLandingFiles,
} from "./landing-file-handoff.ts";

interface TransferredFilesDatabase extends DBSchema {
  drafts: {
    key: string;
    value: {
      source: string;
      expiresAt: number;
      files: { blob: Blob; name: string; type: string; lastModified: number }[];
    };
  };
}

function database() {
  return openDB<TransferredFilesDatabase>("okou-landing-transfers", 1, {
    upgrade(db) {
      db.createObjectStore("drafts");
    },
  });
}

async function withStore<T>(
  operation: (db: IDBPDatabase<TransferredFilesDatabase>) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  const db = await database();
  const [result] = await Promise.allSettled([operation(db)]);
  db.close();
  signal.throwIfAborted();
  if (result.status === "rejected") {
    throw result.reason;
  }
  return result.value;
}

export async function readTransferredLandingFiles(
  source: URL | null,
  id: string,
  signal: AbortSignal,
): Promise<File[] | null> {
  if (!source) {
    return null;
  }
  return await withStore(async (db) => {
    signal.throwIfAborted();
    const draft = await db.get("drafts", id);
    signal.throwIfAborted();
    if (!draft || draft.source !== source.href || draft.expiresAt < now()) {
      if (draft && draft.expiresAt < now()) {
        await db.delete("drafts", id);
      }
      return null;
    }
    return draft.files.map((file) => {
      return new File([file.blob], file.name, {
        type: file.type,
        lastModified: file.lastModified,
      });
    });
  }, signal);
}

async function storeTransfer(
  pendingFiles: Promise<File[]>,
  source: URL,
  id: string,
  signal: AbortSignal,
) {
  const files = await pendingFiles;
  signal.throwIfAborted();
  await withStore(async (db) => {
    signal.throwIfAborted();
    const tx = db.transaction("drafts", "readwrite");
    let cursor = await tx.store.openCursor();
    while (cursor) {
      if (cursor.value.expiresAt < now()) {
        await cursor.delete();
      }
      cursor = await cursor.continue();
    }
    await tx.store.put(
      {
        source: source.href,
        expiresAt: now() + 24 * 60 * 60 * 1000,
        files: files.map((file) => {
          return {
            blob: file.slice(),
            name: file.name,
            type: file.type,
            lastModified: file.lastModified,
          };
        }),
      },
      id,
    );
    await tx.done;
  }, signal);
}

/** Receive browser-local bytes before auth; no upload or account action occurs. */
export async function receiveLandingFileTransfer(
  ownerSignal: AbortSignal,
): Promise<boolean> {
  const nonce = new URLSearchParams(hash().slice(1)).get("landingFileTransfer");
  if (!nonce) {
    return false;
  }
  const params = new URLSearchParams(search());
  const id = params.get("landingFiles") ?? "";
  const source = landingFileSource(
    params.get("landingSource") ?? "",
    location.origin,
  );
  const opener: Window | null = window.opener;
  const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
  if (!source || !opener || !uuid.test(id) || !uuid.test(nonce)) {
    return true;
  }
  const signal = AbortSignal.any([ownerSignal, AbortSignal.timeout(60_000)]);
  const result = createDeferredPromise<File[]>(signal);
  const receive = (event: MessageEvent<unknown>) => {
    if (event.origin !== source.origin || event.source !== opener) {
      return;
    }
    const data = event.data;
    if (
      !data ||
      typeof data !== "object" ||
      !("type" in data) ||
      data.type !== "okou:landing-files:transfer" ||
      !("nonce" in data) ||
      data.nonce !== nonce ||
      !("id" in data) ||
      data.id !== id ||
      !("files" in data)
    ) {
      return;
    }
    if (!validLandingFiles(data.files)) {
      result.reject(new Error("Invalid landing files"));
      return;
    }
    result.resolve(data.files);
  };
  window.addEventListener("message", receive);
  opener.postMessage(
    { type: "okou:landing-files:transfer-ready", id, nonce },
    source.origin,
  );
  const [outcome] = await Promise.allSettled([
    storeTransfer(result.promise, source, id, signal),
  ]);
  window.removeEventListener("message", receive);
  ownerSignal.throwIfAborted();
  // The originating landing page owns recovery and retains the selected files.
  opener.postMessage(
    {
      type:
        outcome.status === "fulfilled"
          ? "okou:landing-files:transferred"
          : "okou:landing-files:transfer-failed",
      id,
      nonce,
    },
    source.origin,
  );
  return true;
}
