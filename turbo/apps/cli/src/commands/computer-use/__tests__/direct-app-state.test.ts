import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, expect, it, vi } from "vitest";
import { frame } from "../../ssh/file-protocol";
import { readDirectAppState } from "../direct-app-state";

function wire(commandId: string, snapshotId: string, text: string) {
  const metadata = Buffer.from(
    JSON.stringify({
      commandId,
      result: { snapshotId, appState: text, windowId: 7 },
    }),
  );
  const png = Buffer.from("89504e470d0a1a0a010203", "hex");
  const body = Buffer.concat([frame(metadata), png]);
  const digest = createHash("sha256").update(body).digest();
  const header = frame(
    Buffer.from(
      JSON.stringify({
        type: "event",
        data: { bytes: body.length, sha256: digest.toString("hex") },
      }),
    ),
  );
  const data = frame(Buffer.concat([Buffer.from([0]), body]));
  const end = frame(Buffer.from([1]));
  const result = frame(Buffer.from('{"type":"result","data":true}'));
  return { png, digest, chunks: [header, data, end, result] };
}

async function* fragments(chunks: Buffer[]) {
  for (const chunk of chunks) {
    yield chunk.subarray(0, 2);
    yield chunk.subarray(2);
  }
}

async function destination() {
  const path = await mkdtemp(join(tmpdir(), "app-state-transfer-"));
  vi.stubEnv("OKOU_COMPUTER_OUTPUT_DIR", path);
  onTestFinished(async () => {
    vi.unstubAllEnvs();
    await rm(path, { recursive: true, force: true });
  });
  return path;
}

it("publishes both private files before acknowledging and handles an identical replay", async () => {
  await destination();
  const command = randomUUID();
  const snapshot = randomUUID();
  const text = "窗口\n".repeat(1024);
  const { chunks, png, digest } = wire(command, snapshot, text);
  const read = (frames: Buffer[]) => {
    return readDirectAppState(
      command,
      fragments(frames),
      (ack) => {
        return expect(ack).toEqual(digest);
      },
      new AbortController().signal,
    );
  };
  const output = await read(chunks);
  expect(output.windowId).toBe(7);
  expect(await readFile(output.appState, "utf8")).toBe(text);
  expect(await readFile(output.screenshot)).toEqual(png);
  const before = await stat(output.screenshot);
  expect(before.mode & 0o777).toBe(0o600);
  expect(await read(chunks)).toEqual(output);
  expect((await stat(output.screenshot)).ino).toBe(before.ino);
  await expect(read(wire(command, snapshot, "changed").chunks)).rejects.toThrow(
    "Conflicting",
  );
  expect(await readFile(output.appState, "utf8")).toBe(text);
});

it("drops incomplete, damaged and mismatched deliveries without acknowledging", async () => {
  const root = await destination();
  const command = randomUUID();
  const snapshot = randomUUID();
  const { chunks } = wire(command, snapshot, "one");
  const other = wire(command, snapshot, "two");
  const ack = vi.fn();
  for (const frames of [
    chunks.slice(0, 2),
    [chunks[0]!, other.chunks[1]!, ...chunks.slice(2)],
    wire(randomUUID(), snapshot, "one").chunks,
  ]) {
    await expect(
      readDirectAppState(
        command,
        fragments(frames),
        ack,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  }
  expect(await readdir(root)).toEqual([]);
  expect(ack).not.toHaveBeenCalled();
});
