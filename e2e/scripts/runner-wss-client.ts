import { randomUUID } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import {
  SANDBOX_CHANNEL_LIMITS as limits,
  decodeSandboxChannelFrame,
  encodeSandboxChannelFrame,
  sandboxChannelHelloResultSchema,
  type SandboxChannelMessage,
  type SandboxChannelPayloadSchema,
} from "@okouai/api-contracts/contracts/sandbox-channel";
import {
  sandboxDiagnosticsEchoSchema,
  sandboxDiagnosticsNoticeSchema,
} from "@okouai/api-contracts/contracts/sandbox-channel-diagnostics";
import type { WssTicket } from "./runner-wss-api";
import {
  SANDBOX_FS_VERSION,
  sandboxFsListParamsSchema,
  sandboxFsListResultSchema,
  sandboxFsListCloseParamsSchema,
  sandboxFsListCloseResultSchema,
} from "@okouai/api-contracts/contracts/sandbox-channel-fs";

export const ECHO_SIZES = [0, 1, 17, 1024, 16384, 37] as const;
type Pending = { complete(value: unknown): void; reject(error: Error): void };

class SandboxRequestError extends Error {
  constructor(readonly code: string) {
    super(`Sandbox request failed: ${code}`);
  }
}

export class RunnerWssClient {
  private readonly sockets = new Set<WebSocket>();
  private readonly pending = new Map<string, Pending>();
  private primary: WebSocket | undefined;
  private admitted = false;
  private ready = false;
  private filesystemReady = false;
  private closing = false;
  private failure: Error | undefined;
  private admission:
    { resolve(): void; reject(error: Error): void } | undefined;
  private noticeWait:
    { resolve(): void; reject(error: Error): void } | undefined;
  private expectedReverse: string | undefined;
  private probing = false;
  private reverseCount = 0;
  private noticeCount = 0;

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

  get receipts() {
    return {
      reverseCalls: this.reverseCount,
      noticesReceived: this.noticeCount,
    };
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
      maxPayload: limits.maxFrameBytes,
      perMessageDeflate: false,
    });
    this.sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => this.sockets.delete(socket));
    return socket;
  }

  private fail(message: string): void {
    this.failure ??= new Error(message);
    this.admission?.reject(this.failure);
    this.noticeWait?.reject(this.failure);
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
  }

  assertHealthy(): void {
    if (this.failure) throw this.failure;
    if (!this.admitted || this.primary?.readyState !== WebSocket.OPEN)
      throw new Error("Admitted WSS connection unavailable");
  }

  private send(message: SandboxChannelMessage): void {
    this.assertHealthy();
    const socket = this.primary;
    const frame = encodeSandboxChannelFrame(message);
    if (
      !socket ||
      socket.bufferedAmount + frame.byteLength > limits.maxQueuedBytes
    )
      throw new Error("WSS probe backpressure");
    socket.send(Buffer.from(frame), { binary: true }, (error) => {
      if (error) this.fail("WSS write failed");
    });
  }

  private frame(data: RawData, binary: boolean): void {
    try {
      if (!binary) throw new Error("Binary application frame required");
      const message = decodeSandboxChannelFrame(
        new Uint8Array(bytes(data)).buffer,
      );
      if (message.type === "response") {
        const pending = this.pending.get(message.requestId);
        if (!pending) return;
        this.pending.delete(message.requestId);
        if (message.error)
          pending.reject(new SandboxRequestError(message.error.code));
        else {
          try {
            pending.complete(message.result);
          } catch {
            pending.reject(new Error("Invalid sandbox channel result"));
            this.fail("Invalid sandbox channel frame or result");
          }
        }
        return;
      }
      if (!this.ready) throw new Error("Business message preceded hello");
      if (message.type === "event") {
        if (
          message.category !== "diagnostics" ||
          message.categoryVersion !== 1 ||
          message.event !== "notice"
        )
          throw new Error("Unexpected Guest event");
        const parsed = sandboxDiagnosticsNoticeSchema.safeParse(message.data);
        if (!parsed.success) throw new Error("Invalid notice");
        this.noticeCount += 1;
        this.noticeWait?.resolve();
        return; // One-way events never receive a response or ACK.
      }
      if (message.type !== "request") throw new Error("Unexpected Guest hello");
      const parsed = sandboxDiagnosticsEchoSchema.safeParse(message.params);
      if (
        message.category !== "diagnostics" ||
        message.categoryVersion !== 1 ||
        message.operation !== "echo" ||
        !parsed.success
      )
        throw new Error("Invalid Guest reverse request");
      if (parsed.data.payload !== this.expectedReverse)
        throw new Error("Guest reverse payload mismatch");
      this.send({
        schemaVersion: limits.schemaVersion,
        type: "response",
        id: randomUUID(),
        requestId: message.id,
        result: parsed.data,
      });
      this.reverseCount += 1;
    } catch {
      this.fail("Invalid sandbox channel frame or result");
    }
  }

  private async call<T>(
    message: Extract<SandboxChannelMessage, { type: "hello" | "request" }>,
    schema: SandboxChannelPayloadSchema<T>,
    apply?: (value: T) => void,
  ): Promise<T> {
    this.assertHealthy();
    if (this.pending.size >= limits.maxPending)
      throw new Error("WSS probe pending budget exceeded");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        this.pending.set(message.id, {
          complete: (value) => {
            const parsed = schema.safeParse(value);
            if (!parsed.success) {
              reject(new Error("Invalid sandbox channel result"));
              this.fail("Invalid sandbox channel frame or result");
              return;
            }
            apply?.(parsed.data);
            resolve(parsed.data);
          },
          reject,
        });
        timer = setTimeout(
          () => reject(new Error("Sandbox diagnostic deadline exceeded")),
          message.type === "hello"
            ? limits.helloTimeoutMs
            : limits.requestTimeoutMs,
        );
        try {
          this.send(message);
        } catch {
          reject(new Error("Sandbox diagnostic write failed"));
        }
      });
    } finally {
      clearTimeout(timer);
      this.pending.delete(message.id);
    }
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
      this.frame(data, binary);
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
    } finally {
      clearTimeout(timer);
      this.admission = undefined;
    }
    await this.call(
      {
        schemaVersion: limits.schemaVersion,
        type: "hello",
        id: randomUUID(),
        categories: { diagnostics: 1, fs: SANDBOX_FS_VERSION },
      },
      sandboxChannelHelloResultSchema,
      (hello) => {
        if (hello.categories.diagnostics !== 1)
          throw new Error("Diagnostics unavailable");
        this.ready = true; // Apply synchronously before resolving hello.
        this.filesystemReady = hello.categories.fs === SANDBOX_FS_VERSION;
      },
    );
    if (!this.noticeCount) {
      try {
        await new Promise<void>((resolve, reject) => {
          this.noticeWait = { resolve, reject };
          timer = setTimeout(
            () => reject(new Error("Guest notice deadline exceeded")),
            limits.helloTimeoutMs,
          );
        });
      } finally {
        clearTimeout(timer);
        this.noticeWait = undefined;
      }
    }
    this.assertHealthy();
  }

  async diagnostics(): Promise<void> {
    this.assertHealthy();
    if (!this.ready || this.probing)
      throw new Error("Diagnostics probe already active or unavailable");
    this.probing = true;
    try {
      this.send({
        schemaVersion: limits.schemaVersion,
        type: "event",
        id: randomUUID(),
        category: "diagnostics",
        categoryVersion: 1,
        event: "notice",
        data: { message: "probe" },
      });
      for (const [frameIndex, size] of ECHO_SIZES.entries()) {
        const payload = Buffer.from(
          Uint8Array.from(
            { length: size },
            (_, index) => (index * 31 + frameIndex * 17) % 256,
          ),
        ).toString("base64");
        for (const operation of ["echo", "peer.echo"]) {
          const before = this.reverseCount;
          if (operation === "peer.echo") this.expectedReverse = payload;
          try {
            const result = await this.call(
              {
                schemaVersion: limits.schemaVersion,
                type: "request",
                id: randomUUID(),
                category: "diagnostics",
                categoryVersion: 1,
                operation,
                params: { payload },
              },
              sandboxDiagnosticsEchoSchema,
            );
            if (result.payload !== payload)
              throw new Error("Guest diagnostics echo mismatch");
            if (
              this.reverseCount !==
              before + (operation === "peer.echo" ? 1 : 0)
            )
              throw new Error("Guest reverse diagnostics missing");
          } finally {
            this.expectedReverse = undefined;
          }
        }
      }
      this.assertHealthy();
    } finally {
      this.expectedReverse = undefined;
      this.probing = false;
    }
  }

  async list(params: unknown) {
    if (!this.filesystemReady) throw new Error("Filesystem role unavailable");
    return this.call(
      {
        schemaVersion: 1,
        type: "request",
        id: randomUUID(),
        category: "fs",
        categoryVersion: SANDBOX_FS_VERSION,
        operation: "list",
        params: sandboxFsListParamsSchema.parse(params),
      },
      sandboxFsListResultSchema,
    );
  }

  async closeCursor(cursor: string): Promise<void> {
    if (!this.filesystemReady) throw new Error("Filesystem role unavailable");
    await this.call(
      {
        schemaVersion: 1,
        type: "request",
        id: randomUUID(),
        category: "fs",
        categoryVersion: SANDBOX_FS_VERSION,
        operation: "list.close",
        params: sandboxFsListCloseParamsSchema.parse({ cursor }),
      },
      sandboxFsListCloseResultSchema,
    );
  }

  async rejectFs(
    operation: string,
    params: Record<string, unknown>,
    code: string,
  ): Promise<void> {
    if (!this.filesystemReady) throw new Error("Filesystem role unavailable");
    try {
      await this.call(
        {
          schemaVersion: 1,
          type: "request",
          id: randomUUID(),
          category: "fs",
          categoryVersion: SANDBOX_FS_VERSION,
          operation,
          params,
        },
        sandboxFsListCloseResultSchema,
      );
    } catch (error: unknown) {
      if (error instanceof SandboxRequestError && error.code === code) return;
      throw error;
    }
    throw new Error(
      "Filesystem operation was not rejected with its expected code",
    );
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
    const error = new Error("WSS client closed");
    this.admission?.reject(error);
    this.noticeWait?.reject(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
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
