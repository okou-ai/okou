import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import AdmZip from "adm-zip";
import { onTestFinished } from "vitest";

import { tarArchive, tarEntry } from "../../test-fixtures/tar-archive";
import { USER_EXPORT_RESTORE_SCRIPT } from "../user-export-restore";

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function json(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

function event(seqId: number) {
  return {
    id: `event-${seqId}`,
    chatThreadId: "thread-a",
    seqId,
    eventType: "test-event",
    payload: { content: `message ${seqId}` },
    revokesEventId: seqId === 10 ? "event-5" : null,
  };
}

function jsonLines(values: readonly unknown[]): Buffer {
  return Buffer.from(
    values
      .map((value) => {
        return JSON.stringify(value);
      })
      .join("\n") + "\n",
  );
}

function sources(producer: "guest" | "server" = "guest") {
  const binary = Buffer.from([0x00, 0xff, 0x61, 0x80, 0xfe]);
  // Match the active guest ArtifactManifest and server volume manifest writers.
  const memoryManifest = {
    version: producer === "guest" ? 1 : "memory-version-a",
    createdAt: "2026-09-20T00:00:00Z",
    files: [{ path: "binary.dat", size: binary.length, hash: sha256(binary) }],
    ...(producer === "server"
      ? { fileCount: 1, totalSize: binary.length }
      : {}),
  };
  const files = new Map<string, Buffer>([
    ["README.md", Buffer.from("Export fixture")],
    ["restore.py", Buffer.from(USER_EXPORT_RESTORE_SCRIPT)],
    [
      "chat-threads/thread-a.json",
      json({
        id: "thread-a",
        title: "Pinned thread",
        pinnedAt: "2026-09-20T00:00:00Z",
      }),
    ],
    ["chat-threads/empty.json", json({ id: "empty", title: "Empty thread" })],
    [
      "chat-messages/thread-a/snapshots/old.ndjson.gz",
      gzipSync(jsonLines([event(1)])),
    ],
    [
      "chat-messages/thread-a/snapshots/current.ndjson.gz",
      gzipSync(jsonLines([event(3), event(5), event(8)])),
    ],
    [
      "chat-messages/thread-a/tail/0.jsonl",
      jsonLines([event(2), event(9), event(10), event(11)]),
    ],
    ["chat-messages/thread-a/tail/9.jsonl", jsonLines([event(10)])],
    [
      "agents/agent-a.json",
      json({ id: "agent-a", instructions: "Keep these instructions exactly." }),
    ],
    [
      "workflows/workflow-a.json",
      json({ id: "workflow-a", instruction: "Workflow instruction." }),
    ],
    [
      "memory/org-a/storage-a/archive.tar.gz",
      gzipSync(
        tarArchive([
          tarEntry({ path: "./binary.dat", type: "0", content: binary }),
        ]),
      ),
    ],
    ["memory/org-a/storage-a/manifest.json", json(memoryManifest)],
  ]);
  // Cross the manifest page boundary while keeping fixture content small.
  for (let index = 0; index < 100; index++) {
    files.set(
      `agents/extra-${index}.json`,
      json({ id: `extra-${index}`, instructions: null }),
    );
  }
  // The files manifest carries each entry's metadata, so the restore tool needs
  // no per-thread index file to find a thread's bound or its newest snapshot.
  const meta = new Map<string, Record<string, unknown>>([
    ["chat-threads/thread-a.json", { threadId: "thread-a", upperSeqId: 10 }],
    ["chat-threads/empty.json", { threadId: "empty", upperSeqId: 0 }],
    [
      "chat-messages/thread-a/snapshots/old.ndjson.gz",
      { threadId: "thread-a", lastSeqId: 1 },
    ],
    [
      "chat-messages/thread-a/snapshots/current.ndjson.gz",
      { threadId: "thread-a", lastSeqId: 8 },
    ],
  ]);
  return { files, meta, binary, memoryManifest };
}

function exportZip(
  files: ReadonlyMap<string, Buffer>,
  meta: ReadonlyMap<string, Record<string, unknown>> = new Map(),
): AdmZip {
  const zip = new AdmZip();
  const rows = [...files].map(([path, bytes]) => {
    return {
      path,
      size: bytes.length,
      sha256: sha256(bytes),
      ...meta.get(path),
    };
  });
  for (const [path, bytes] of files) {
    zip.addFile(path, bytes);
  }
  const pageHash = createHash("sha256");
  for (let start = 0; start < rows.length; start += 100) {
    const page = jsonLines(rows.slice(start, start + 100));
    pageHash.update(page);
    zip.addFile(`manifest/files-${start}.jsonl`, page);
  }
  zip.addFile(
    "export-manifest.json",
    json({
      formatVersion: 4,
      chatEventSchemaVersion: 7,
      filesManifest: {
        pageCount: Math.ceil(rows.length / 100),
        pageSize: 100,
        pathPattern: "manifest/files-{pageStart}.jsonl",
        algorithm: "sha256-concatenated-pages",
        sha256: pageHash.digest("hex"),
      },
    }),
  );
  return zip;
}

async function runRestore(zip: AdmZip) {
  const directory = await mkdtemp(join(tmpdir(), "okou-export-restore-"));
  onTestFinished(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const script = join(directory, "restore.py");
  const archive = join(directory, "export.zip");
  const output = join(directory, "restored");
  for (const entry of zip.getEntries()) {
    entry.header.method = 0;
  }
  await writeFile(script, USER_EXPORT_RESTORE_SCRIPT);
  await writeFile(archive, zip.toBuffer());
  const result = spawnSync("python3", [script, archive, output], {
    encoding: "utf8",
  });
  return { result, output };
}

describe("downloaded export recovery tool", () => {
  it.each(["guest", "server"] as const)(
    "restores verified paged sources, current chat events, instructions and %s binary memory",
    async (producer) => {
      const fixture = sources(producer);
      const { result, output } = await runRestore(
        exportZip(fixture.files, fixture.meta),
      );
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      await expect(
        readFile(join(output, "chat-messages/thread-a.jsonl"), "utf8"),
      ).resolves.toBe(
        jsonLines([event(3), event(5), event(8), event(9), event(10)]).toString(
          "utf8",
        ),
      );
      await expect(
        readFile(join(output, "chat-messages/empty.jsonl"), "utf8"),
      ).resolves.toBe("");
      await expect(
        readFile(join(output, "memory/org-a/binary.dat")),
      ).resolves.toStrictEqual(fixture.binary);
      await expect(
        readFile(join(output, "agents.jsonl"), "utf8"),
      ).resolves.toContain("Keep these instructions exactly.");
      await expect(
        readFile(join(output, "workflows.jsonl"), "utf8"),
      ).resolves.toContain("Workflow instruction.");
      await expect(
        readFile(join(output, "chat-threads.jsonl"), "utf8"),
      ).resolves.toContain("Pinned thread");
    },
  );

  it.each(["fileCount", "totalSize"] as const)(
    "rejects a supplied memory %s that disagrees with the file inventory",
    async (field) => {
      const fixture = sources("server");
      fixture.files.set(
        "memory/org-a/storage-a/manifest.json",
        json({
          ...fixture.memoryManifest,
          [field]: field === "fileCount" ? 2 : fixture.binary.length + 1,
        }),
      );
      const { result, output } = await runRestore(
        exportZip(fixture.files, fixture.meta),
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Memory manifest totals do not match its files",
      );
      await expect(
        readFile(join(output, "chat-threads.jsonl")),
      ).rejects.toThrow("ENOENT");
    },
  );

  it("rejects changed source bytes even when their ZIP CRC is internally valid", async () => {
    const zip = exportZip(sources().files, sources().meta);
    zip.updateFile(
      "agents/agent-a.json",
      Buffer.from(
        zip.readAsText("agents/agent-a.json").replace("Keep", "Xeep"),
      ),
    );
    const { result, output } = await runRestore(zip);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SHA-256 mismatch");
    await expect(readFile(join(output, "agents.jsonl"))).rejects.toThrow(
      "ENOENT",
    );
  });

  it("verifies the concatenated manifest page digest before trusting its file checksums", async () => {
    const zip = exportZip(sources().files, sources().meta);
    const original = zip.readAsText("manifest/files-100.jsonl");
    // Rename whichever padding entry leads this page, so the tamper does not
    // depend on how many real fixture entries precede the page boundary.
    zip.updateFile(
      "manifest/files-100.jsonl",
      Buffer.from(original.replace("agents/extra-", "agents/other-")),
    );
    const { result } = await runRestore(zip);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Manifest page SHA-256 mismatch");
  });

  it("refuses memory archive links without creating output files", async () => {
    const { files, meta } = sources();
    files.set(
      "memory/org-a/storage-a/archive.tar.gz",
      gzipSync(
        tarArchive([
          tarEntry({ path: "link", type: "2", linkname: "../../outside" }),
        ]),
      ),
    );
    files.set(
      "memory/org-a/storage-a/manifest.json",
      json({ version: "1", fileCount: 0, totalSize: 0, files: [] }),
    );
    const { result, output } = await runRestore(exportZip(files, meta));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("link or special file");
    await expect(readFile(join(output, "chat-threads.jsonl"))).rejects.toThrow(
      "ENOENT",
    );
  });
  it("refuses a memory manifest path that escapes the restored directory", async () => {
    const { files, meta, binary } = sources();
    files.set(
      "memory/org-a/storage-a/manifest.json",
      json({
        version: "1",
        fileCount: 1,
        totalSize: binary.length,
        files: [
          { path: "../outside", size: binary.length, hash: sha256(binary) },
        ],
      }),
    );
    const { result, output } = await runRestore(exportZip(files, meta));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unsafe archive path");
    await expect(readFile(join(output, "chat-threads.jsonl"))).rejects.toThrow(
      "ENOENT",
    );
  });

  it("refuses ZIP link metadata before processing its contents", async () => {
    const zip = exportZip(sources().files, sources().meta);
    const entry = zip.getEntry("agents/agent-a.json");
    if (entry === null) {
      throw new Error("Expected agent fixture entry");
    }
    entry.attr = 0o12_0777 * 65_536;
    const { result } = await runRestore(zip);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ZIP contains a link");
  });
});
