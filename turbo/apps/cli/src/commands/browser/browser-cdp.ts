import { number, object, unknown as zUnknown } from "zod";

export const CDP_COMMAND_TIMEOUT_MS = 5_000;
const CDP_CONNECT_TIMEOUT_MS = 5_000;
const CDP_MAX_RESPONSE_BYTES = 64 * 1024;

const responseSchema = object({
  id: number().int().positive(),
  result: zUnknown().optional(),
  error: zUnknown().optional(),
}).passthrough();

interface CdpErrors {
  readonly connection: (message: string) => Error;
  readonly timeout: (message: string) => Error;
  readonly command: (error: unknown) => Error;
}

interface PendingCommand {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function boundedTimeout(
  maximumMs: number,
  deadline: number,
  errors: CdpErrors,
): number {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw errors.timeout("Browser inspection timed out");
  }
  return Math.max(1, Math.min(maximumMs, remainingMs));
}

function closeWebSocket(socket: WebSocket, code?: number): void {
  if (
    socket.readyState !== WebSocket.CONNECTING &&
    socket.readyState !== WebSocket.OPEN
  ) {
    return;
  }
  try {
    socket.close(code);
  } catch {
    // Closing a failed connection is best-effort; the operation still rejects.
  }
}

export class BrowserCdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCommand>();
  private failed = false;

  private constructor(
    private readonly socket: WebSocket,
    private readonly deadline: number,
    private readonly errors: CdpErrors,
    private readonly maximumResponseBytes: number,
  ) {
    socket.addEventListener("message", (event) => {
      this.handleMessage(event);
    });
    socket.addEventListener("error", () => {
      this.failAll();
    });
    socket.addEventListener("close", () => {
      this.failAll();
    });
  }

  static async connect(
    url: string,
    deadline: number,
    errors: CdpErrors,
    maximumResponseBytes = CDP_MAX_RESPONSE_BYTES,
  ): Promise<BrowserCdpClient> {
    const timeoutMs = boundedTimeout(CDP_CONNECT_TIMEOUT_MS, deadline, errors);
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      throw errors.connection("Could not connect to the attached Browser");
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        closeWebSocket(socket);
        reject(errors.timeout("The Browser inspection connection timed out"));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onFailure);
        socket.removeEventListener("close", onFailure);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onFailure = () => {
        cleanup();
        closeWebSocket(socket);
        reject(errors.connection("Could not connect to the attached Browser"));
      };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onFailure);
      socket.addEventListener("close", onFailure);
    });
    return new BrowserCdpClient(socket, deadline, errors, maximumResponseBytes);
  }

  private handleMessage(event: MessageEvent): void {
    if (
      typeof event.data !== "string" ||
      event.data.length > this.maximumResponseBytes
    ) {
      this.failAll();
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(event.data);
    } catch {
      this.failAll();
      return;
    }
    const response = responseSchema.safeParse(raw);
    if (!response.success) {
      return;
    }
    const pending = this.pending.get(response.data.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(response.data.id);
    if (response.data.error !== undefined) {
      pending.reject(this.errors.command(response.data.error));
      return;
    }
    pending.resolve(response.data.result);
  }

  private failAll(): void {
    if (this.failed) {
      return;
    }
    this.failed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        this.errors.connection("The Browser inspection connection closed"),
      );
    }
    this.pending.clear();
  }

  async send(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    sessionId?: string,
    timeoutMs = CDP_COMMAND_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.failed || this.socket.readyState !== WebSocket.OPEN) {
      throw this.errors.connection(
        "The Browser inspection connection is closed",
      );
    }
    const id = this.nextId;
    this.nextId += 1;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(this.errors.timeout("The Browser target did not respond"));
        },
        boundedTimeout(timeoutMs, this.deadline, this.errors),
      );
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId ? { sessionId } : {}),
          }),
        );
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(this.errors.connection("Could not inspect the Browser target"));
      }
    });
  }

  close(): void {
    this.failAll();
    closeWebSocket(this.socket, 1000);
  }
}
