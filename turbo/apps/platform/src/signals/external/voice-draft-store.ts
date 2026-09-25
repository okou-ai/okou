import { openDB, type DBSchema } from "idb";
import type { VoiceIoTranscribeContext } from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { observeClientOperation } from "../../lib/client-telemetry.ts";
import { withCleanup } from "../utils.ts";
import { encodeVoiceDraftPcmWav } from "../voice-io/voice-draft-pcm.ts";
import { runIndexedDbTransaction } from "./indexeddb-client.ts";

export interface VoiceDraftRecordingRecord {
  readonly id: string;
  readonly sampleCount: number;
  readonly chunkCount: number;
  readonly progress?: VoiceDraftProgress;
}

export interface VoiceDraftSegment {
  readonly startSample: number;
  readonly endSample: number;
  readonly final: boolean;
  readonly transcript?: string;
}

export interface VoiceDraftProgress {
  readonly revision: number;
  readonly context: VoiceIoTranscribeContext;
  readonly segments: readonly VoiceDraftSegment[];
  readonly text?: string;
}

interface VoiceDraftRecordingDatabase extends DBSchema {
  readonly drafts: {
    readonly key: string;
    readonly value: VoiceDraftRecordingRecord;
  };
  readonly chunks: {
    readonly key: [string, string, number];
    readonly value: ArrayBuffer;
  };
}

async function openVoiceDraftRecordingDatabase() {
  return await observeClientOperation(
    { event_name: "indexeddb.open", database: "voice_drafts" },
    () => {
      return openDB<VoiceDraftRecordingDatabase>("okou-voice-drafts", 1, {
        upgrade(database) {
          database.createObjectStore("drafts");
          database.createObjectStore("chunks");
        },
      });
    },
  );
}

function chunkRange(key: string, id: string): IDBKeyRange {
  return IDBKeyRange.bound([key, id, 0], [key, id, Number.MAX_SAFE_INTEGER]);
}

export async function readVoiceDraftRecording(
  key: string,
): Promise<VoiceDraftRecordingRecord | null> {
  const database = await openVoiceDraftRecordingDatabase();
  return await withCleanup(
    runIndexedDbTransaction(
      {
        database: "voice_drafts",
        template: "voice_drafts.get",
        transaction_mode: "readonly",
      },
      () => {
        return database.transaction("drafts", "readonly");
      },
      async (transaction, track) => {
        return (await track(transaction.store.get(key))) ?? null;
      },
    ),
    () => {
      return database.close();
    },
  );
}

/** Preserve an unfinished recording when a composer resumes. */
export async function createVoiceDraftRecording(
  key: string,
  id: string,
): Promise<VoiceDraftRecordingRecord> {
  const database = await openVoiceDraftRecordingDatabase();
  return await withCleanup(
    runIndexedDbTransaction(
      {
        database: "voice_drafts",
        template: "voice_drafts.create",
        transaction_mode: "readwrite",
      },
      () => {
        return database.transaction("drafts", "readwrite");
      },
      async (transaction, track) => {
        const existing = await track(transaction.store.get(key));
        if (existing) {
          return existing;
        }
        const recording = { id, sampleCount: 0, chunkCount: 0 };
        await track(transaction.store.add(recording, key));
        return recording;
      },
    ),
    () => {
      return database.close();
    },
  );
}

/** Append one PCM chunk and return the recording as stored afterwards. */
export async function appendVoiceDraftSamples(
  key: string,
  id: string,
  sequence: number,
  samples: Float32Array,
): Promise<VoiceDraftRecordingRecord> {
  const database = await openVoiceDraftRecordingDatabase();
  return await withCleanup(
    runIndexedDbTransaction(
      {
        database: "voice_drafts",
        template: "voice_drafts.append",
        transaction_mode: "readwrite",
      },
      () => {
        return database.transaction(["drafts", "chunks"], "readwrite");
      },
      async (transaction, track) => {
        const drafts = transaction.objectStore("drafts");
        const recording = await track(drafts.get(key));
        if (recording?.id !== id || recording.chunkCount !== sequence) {
          throw new Error(
            "Voice recording ownership or chunk sequence changed",
          );
        }
        await track(
          transaction
            .objectStore("chunks")
            .add(samples.slice().buffer, [key, id, sequence]),
        );
        const appended = {
          ...recording,
          chunkCount: sequence + 1,
          sampleCount: recording.sampleCount + samples.length,
        };
        await track(drafts.put(appended, key));
        return appended;
      },
    ),
    () => {
      return database.close();
    },
  );
}

/** Commit a checkpoint without overwriting audio appended during transcription. */
export async function saveVoiceDraftProgress(
  key: string,
  id: string,
  progress: VoiceDraftProgress,
): Promise<void> {
  const database = await openVoiceDraftRecordingDatabase();
  await withCleanup(
    runIndexedDbTransaction(
      {
        database: "voice_drafts",
        template: "voice_drafts.checkpoint",
        transaction_mode: "readwrite",
      },
      () => {
        return database.transaction("drafts", "readwrite");
      },
      async (transaction, track) => {
        const current = await track(transaction.store.get(key));
        if (
          current?.id !== id ||
          (current.progress?.revision ?? 0) + 1 !== progress.revision
        ) {
          throw new Error(
            "Voice recording ownership or transcription checkpoint changed",
          );
        }
        await track(transaction.store.put({ ...current, progress }, key));
      },
    ),
    () => {
      return database.close();
    },
  );
}

export async function readVoiceDraftAudio(
  key: string,
  id: string,
): Promise<Blob> {
  const database = await openVoiceDraftRecordingDatabase();
  return await withCleanup(
    runIndexedDbTransaction(
      {
        database: "voice_drafts",
        template: "voice_drafts.audio",
        transaction_mode: "readonly",
      },
      () => {
        return database.transaction(["drafts", "chunks"], "readonly");
      },
      async (transaction, track) => {
        const recording = await track(
          transaction.objectStore("drafts").get(key),
        );
        if (recording?.id !== id) {
          throw new Error("Voice recording has no saved audio");
        }
        const chunks = await track(
          transaction.objectStore("chunks").getAll(chunkRange(key, id)),
        );
        const samples = new Float32Array(recording.sampleCount);
        let offset = 0;
        for (const chunk of chunks) {
          const batch = new Float32Array(chunk);
          samples.set(batch, offset);
          offset += batch.length;
        }
        return encodeVoiceDraftPcmWav(samples);
      },
    ),
    () => {
      return database.close();
    },
  );
}

export async function deleteVoiceDraftRecording(
  key: string,
  id: string,
): Promise<void> {
  const database = await openVoiceDraftRecordingDatabase();
  await withCleanup(
    runIndexedDbTransaction(
      {
        database: "voice_drafts",
        template: "voice_drafts.delete",
        transaction_mode: "readwrite",
      },
      () => {
        return database.transaction(["drafts", "chunks"], "readwrite");
      },
      async (transaction, track) => {
        const drafts = transaction.objectStore("drafts");
        const current = await track(drafts.get(key));
        if (current?.id === id) {
          await track(
            transaction.objectStore("chunks").delete(chunkRange(key, id)),
          );
          await track(drafts.delete(key));
        }
      },
    ),
    () => {
      return database.close();
    },
  );
}
