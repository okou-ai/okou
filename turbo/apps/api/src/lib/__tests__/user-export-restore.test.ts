import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, gzipSync } from "node:zlib";
import { describe, expect, it, onTestFinished } from "vitest";

import { USER_EXPORT_RESTORE_SCRIPT } from "../user-export-restore";

interface ArchiveEntry {
  readonly path: string;
  readonly bytes: Buffer;
  readonly metadata?: Record<string, unknown>;
  readonly overrideManifestBytes?: Buffer;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function buildStoredZip(
  entries: readonly { readonly name: string; readonly data: Buffer }[],
): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const checksum = crc32(entry.data) >>> 0;
    const size = entry.data.byteLength;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04_03_4b_50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x08_00, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(size, 18);
    localHeader.writeUInt32LE(size, 22);
    localHeader.writeUInt16LE(nameBytes.byteLength, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBytes, entry.data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02_01_4b_50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x08_00, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(size, 20);
    centralHeader.writeUInt32LE(size, 24);
    centralHeader.writeUInt16LE(nameBytes.byteLength, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE((0o10_0644 << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBytes);
    offset += localHeader.byteLength + nameBytes.byteLength + size;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06_05_4b_50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirectory.byteLength, 12);
  endRecord.writeUInt32LE(offset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, endRecord]);
}

function buildTarGz(
  files: readonly { readonly name: string; readonly data: Buffer }[],
): Buffer {
  const blocks: Buffer[] = [];
  for (const file of files) {
    const header = Buffer.alloc(512, 0);
    header.write(file.name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(
      `${file.data.byteLength.toString(8).padStart(11, "0")}\0`,
      124,
      12,
      "ascii",
    );
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header.write("0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");

    let checksum = 0;
    for (const byte of header) {
      checksum += byte;
    }
    header.write(
      `${checksum.toString(8).padStart(6, "0")}\0 `,
      148,
      8,
      "ascii",
    );

    blocks.push(header, file.data);
    const remainder = file.data.byteLength % 512;
    if (remainder !== 0) {
      blocks.push(Buffer.alloc(512 - remainder, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(blocks));
}

function buildExportArchive(sourceEntries: readonly ArchiveEntry[]): Buffer {
  const manifestLines = sourceEntries.map((entry) => {
    const hashed = entry.overrideManifestBytes ?? entry.bytes;
    return JSON.stringify({
      path: entry.path,
      size: hashed.byteLength,
      sha256: sha256Hex(hashed),
      ...entry.metadata,
    });
  });

  const pageSize = 100;
  const pageCount = Math.ceil(manifestLines.length / pageSize);
  const pageEntries: { readonly name: string; readonly data: Buffer }[] = [];
  const aggregate = createHash("sha256");

  for (let page = 0; page < pageCount; page += 1) {
    const slice = manifestLines.slice(page * pageSize, (page + 1) * pageSize);
    const data = Buffer.from(`${slice.join("\n")}\n`, "utf8");
    aggregate.update(data);
    pageEntries.push({
      name: `manifest/files-${String(page * pageSize)}.jsonl`,
      data,
    });
  }

  const rootManifest = Buffer.from(
    JSON.stringify({
      version: 3,
      filesManifest: {
        pageSize,
        pageCount,
        pathPattern: "manifest/files-{pageStart}.jsonl",
        algorithm: "sha256-concatenated-pages",
        sha256: aggregate.digest("hex"),
      },
    }),
    "utf8",
  );

  return buildStoredZip([
    { name: "export-manifest.json", data: rootManifest },
    ...pageEntries,
    ...sourceEntries.map((entry) => {
      return { name: entry.path, data: entry.bytes };
    }),
  ]);
}

function chatEvent(threadId: string, seqId: number): Record<string, unknown> {
  return {
    id: `evt_${threadId}_${String(seqId)}`,
    chatThreadId: threadId,
    seqId,
    eventType: "output.message",
    payload: { content: `Message ${String(seqId)}` },
  };
}

function jsonlBuffer(records: readonly Record<string, unknown>[]): Buffer {
  return Buffer.from(
    `${records
      .map((record) => {
        return JSON.stringify(record);
      })
      .join("\n")}\n`,
    "utf8",
  );
}

function runRecoveryCli(zipBytes: Buffer): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputDir: string;
} {
  const workDir = mkdtempSync(join(tmpdir(), "okou-export-restore-"));
  onTestFinished(() => {
    rmSync(workDir, { recursive: true, force: true });
  });
  const scriptPath = join(workDir, "restore.py");
  const archivePath = join(workDir, "export.zip");
  const outputDir = join(workDir, "restored");
  writeFileSync(scriptPath, USER_EXPORT_RESTORE_SCRIPT, "utf8");
  writeFileSync(archivePath, zipBytes);

  const result = spawnSync("python3", [scriptPath, archivePath, outputDir], {
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    outputDir,
  };
}

describe("downloaded export recovery tool", () => {
  it("user-export-restore-001 restores verified paged sources, current chat events, instructions and guest binary memory", () => {
    const activeThreadId = "thread-active";
    const emptyThreadId = "thread-empty";
    const binaryPayload = Buffer.from([
      0x00, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x42,
    ]);
    const memoryTarGz = buildTarGz([
      { name: "./bin/sample.bin", data: binaryPayload },
    ]);
    const memoryManifestBytes = Buffer.from(
      JSON.stringify({
        version: 1,
        createdAt: "2026-09-09T12:00:00.000Z",
        files: [
          {
            path: "./bin/sample.bin",
            size: binaryPayload.byteLength,
            hash: sha256Hex(binaryPayload),
          },
        ],
      }),
      "utf8",
    );

    const fillerWorkflows: ArchiveEntry[] = Array.from(
      { length: 95 },
      (_, index) => {
        const id = `wf-pad-${String(index).padStart(3, "0")}`;
        return {
          path: `workflows/${id}.json`,
          bytes: Buffer.from(
            JSON.stringify({
              id,
              name: id,
              instruction: `Pad ${String(index)}`,
            }),
            "utf8",
          ),
        };
      },
    );

    const archive = buildExportArchive([
      {
        path: `chat-threads/${activeThreadId}.json`,
        bytes: Buffer.from(
          JSON.stringify({
            id: activeThreadId,
            title: "Pinned release thread",
            pinnedAt: "2026-09-09T10:00:00.000Z",
          }),
          "utf8",
        ),
        metadata: { threadId: activeThreadId, upperSeqId: 10 },
      },
      {
        path: `chat-messages/${activeThreadId}/snapshots/snap-0008.jsonl.gz`,
        bytes: gzipSync(
          jsonlBuffer([
            chatEvent(activeThreadId, 3),
            chatEvent(activeThreadId, 5),
            chatEvent(activeThreadId, 8),
          ]),
        ),
        metadata: { lastSeqId: 8 },
      },
      {
        path: `chat-messages/${activeThreadId}/tail/part-0001.jsonl`,
        bytes: jsonlBuffer([
          chatEvent(activeThreadId, 8),
          chatEvent(activeThreadId, 9),
          chatEvent(activeThreadId, 10),
          chatEvent(activeThreadId, 11),
        ]),
      },
      {
        path: `chat-threads/${emptyThreadId}.json`,
        bytes: Buffer.from(
          JSON.stringify({
            id: emptyThreadId,
            title: "Empty thread",
            pinnedAt: null,
          }),
          "utf8",
        ),
        metadata: { threadId: emptyThreadId, upperSeqId: 0 },
      },
      {
        path: "instructions/personal-1.json",
        bytes: Buffer.from(
          JSON.stringify({
            id: "personal-1",
            content: "Always summarize diffs concisely.",
          }),
          "utf8",
        ),
      },
      {
        path: "workflows/wf-primary.json",
        bytes: Buffer.from(
          JSON.stringify({
            id: "wf-primary",
            name: "release-checklist",
            instruction: "Run smoke checks before publishing.",
          }),
          "utf8",
        ),
      },
      ...fillerWorkflows,
      {
        path: "memory/org_alpha/snap_guest/manifest.json",
        bytes: memoryManifestBytes,
      },
      {
        path: "memory/org_alpha/snap_guest/archive.tar.gz",
        bytes: memoryTarGz,
      },
    ]);

    const result = runRecoveryCli(archive);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");

    const restoredEvents = readFileSync(
      join(result.outputDir, "chat-messages", `${activeThreadId}.jsonl`),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => {
        return (JSON.parse(line) as { readonly seqId: number }).seqId;
      });
    expect(restoredEvents).toStrictEqual([3, 5, 8, 9, 10]);

    expect(
      readFileSync(
        join(result.outputDir, "chat-messages", `${emptyThreadId}.jsonl`),
        "utf8",
      ),
    ).toBe("");

    expect(
      readFileSync(
        join(result.outputDir, "memory", "org_alpha", "bin", "sample.bin"),
      ),
    ).toStrictEqual(binaryPayload);

    expect(
      readFileSync(join(result.outputDir, "instructions.jsonl"), "utf8"),
    ).toContain("Always summarize diffs concisely.");
    expect(
      readFileSync(join(result.outputDir, "workflows.jsonl"), "utf8"),
    ).toContain("Run smoke checks before publishing.");
    expect(
      readFileSync(join(result.outputDir, "chat-threads.jsonl"), "utf8"),
    ).toContain('"pinnedAt":"2026-09-09T10:00:00.000Z"');
  });

  it("user-export-restore-005 raises the thread bound to a snapshot that overtook it mid-export", () => {
    const threadId = "thread-overtake";
    const archive = buildExportArchive([
      {
        path: `chat-threads/${threadId}.json`,
        bytes: Buffer.from(
          JSON.stringify({ id: threadId, title: "Overtaken thread" }),
          "utf8",
        ),
        metadata: { threadId, upperSeqId: 10 },
      },
      {
        path: `chat-messages/${threadId}/snapshots/snap-0012.jsonl.gz`,
        bytes: gzipSync(
          jsonlBuffer([
            chatEvent(threadId, 3),
            chatEvent(threadId, 5),
            chatEvent(threadId, 8),
            chatEvent(threadId, 9),
            chatEvent(threadId, 12),
          ]),
        ),
        metadata: { lastSeqId: 12 },
      },
      {
        path: `chat-messages/${threadId}/tail/part-0001.jsonl`,
        bytes: jsonlBuffer([
          chatEvent(threadId, 9),
          chatEvent(threadId, 10),
          chatEvent(threadId, 11),
        ]),
      },
    ]);

    const result = runRecoveryCli(archive);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");

    const restoredEvents = readFileSync(
      join(result.outputDir, "chat-messages", `${threadId}.jsonl`),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => {
        return (JSON.parse(line) as { readonly seqId: number }).seqId;
      });
    expect(restoredEvents).toStrictEqual([3, 5, 8, 9, 12]);
  });

  it("user-export-restore-006 rejects changed source bytes even when their ZIP CRC is internally valid", () => {
    const originalWorkflow = Buffer.from(
      JSON.stringify({
        id: "wf-tampered",
        name: "billing",
        instruction: "Original instruction.",
      }),
      "utf8",
    );
    const modifiedWorkflow = Buffer.from(
      JSON.stringify({
        id: "wf-tampered",
        name: "billing",
        instruction: "Tampered instruction.",
      }),
      "utf8",
    );
    const archive = buildExportArchive([
      {
        path: "workflows/wf-tampered.json",
        bytes: modifiedWorkflow,
        overrideManifestBytes: originalWorkflow,
      },
    ]);

    const result = runRecoveryCli(archive);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SHA-256 mismatch");
    expect(existsSync(join(result.outputDir, "workflows.jsonl"))).toBeFalsy();
  });

  it("user-export-restore-009 refuses a memory manifest path that escapes the restored directory", () => {
    const threadId = "thread-before-escape";
    const escapingBytes = Buffer.from("escaped", "utf8");
    const archive = buildExportArchive([
      {
        path: `chat-threads/${threadId}.json`,
        bytes: Buffer.from(
          JSON.stringify({ id: threadId, title: "Should not commit" }),
          "utf8",
        ),
        metadata: { threadId, upperSeqId: 0 },
      },
      {
        path: "memory/org_alpha/snap_bad/manifest.json",
        bytes: Buffer.from(
          JSON.stringify({
            version: 1,
            createdAt: "2026-09-09T12:00:00.000Z",
            files: [
              {
                path: "../outside.txt",
                size: escapingBytes.byteLength,
                hash: sha256Hex(escapingBytes),
              },
            ],
          }),
          "utf8",
        ),
      },
      {
        path: "memory/org_alpha/snap_bad/archive.tar.gz",
        bytes: buildTarGz([{ name: "benign.txt", data: escapingBytes }]),
      },
    ]);

    const result = runRecoveryCli(archive);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unsafe archive path");
    expect(
      existsSync(join(result.outputDir, "chat-threads.jsonl")),
    ).toBeFalsy();
  });
});
