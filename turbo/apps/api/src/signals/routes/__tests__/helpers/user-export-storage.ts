import { gunzipSync } from "node:zlib";

import AdmZip from "adm-zip";
import { chatEventRowSchema } from "@okouai/api-contracts/contracts/chat-event-rows";

export function readExportText(zip: AdmZip, path: string): string {
  const entry = zip.getEntry(path);
  if (entry === null) {
    throw new Error(`Expected export entry ${path}`);
  }
  return entry.getData().toString("utf8");
}

export function readExportJsonLines(zip: AdmZip, path: string) {
  const text = readExportText(zip, path).trimEnd();
  return text.length === 0
    ? []
    : text.split("\n").map((line) => {
        return JSON.parse(line) as Record<string, unknown>;
      });
}

function exportManifestRecord(
  zip: AdmZip,
  path: string,
): Record<string, unknown> {
  for (const entry of zip.getEntries()) {
    if (!entry.entryName.startsWith("manifest/files-")) {
      continue;
    }
    for (const record of readExportJsonLines(zip, entry.entryName)) {
      if (record.path === path) {
        return record;
      }
    }
  }
  throw new Error(`Expected a manifest record for ${path}`);
}

function snapshotCoverage(entryName: string): number {
  return Number(/\/snapshots\/(\d+)-/u.exec(entryName)?.[1] ?? 0);
}

export function readDurableExportChatRows(zip: AdmZip, threadId: string) {
  const snapshot = zip
    .getEntries()
    .filter((entry) => {
      return entry.entryName.startsWith(`chat-messages/${threadId}/snapshots/`);
    })
    .sort((left, right) => {
      return (
        snapshotCoverage(left.entryName) - snapshotCoverage(right.entryName)
      );
    })
    .at(-1);
  const coverage = snapshot ? snapshotCoverage(snapshot.entryName) : 0;
  const upperSeqId = Math.max(
    Number(
      exportManifestRecord(zip, `chat-threads/${threadId}.json`).upperSeqId,
    ),
    coverage,
  );
  const archived = snapshot
    ? gunzipSync(snapshot.getData())
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          return chatEventRowSchema.parse(JSON.parse(line));
        })
    : [];
  const tail = zip
    .getEntries()
    .filter((entry) => {
      return entry.entryName.startsWith(`chat-messages/${threadId}/tail/`);
    })
    .flatMap((entry) => {
      return readExportJsonLines(zip, entry.entryName).map((row) => {
        return chatEventRowSchema.parse(row);
      });
    })
    .filter((row) => {
      return row.seqId > coverage && row.seqId <= upperSeqId;
    });
  return [...archived, ...tail].sort((left, right) => {
    return left.seqId - right.seqId;
  });
}
