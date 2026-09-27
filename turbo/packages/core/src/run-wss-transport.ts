import { delay } from "signal-timers";

/** Infrastructure only. No chat messages or delivery receipts use this transport. */
export const RUN_WSS_MAX_FRAME_BYTES = 64 * 1024;
export const RUN_WSS_MAX_BUFFERED_BYTES = 256 * 1024;
const AUTH_TIMEOUT_MS = 5000;
const MAX_RECONNECTS = 3;
const RECONNECT_DELAY_MS = 100;
const RUNNER_PATH =
  /^\/ws\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Bootstrap = (
  runId: string,
  signal: AbortSignal,
) => Promise<
  | {
      readonly kind: "success";
      readonly body: {
        readonly wssUrl: string;
        readonly ticket: string;
        readonly expiresAt: string;
      };
    }
  | { readonly kind: "terminal" | "transient" }
>;

type Socket = Pick<
  WebSocket,
  | "binaryType"
  | "bufferedAmount"
  | "readyState"
  | "addEventListener"
  | "removeEventListener"
  | "send"
  | "close"
>;

export type RunWssState =
  | "idle"
  | "connecting"
  | "ready"
  | "reconnecting"
  | "closed"
  | "failed";

export interface RunWssTransportOptions {
  /** Called synchronously; there is no offline frame queue or business receipt. */
  readonly onFrame: (frame: ArrayBuffer) => void;
  readonly onStateChange?: (state: RunWssState) => void;
  /** WebSocket boundary for deterministic, non-production contract tests. */
  readonly createSocket?: (url: string) => Socket;
}

class TerminalBootstrapError extends Error {}

function safeTarget(wssUrl: string): boolean {
  try {
    const url = new URL(wssUrl);
    return (
      url.protocol === "wss:" &&
      /^wss:\/\/[a-z0-9.-]+:443\/ws\//.test(wssUrl) &&
      url.username === "" &&
      url.password === "" &&
      /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(url.hostname) &&
      !/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) &&
      url.search === "" &&
      url.hash === "" &&
      RUNNER_PATH.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function abortError(): DOMException {
  return new DOMException("Run WSS transport closed", "AbortError");
}

export class RunWssTransport {
  private stateValue: RunWssState = "idle";
  private socket: Socket | null = null;
  private readonly lifetime = new AbortController();
  private firstReady: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((reason: Error) => void) | null = null;
  private externalSignal: AbortSignal | null = null;

  constructor(
    private readonly runId: string,
    private readonly bootstrap: Bootstrap,
    private readonly options: RunWssTransportOptions,
  ) {}

  get state(): RunWssState {
    return this.stateValue;
  }

  /** Explicit opt-in only: construction never requests a ticket or opens a socket. */
  connect(signal?: AbortSignal): Promise<void> {
    if (this.stateValue === "closed" || this.stateValue === "failed") {
      return Promise.reject(abortError());
    }
    if (signal?.aborted) {
      this.close();
      return Promise.reject(abortError());
    }
    if (this.firstReady) {
      return this.firstReady;
    }
    this.externalSignal = signal ?? null;
    signal?.addEventListener("abort", this.closeOnAbort, { once: true });
    this.firstReady = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    void this.run();
    return this.firstReady;
  }

  /** False means no frame was accepted; it is never queued or replayed. */
  send(frame: ArrayBuffer): boolean {
    if (frame.byteLength > RUN_WSS_MAX_FRAME_BYTES) {
      throw new RangeError("Run WSS frame exceeds limit");
    }
    if (
      this.stateValue !== "ready" ||
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN ||
      this.socket.bufferedAmount + frame.byteLength > RUN_WSS_MAX_BUFFERED_BYTES
    ) {
      return false;
    }
    try {
      this.socket.send(frame);
      return true;
    } catch {
      // The socket may have closed between the state check and send.
      this.socket.close();
      return false;
    }
  }

  close(): void {
    if (this.stateValue === "closed") {
      return;
    }
    this.setState("closed");
    this.lifetime.abort();
    this.socket?.close();
    this.socket = null;
    this.rejectReady?.(abortError());
    this.release();
  }

  private readonly closeOnAbort = () => {
    return this.close();
  };

  private setState(state: RunWssState): void {
    this.stateValue = state;
    try {
      this.options.onStateChange?.(state);
    } catch {
      // A consumer notification cannot leave the transport loop unowned.
    }
  }

  private release(): void {
    this.externalSignal?.removeEventListener("abort", this.closeOnAbort);
    this.externalSignal = null;
    this.resolveReady = null;
    this.rejectReady = null;
  }

  private async run(): Promise<void> {
    const signal = this.lifetime.signal;
    let failures = 0;
    while (!signal.aborted) {
      this.setState(failures === 0 ? "connecting" : "reconnecting");
      try {
        const { closed } = await this.open(signal);
        signal.throwIfAborted();
        this.setState("ready");
        this.resolveReady?.();
        this.resolveReady = null;
        this.rejectReady = null;
        await closed;
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        if (error instanceof TerminalBootstrapError) {
          this.fail();
          return;
        }
      }
      if (signal.aborted) {
        return;
      }
      failures += 1;
      if (failures > MAX_RECONNECTS) {
        this.fail();
        return;
      }
      try {
        await delay(RECONNECT_DELAY_MS * 2 ** (failures - 1), { signal });
      } catch {
        return; // only the owning AbortSignal cancels the delay
      }
    }
  }

  private fail(): void {
    this.setState("failed");
    this.lifetime.abort();
    this.rejectReady?.(new Error("Run WSS connection unavailable"));
    this.release();
  }

  private async open(signal: AbortSignal): Promise<{ closed: Promise<void> }> {
    const result = await this.bootstrap(
      this.runId,
      AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    );
    signal.throwIfAborted();
    if (result.kind !== "success") {
      if (result.kind === "terminal") {
        throw new TerminalBootstrapError();
      }
      throw new Error("Run WSS bootstrap unavailable");
    }
    const { wssUrl, ticket, expiresAt } = result.body;
    if (!safeTarget(wssUrl)) {
      throw new TerminalBootstrapError();
    }
    const remaining = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      throw new Error("Run WSS ticket expired");
    }

    // Never construct a URL from the hostname or interpolate the ticket into it.
    const socket = this.options.createSocket?.(wssUrl) ?? new WebSocket(wssUrl);
    return this.authenticate(socket, ticket, expiresAt, remaining, signal);
  }

  private async authenticate(
    socket: Socket,
    ticket: string,
    expiresAt: string,
    remaining: number,
    signal: AbortSignal,
  ): Promise<{ closed: Promise<void> }> {
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    let credential: string | null = ticket;
    let authenticated = false;
    let admissionSent = false;
    let finished = false;
    let resolveClosed: () => void = () => {
      return undefined;
    };
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const auth = new Promise<void>((resolve, reject) => {
      const timer = new AbortController();
      const cleanup = () => {
        timer.abort();
        signal.removeEventListener("abort", onAbort);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("error", fail);
        socket.removeEventListener("close", fail);
        if (this.socket === socket) {
          this.socket = null;
        }
        credential = null;
        resolveClosed();
      };
      const fail = () => {
        if (finished) {
          return;
        }
        finished = true;
        if (!authenticated) {
          reject(new Error("Run WSS admission failed"));
        }
        cleanup();
        socket.close();
      };
      const onAbort = () => {
        return fail();
      };
      const onOpen = () => {
        if (finished || Date.now() >= Date.parse(expiresAt) || !credential) {
          fail();
          return;
        }
        try {
          socket.send(
            JSON.stringify({ runId: this.runId, ticket: credential }),
          );
          credential = null;
          admissionSent = true;
        } catch {
          fail();
        }
      };
      const onMessage = (event: MessageEvent<unknown>) => {
        if (finished) {
          return;
        }
        if (!authenticated) {
          if (
            !admissionSent ||
            typeof event.data !== "string" ||
            event.data.length > 256
          ) {
            fail();
            return;
          }
          try {
            const message: unknown = JSON.parse(event.data);
            if (
              message === null ||
              typeof message !== "object" ||
              !("type" in message) ||
              message.type !== "auth.ok" ||
              Object.keys(message).length !== 1
            ) {
              fail();
              return;
            }
          } catch {
            fail();
            return;
          }
          authenticated = true;
          timer.abort();
          resolve();
          return;
        }
        if (
          !(event.data instanceof ArrayBuffer) ||
          event.data.byteLength > RUN_WSS_MAX_FRAME_BYTES
        ) {
          fail();
          return;
        }
        try {
          this.options.onFrame(event.data);
        } catch {
          fail();
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      socket.addEventListener("open", onOpen);
      socket.addEventListener("message", onMessage);
      socket.addEventListener("error", fail);
      socket.addEventListener("close", fail);
      const watchAuthTimeout = async () => {
        try {
          await delay(Math.min(AUTH_TIMEOUT_MS, remaining), {
            signal: timer.signal,
          });
          fail();
        } catch {
          // Expected cancellation on admission or close.
        }
      };
      void watchAuthTimeout();
    });
    await auth;
    return { closed };
  }
}
