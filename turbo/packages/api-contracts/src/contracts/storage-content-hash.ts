import { createHash } from "node:crypto";

export interface FileEntryWithHash {
  readonly path: string;
  readonly hash: string;
  readonly size: number;
}

export function hashFileContent(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function computeContentHashFromHashes(
  storageId: string,
  files: readonly FileEntryWithHash[],
): string {
  if (files.length === 0) {
    return createHash("sha256").update(`storage:${storageId}\n`).digest("hex");
  }

  const entries = files
    .map((file) => {
      return `${file.path}:${file.hash}`;
    })
    .sort();

  return createHash("sha256")
    .update(`storage:${storageId}\n${entries.join("\n")}`)
    .digest("hex");
}
