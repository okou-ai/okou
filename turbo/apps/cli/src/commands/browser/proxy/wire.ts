import type { CdpEvent, CdpTransport } from "@okouai/browser-extension-client";

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class ProtocolError extends Error {
  constructor(readonly detail: Record<string, unknown>) {
    super("Browser protocol operation failed");
  }
}

/** One private control connection; downstream CDP request IDs stay untouched. */
export class ControlWire implements CdpTransport {
  private nextId = 0;
  private readonly pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly listeners = new Set<(event: CdpEvent) => void>();
  private releaseOwner: (() => void) | undefined;

  private constructor(readonly socket: WebSocket) {
    socket.addEventListener("message", ({ data }: { data: unknown }) => {
      if (typeof data !== "string") return this.close();
      let value: unknown;
      try {
        value = JSON.parse(data);
      } catch {
        return this.close();
      }
      if (!record(value)) return this.close();
      if (typeof value.id === "number") {
        const entry = this.pending.get(value.id);
        if (!entry) return;
        this.pending.delete(value.id);
        clearTimeout(entry.timer);
        if (record(value.error)) entry.reject(new ProtocolError(value.error));
        else entry.resolve(value.result);
      } else if (typeof value.method === "string") {
        const event: CdpEvent = {
          method: value.method,
          params: record(value.params) ? value.params : {},
          ...(typeof value.sessionId === "string"
            ? { sessionId: value.sessionId }
            : {}),
        };
        const observers = [...this.listeners];
        for (const listener of observers)
          if (this.listeners.has(listener)) listener(event);
      }
    });
    socket.addEventListener("close", () => {
      this.fail();
    });
    socket.addEventListener("error", () => {
      return this.close();
    });
  }

  static async connect(url: string, signal: AbortSignal): Promise<ControlWire> {
    signal.throwIfAborted();
    const socket = new WebSocket(url);
    const wire = new ControlWire(socket);
    const abort = () => {
      return wire.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    wire.releaseOwner = () => {
      return signal.removeEventListener("abort", abort);
    };
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        wire.close();
        reject(new Error("Browser control connection timed out"));
      }, 15_000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "close",
        () => {
          clearTimeout(timer);
          reject(new Error("Browser control connection unavailable"));
        },
        { once: true },
      );
    });
    signal.throwIfAborted();
    return wire;
  }

  request(
    method: string,
    params: Readonly<Record<string, unknown>>,
    sessionId?: string,
  ): Promise<unknown> {
    if (this.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(
        new Error("Browser control connection unavailable"),
      );
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Browser control operation timed out"));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params, sessionId }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("Browser control connection unavailable"));
      }
    });
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    this.fail();
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    )
      this.socket.close();
  }

  private fail(): void {
    this.releaseOwner?.();
    this.releaseOwner = undefined;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Browser control connection closed"));
    }
    this.pending.clear();
  }
}
