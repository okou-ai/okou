import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { literal, number, object, string, uuid } from "zod";
import { frame } from "../ssh/file-protocol";
import { publishComputerUseAppState } from "./output-artifacts";

const maxBundleBytes = 32 * 1024 * 1024;
const pngHeader = Buffer.from("89504e470d0a1a0a", "hex");
const utf8 = new TextDecoder("utf-8", { fatal: true });
const eventSchema = object({
  type: literal("event"),
  data: object({
    bytes: number().int().positive().max(maxBundleBytes),
    sha256: string().regex(/^[0-9a-f]{64}$/),
  }),
});
const resultSchema = object({ type: literal("result"), data: literal(true) });
const envelopeSchema = object({
  commandId: uuid(),
  result: object({ snapshotId: uuid(), appState: string() }),
});

async function* rpcFrames(source: AsyncIterable<unknown>) {
  const header = Buffer.alloc(4);
  let buffer = header;
  let offset = 0;
  for await (const value of source) {
    if (!Buffer.isBuffer(value)) throw new Error("Invalid Runner RPC data");
    let chunk = value;
    while (chunk.length) {
      const count = Math.min(buffer.length - offset, chunk.length);
      chunk.copy(buffer, offset, 0, count);
      offset += count;
      chunk = chunk.subarray(count);
      if (offset !== buffer.length) continue;
      offset = 0;
      if (buffer === header) {
        const size = header.readUInt32BE();
        if (size === 0 || size > 65537)
          throw new Error("Invalid Runner RPC frame length");
        buffer = Buffer.allocUnsafe(size);
      } else {
        yield buffer;
        buffer = header;
      }
    }
  }
  if (offset || buffer !== header)
    throw new Error("Truncated Runner RPC frame");
}

async function publishVerifiedBundle(
  commandId: string,
  buffer: Buffer,
  sha256: string | undefined,
  signal: AbortSignal,
) {
  const digest = createHash("sha256").update(buffer).digest();
  if (digest.toString("hex") !== sha256)
    throw new Error("App state digest mismatch");
  const boundary = 4 + buffer.readUInt32BE(0);
  if (
    boundary + pngHeader.length > buffer.length ||
    !buffer.subarray(boundary, boundary + pngHeader.length).equals(pngHeader)
  )
    throw new Error("Invalid app state PNG");
  const { commandId: captured, result } = envelopeSchema.parse(
    JSON.parse(utf8.decode(buffer.subarray(4, boundary))),
  );
  if (captured !== commandId)
    throw new Error("App state belongs to a different command");
  const files = await publishComputerUseAppState(
    commandId,
    result.snapshotId,
    result.appState,
    buffer.subarray(boundary),
    signal,
  );
  return { files, digest };
}

export async function readDirectAppState(
  commandId: string,
  source: AsyncIterable<unknown>,
  acknowledge: (digest: Buffer) => void,
  signal: AbortSignal,
) {
  let buffer: Buffer | undefined;
  let sha256: string | undefined;
  let offset = 0;
  let terminal = false;
  let published:
    Awaited<ReturnType<typeof publishComputerUseAppState>> | undefined;
  for await (const payload of rpcFrames(source)) {
    signal.throwIfAborted();
    if (terminal) throw new Error("Data follows the Runner app state receipt");
    if (payload[0] === 0) {
      const length = payload.length - 1;
      if (!length || !buffer || published || length > buffer.length - offset)
        throw new Error("Invalid app state data frame");
      payload.copy(buffer, offset, 1);
      offset += length;
    } else if (payload[0] === 1) {
      if (
        payload.length !== 1 ||
        published ||
        !buffer ||
        offset !== buffer.length ||
        offset < 4
      )
        throw new Error("Incomplete app state delivery");
      const { files, digest } = await publishVerifiedBundle(
        commandId,
        buffer,
        sha256,
        signal,
      );
      published = files;
      signal.throwIfAborted();
      acknowledge(digest);
    } else {
      const control: unknown = JSON.parse(utf8.decode(payload));
      if (resultSchema.safeParse(control).success && published) {
        terminal = true;
        continue;
      }
      const event = eventSchema.safeParse(control);
      if (buffer || !event.success)
        throw new Error("Runner could not deliver the app state");
      sha256 = event.data.data.sha256;
      buffer = Buffer.allocUnsafe(event.data.data.bytes);
    }
  }
  if (!terminal || !published)
    throw new Error("Missing Runner app state receipt");
  return published;
}

export async function receiveDirectAppState(
  commandId: string,
  timeoutSeconds: number,
) {
  const signal = AbortSignal.timeout(timeoutSeconds * 1000);
  const child = spawn("/usr/local/bin/runner-rpc-client", ["--stream"], {
    stdio: ["pipe", "pipe", "ignore"],
    signal,
  });
  const closed = new Promise<number | null>((resolve) => {
    child.once("close", resolve);
    child.once("error", () => {
      return resolve(null);
    });
  });
  // A rejected receive can close its input before reporting the terminal.
  child.stdin.on("error", () => {
    return child.stdin.destroy();
  });
  try {
    child.stdin.write(
      frame(
        Buffer.from(
          JSON.stringify({
            version: 1,
            method: "computer.appState.receive",
            params: { commandId },
          }),
        ),
      ),
    );
    const result = await readDirectAppState(
      commandId,
      child.stdout,
      (digest) => {
        child.stdin.end(
          Buffer.concat([
            frame(Buffer.concat([Buffer.from([0]), digest])),
            frame(Buffer.from([1])),
          ]),
        );
      },
      signal,
    );
    if ((await closed) !== 0)
      throw new Error("Runner did not confirm the app state receipt");
    return result;
  } finally {
    child.kill("SIGKILL");
    child.stdin.destroy();
    await closed;
  }
}
