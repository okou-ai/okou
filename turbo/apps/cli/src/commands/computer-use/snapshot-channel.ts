import { createDecipheriv, createHash } from "node:crypto";
import { createConnection } from "node:net";
import { number, object, string, uuid } from "zod";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024 + 28;
const frameHeader = object({
  commandId: uuid(),
  snapshotId: uuid(),
  bytes: number().int().min(29).max(MAX_SNAPSHOT_BYTES),
  senderCandidate: string().optional(),
});
export type SnapshotRoute = "direct" | "turn" | "unknown";

export function isSnapshotId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function snapshotSocket(session: string): string {
  // The Linux abstract socket disappears with its owning process.
  return (
    "\0okou-snapshots-" + createHash("sha256").update(session).digest("hex")
  );
}

export function requestSnapshotWorker(
  session: string,
  request: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(snapshotSocket(session));
    const parts: Buffer[] = [];
    let length = 0;
    const timer = setTimeout(() => {
      return socket.destroy(new Error("Snapshot worker unavailable"));
    }, 80);
    socket.once("connect", () => {
      return socket.write(request + "\n");
    });
    socket.on("data", (part: Buffer) => {
      length += part.length;
      if (length > MAX_SNAPSHOT_BYTES + 1) {
        socket.destroy(new Error("Oversized snapshot packet"));
        return;
      }
      parts.push(part);
    });
    socket.once("error", reject);
    socket.once("end", () => {
      return resolve(Buffer.concat(parts, length));
    });
    socket.once("close", () => {
      return clearTimeout(timer);
    });
  });
}

export function verifiedSnapshot(
  packet: Buffer,
  commandId: string,
  snapshotId: unknown,
  encodedKey: unknown,
  sha256: unknown,
): { buffer: Buffer; mimeType: string; route: SnapshotRoute } | null {
  if (
    !isSnapshotId(commandId) ||
    !isSnapshotId(snapshotId) ||
    typeof encodedKey !== "string" ||
    !/^[A-Za-z0-9+/]{43}=$/.test(encodedKey) ||
    typeof sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(sha256) ||
    packet.length <= 29 ||
    packet.length > MAX_SNAPSHOT_BYTES + 1
  )
    return null;
  const route = (["unknown", "direct", "turn"] as const)[packet[0] ?? -1];
  if (!route) return null;
  try {
    const cipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(encodedKey, "base64"),
      packet.subarray(1, 13),
      { authTagLength: 16 },
    );
    cipher.setAAD(Buffer.from(commandId + "/" + snapshotId));
    cipher.setAuthTag(packet.subarray(-16));
    const buffer = Buffer.concat([
      cipher.update(packet.subarray(13, -16)),
      cipher.final(),
    ]);
    if (createHash("sha256").update(buffer).digest("hex") !== sha256)
      return null;
    return { buffer, mimeType: "image/png", route };
  } catch {
    return null;
  }
}

// One ordered channel carries a header followed by exactly that many ciphertext
// bytes. Unsolicited command IDs, partial frames and oversize messages are dropped.
export class SnapshotInbox {
  private readonly expected = new Map<
    string,
    { snapshotId?: string; packet?: Buffer }
  >();
  private frame?: {
    commandId: string;
    snapshotId: string;
    packet: Buffer;
    offset: number;
  };

  watch(commandId: string): void {
    if (!isSnapshotId(commandId) || this.expected.has(commandId)) return;
    if (this.expected.size >= 4) {
      const oldest = this.expected.keys().next().value;
      if (oldest) this.expected.delete(oldest);
    }
    this.expected.set(commandId, {});
  }

  receive(message: string | Buffer, route: SnapshotRoute): void {
    if (typeof message === "string") {
      this.frame = undefined;
      if (message.length > 256) return;
      let value: unknown;
      try {
        value = JSON.parse(message);
      } catch {
        return;
      }
      const parsed = frameHeader.safeParse(value);
      if (!parsed.success || !this.expected.has(parsed.data.commandId)) return;
      const header = parsed.data;
      const packet = Buffer.alloc(header.bytes + 1);
      const senderCandidate = header.senderCandidate;
      // A TURN address learned peer-reflexively can look direct to the receiver.
      if (senderCandidate === "relay" || route === "turn") packet[0] = 2;
      else if (
        route === "direct" ||
        senderCandidate === "host" ||
        senderCandidate === "srflx" ||
        senderCandidate === "prflx"
      )
        packet[0] = 1;
      this.frame = {
        commandId: header.commandId,
        snapshotId: header.snapshotId,
        packet,
        offset: 1,
      };
      return;
    }
    const frame = this.frame;
    if (!frame) return;
    if (
      !message.length ||
      message.length > 16384 ||
      frame.offset + message.length > frame.packet.length
    ) {
      this.frame = undefined;
      return;
    }
    frame.offset += message.copy(frame.packet, frame.offset);
    if (frame.offset === frame.packet.length) {
      if (this.expected.has(frame.commandId))
        this.expected.set(frame.commandId, frame);
      this.frame = undefined;
    }
  }

  take(commandId: string, snapshotId: string): Buffer | undefined {
    const current = this.expected.get(commandId);
    this.expected.delete(commandId);
    return current?.snapshotId === snapshotId ? current.packet : undefined;
  }
}
