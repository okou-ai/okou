import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_SNAPSHOT_BYTES,
  SnapshotInbox,
  verifiedSnapshot,
} from "../snapshot-channel";

function capture() {
  const commandId = randomUUID();
  const snapshotId = randomUUID();
  const png = randomBytes(35_000);
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(commandId + "/" + snapshotId));
  const bytes = Buffer.concat([
    nonce,
    cipher.update(png),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = JSON.stringify({
    commandId,
    snapshotId,
    bytes: bytes.length,
    senderCandidate: "relay",
  });
  return {
    commandId,
    snapshotId,
    bytes,
    header,
    png,
    key: key.toString("base64"),
    sha: createHash("sha256").update(png).digest("hex"),
  };
}

describe("snapshot data channel", () => {
  it("assembles one expected ordered capture and requires its authoritative key, IDs and hash", () => {
    const inbox = new SnapshotInbox();
    const c = capture();
    inbox.watch(c.commandId);
    inbox.receive(c.header, "unknown");
    for (let offset = 0; offset < c.bytes.length; offset += 16384) {
      inbox.receive(c.bytes.subarray(offset, offset + 16384), "unknown");
    }
    const packet = inbox.take(c.commandId, c.snapshotId);
    if (!packet) throw new Error("Missing complete capture");
    const read = (
      commandId: string,
      snap: string,
      key: string,
      sha: string,
    ) => {
      return verifiedSnapshot(packet, commandId, snap, key, sha);
    };
    expect(read(c.commandId, c.snapshotId, c.key, c.sha)).toEqual({
      buffer: c.png,
      mimeType: "image/png",
      route: "turn",
    });
    expect(read(randomUUID(), c.snapshotId, c.key, c.sha)).toBeNull();
    expect(read(c.commandId, randomUUID(), c.key, c.sha)).toBeNull();
    expect(
      read(
        c.commandId,
        c.snapshotId,
        randomBytes(32).toString("base64"),
        c.sha,
      ),
    ).toBeNull();
    expect(read(c.commandId, c.snapshotId, c.key, "0".repeat(64))).toBeNull();
    packet[13] = (packet[13] ?? 0) ^ 1;
    expect(read(c.commandId, c.snapshotId, c.key, c.sha)).toBeNull();
    expect(inbox.take(c.commandId, c.snapshotId)).toBeUndefined();
  });

  it("drops unsolicited, partial, oversized and evicted frames", () => {
    const inbox = new SnapshotInbox();
    const c = capture();
    inbox.receive(c.header, "direct");
    inbox.watch(c.commandId);
    inbox.receive(c.bytes.subarray(0, 16384), "direct");
    expect(inbox.take(c.commandId, c.snapshotId)).toBeUndefined();
    inbox.watch(c.commandId);
    inbox.receive(c.header, "direct");
    inbox.receive(c.bytes.subarray(0, 8), "direct");
    expect(inbox.take(c.commandId, c.snapshotId)).toBeUndefined();
    inbox.watch(c.commandId);
    inbox.receive(
      JSON.stringify({
        commandId: c.commandId,
        snapshotId: c.snapshotId,
        bytes: MAX_SNAPSHOT_BYTES + 1,
      }),
      "direct",
    );
    inbox.receive(c.bytes, "direct");
    expect(inbox.take(c.commandId, c.snapshotId)).toBeUndefined();
    inbox.watch(c.commandId);
    inbox.receive(c.header, "direct");
    for (let i = 0; i < 4; i++) inbox.watch(randomUUID());
    for (let offset = 0; offset < c.bytes.length; offset += 16384)
      inbox.receive(c.bytes.subarray(offset, offset + 16384), "direct");
    expect(inbox.take(c.commandId, c.snapshotId)).toBeUndefined();
  });
});
