import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { RunnerWssClient } from "./runner-wss-client";
import {
  sandboxFsReadOpen,
  sandboxFsRead,
  sandboxFsReadFinish,
  sandboxFsReadClose,
} from "@okouai/api-contracts/contracts/sandbox-channel-fs";

const token = (name: string) => Buffer.from(name).toString("base64url");

/** Owned fixture bytes through real TLS/WSS and typed regular-file responses. */
export async function probeFileReads(client: RunnerWssClient, fixture: string) {
  const path = ["home", "user", fixture, "nested", "leaf"].map(token);
  const active = new Set<string>();
  const open = async (
    mode: "download" | "preview" | "prefix",
    selectedPath = path,
  ) => {
    const file = await client.fileCall(sandboxFsReadOpen, {
      path: selectedPath,
      mode,
    });
    active.add(file.handle);
    return file;
  };
  const release = async (handle: string, finish: boolean) => {
    await client.fileCall(finish ? sandboxFsReadFinish : sandboxFsReadClose, {
      handle,
    });
    active.delete(handle);
    await client.rejectFileRead(
      "read",
      { handle, offset: "0", length: 1 },
      "handle_expired",
    );
  };
  try {
    const full = await open("download");
    assert.equal(full.fileSize, "70003");
    assert.equal(full.selectedSize, full.fileSize);
    assert.equal(full.truncated, false);
    const chunks = await Promise.all(
      [32768, 0, 65536].map(async (offset) => {
        const result = await client.fileCall(sandboxFsRead, {
          handle: full.handle,
          offset: offset.toString(),
          length: 32768,
        });
        assert.equal(result.offset, offset.toString());
        const bytes = Buffer.from(result.data, "base64");
        const expected = Buffer.from(
          Uint8Array.from(
            { length: Math.min(32768, 70003 - offset) },
            (_, i) => (offset + i) % 256,
          ),
        );
        assert.equal(result.length, expected.length);
        assert.deepEqual(bytes, expected);
        return { offset, bytes };
      }),
    );
    const hash = createHash("sha256");
    for (const chunk of chunks.sort((a, b) => a.offset - b.offset))
      hash.update(chunk.bytes);
    const digest = hash.digest("hex");
    const expected = createHash("sha256")
      .update(Uint8Array.from({ length: 70003 }, (_, i) => i % 256))
      .digest("hex");
    assert.equal(digest, expected);
    await release(full.handle, true);
    const prefix = await open("prefix");
    assert.equal(prefix.selectedSize, "65536");
    assert.equal(prefix.truncated, true);
    const last = await client.fileCall(sandboxFsRead, {
      handle: prefix.handle,
      offset: "65535",
      length: 32768,
    });
    assert.equal(last.length, 1);
    assert.deepEqual(Buffer.from(last.data, "base64"), Buffer.from([255]));
    const independent = await open("download");
    assert.equal(independent.selectedSize, "70003");
    await release(independent.handle, false);
    await release(prefix.handle, false);
    const empty = await open(
      "preview",
      ["home", "user", fixture, ".hidden"].map(token),
    );
    assert.equal(empty.fileSize, "0");
    const eof = await client.fileCall(sandboxFsRead, {
      handle: empty.handle,
      offset: "0",
      length: 1,
    });
    assert.equal(eof.length, 0);
    assert.equal(eof.data, "");
    await release(empty.handle, true);
    await client.rejectFileRead(
      "open",
      {
        path: ["home", "user", fixture, "outside"].map(token),
        mode: "download",
      },
      "link_not_expandable",
    );
    await client.rejectFileRead(
      "open",
      {
        path: ["home", "user", fixture, "nested"].map(token),
        mode: "download",
      },
      "not_regular_file",
    );
    // Deliberately leave one reader to the same connection's teardown owner.
    await open("download");
    active.clear();
    return {
      fileReadBytes: 70003,
      fileReadSha256: digest,
      readerRelease: true,
      prefixPreviewBytes: 65536,
      readerAbandonedToConnection: true,
    };
  } finally {
    for (const handle of active)
      await client.fileCall(sandboxFsReadClose, { handle });
  }
}
