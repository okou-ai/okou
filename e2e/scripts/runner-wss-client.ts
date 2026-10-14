import { WebSocket, type RawData } from "ws";
import type { WssTicket } from "./runner-wss-api";

export const FRAME_SIZES = [0, 1, 17, 1024, 65536, 37] as const;

export class RunnerWssClient {
  private readonly sockets = new Set<WebSocket>();
  private primary: WebSocket | undefined;
  private admitted = false;
  private closing = false;
  private failure: Error | undefined;
  private admission:
    { resolve(): void; reject(error: Error): void } | undefined;
  private echoPending:
    | {
        frames: readonly Buffer[];
        received: number;
        resolve(): void;
        reject(error: Error): void;
      }
    | undefined;

  constructor(
    private readonly runId: string,
    private readonly ticket: WssTicket,
    private readonly signal: AbortSignal = new AbortController().signal,
    private readonly ca?: Buffer,
  ) {
    if (new URL(ticket.wssUrl).protocol !== "wss:")
      throw new Error("Secure WSS target required");
    this.signal.addEventListener("abort", this.abort, { once: true });
  }

  private readonly abort = () => {
    this.fail("WSS lifetime ended");
    for (const socket of this.sockets) socket.terminate();
  };

  private socket(): WebSocket {
    this.signal.throwIfAborted();
    const socket = new WebSocket(this.ticket.wssUrl, {
      rejectUnauthorized: true,
      ...(this.ca ? { ca: this.ca } : {}),
      handshakeTimeout: 15_000,
      maxPayload: 65_536,
      perMessageDeflate: false,
    });
    this.sockets.add(socket);
    // Every owned socket has an error observer, including rejected replay streams.
    socket.on("error", () => {});
    socket.once("close", () => this.sockets.delete(socket));
    return socket;
  }

  private fail(message: string): void {
    this.failure ??= new Error(message);
    this.admission?.reject(this.failure);
    this.echoPending?.reject(this.failure);
  }

  assertHealthy(): void {
    if (this.failure) throw this.failure;
    if (!this.admitted || this.primary?.readyState !== WebSocket.OPEN)
      throw new Error("Admitted WSS connection unavailable");
  }

  async connect(): Promise<void> {
    if (this.primary || this.closing)
      throw new Error("WSS client already used");
    const socket = this.socket();
    this.primary = socket;
    let sent = false;
    socket.on("error", () => this.fail("WSS connection failed"));
    socket.on("close", () => {
      if (!this.closing) this.fail("WSS connection closed unexpectedly");
    });
    socket.on("message", (data: RawData, binary: boolean) => {
      if (!this.admitted) {
        if (!sent || !isAuthOk(data, binary)) {
          this.fail("WSS admission did not acknowledge the ticket");
          return;
        }
        this.admitted = true;
        this.admission?.resolve();
        return;
      }
      const pending = this.echoPending;
      const expected = pending?.frames[pending.received];
      if (!binary || !pending || !expected || !bytes(data).equals(expected)) {
        this.fail("Opaque Guest echo mismatch");
        return;
      }
      pending.received += 1;
      if (pending.received === pending.frames.length) {
        this.echoPending = undefined;
        pending.resolve();
      }
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        this.admission = { resolve, reject };
        timer = setTimeout(
          () => this.fail("WSS admission deadline exceeded"),
          15_000,
        );
        socket.once("open", () => {
          if (
            this.signal.aborted ||
            Date.now() >= Date.parse(this.ticket.expiresAt)
          ) {
            this.fail("WSS ticket expired before admission");
            return;
          }
          socket.send(
            JSON.stringify({ runId: this.runId, ticket: this.ticket.ticket }),
          );
          sent = true;
        });
      });
      this.assertHealthy();
    } finally {
      clearTimeout(timer);
      this.admission = undefined;
    }
  }

  async echo(): Promise<void> {
    this.assertHealthy();
    if (this.echoPending) throw new Error("Guest echo already pending");
    const frames = FRAME_SIZES.map((size, frameIndex) =>
      Buffer.from(
        Uint8Array.from(
          { length: size },
          (_, index) => (index * 31 + frameIndex * 17) % 256,
        ),
      ),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        this.echoPending = { frames, received: 0, resolve, reject };
        timer = setTimeout(
          () => this.fail("Guest echo deadline exceeded"),
          10_000,
        );
        for (const frame of frames) this.primary?.send(frame, { binary: true });
      });
      this.assertHealthy();
    } finally {
      clearTimeout(timer);
      this.echoPending = undefined;
    }
  }

  async rejectReplay(): Promise<void> {
    this.assertHealthy();
    const expires = Date.parse(this.ticket.expiresAt);
    if (expires - Date.now() <= 5_000)
      throw new Error("Ticket replay window unavailable");
    const socket = this.socket();
    let opened = false;
    let sent = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => socket.terminate();
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Replay rejection deadline exceeded")),
          5_000,
        );
        this.signal.addEventListener("abort", abort, { once: true });
        socket.once("open", () => {
          opened = true;
          if (this.signal.aborted || Date.now() >= expires) {
            reject(new Error("Ticket expired before replay"));
            return;
          }
          socket.send(
            JSON.stringify({ runId: this.runId, ticket: this.ticket.ticket }),
          );
          sent = true;
        });
        socket.on("message", (data: RawData, binary: boolean) =>
          reject(
            new Error(
              isAuthOk(data, binary)
                ? "Replayed ticket was admitted"
                : "Unexpected replay response",
            ),
          ),
        );
        socket.once("close", () => {
          if (opened && sent && Date.now() < expires && !this.signal.aborted)
            resolve();
          else reject(new Error("Ticket replay did not prove rejection"));
        });
      });
      this.assertHealthy();
    } finally {
      clearTimeout(timer);
      this.signal.removeEventListener("abort", abort);
      await closeSocket(socket);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    this.signal.removeEventListener("abort", this.abort);
    this.admission?.reject(new Error("WSS client closed"));
    this.echoPending?.reject(new Error("WSS client closed"));
    await Promise.all([...this.sockets].map(closeSocket));
  }
}

function bytes(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
}

function isAuthOk(data: RawData, binary: boolean): boolean {
  if (binary) return false;
  try {
    const value: unknown = JSON.parse(bytes(data).toString());
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "auth.ok"
    );
  } catch {
    return false;
  }
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = new Promise<void>((resolve, reject) => {
    socket.once("close", () => resolve());
    timer = setTimeout(
      () => reject(new Error("WSS cleanup deadline exceeded")),
      5_000,
    );
  });
  socket.terminate();
  try {
    await closed;
  } finally {
    clearTimeout(timer);
  }
}
