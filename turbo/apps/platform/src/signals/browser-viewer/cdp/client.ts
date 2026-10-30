import {
  callAsync,
  scheduleTimeout,
  createDeferredPromise,
  detach,
  jsonParseOr,
  Reason,
} from "../../utils.ts";

import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping";

import { CdpFault, isRecord } from "./errors.ts";

type Method = keyof ProtocolMapping.Commands;
type Params<M extends Method> =
  | ProtocolMapping.Commands[M]["paramsType"][0]
  | (M extends "Page.startScreencast"
      ? Omit<
          NonNullable<ProtocolMapping.Commands[M]["paramsType"][0]>,
          "format"
        > & { format?: "jpeg" | "png" | "webp" }
      : never);
type Result<M extends Method> = ProtocolMapping.Commands[M]["returnType"];

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}
interface Pending {
  readonly method: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: CdpFault) => void;
  timer: (() => void) | undefined;
  settled: boolean;
  late?: (result: unknown) => void | Promise<void>;
}
export type SocketFactory = (url: string) => WebSocket;

/** One mounted browser owns its socket, pending requests and native sessions. */
export class CdpClient {
  readonly opened: Promise<void>;
  private readonly socket: WebSocket;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(event: CdpEvent) => void>();
  private readonly closeListeners = new Set<(error: CdpFault) => void>();
  private readonly opening;
  private openingTimer: (() => void) | undefined;
  private nextId = 1;
  private ended = false;

  constructor(
    url: string,
    readonly signal: AbortSignal,
    factory: SocketFactory = (endpoint) => {
      return new WebSocket(endpoint);
    },
    private readonly requestTimeout = 10_000,
  ) {
    signal.throwIfAborted();
    this.socket = factory(url);
    this.opening = createDeferredPromise<void>(signal);
    this.opened = this.opening.promise;
    this.socket.addEventListener("open", this.onOpen);
    this.socket.addEventListener("message", this.onMessage);
    this.socket.addEventListener("error", this.onError);
    this.socket.addEventListener("close", this.onClose);
    this.openingTimer = scheduleTimeout(
      () => {
        return this.close(
          new CdpFault("connection", "The connection timed out."),
        );
      },
      requestTimeout,
      this.signal,
    );
    signal.addEventListener("abort", this.abort, { once: true });
  }
  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      return this.listeners.delete(listener);
    };
  }
  onDisconnected(listener: (error: CdpFault) => void): () => void {
    this.closeListeners.add(listener);
    return () => {
      return this.closeListeners.delete(listener);
    };
  }
  async request<M extends Method>(
    method: M,
    params: Params<M>,
    sessionId?: string,
    late?: (result: unknown) => void | Promise<void>,
  ): Promise<Result<M>> {
    return (await this.requestRaw(
      method,
      params,
      sessionId,
      late,
    )) as Result<M>;
  }
  async requestRaw(
    method: string,
    params: unknown,
    sessionId?: string,
    late?: (result: unknown) => void | Promise<void>,
  ): Promise<unknown> {
    if (this.ended || this.socket.readyState !== 1) {
      throw new CdpFault(
        "connection",
        "The connection is closed.",
        undefined,
        Object.freeze({ method }),
      );
    }
    if (this.pending.size >= 256) {
      const error = new CdpFault(
        "protocol",
        "Too many pending browser requests.",
      );
      this.close(error);
      throw error;
    }
    const id = this.nextId++;
    const deferred = createDeferredPromise<unknown>(this.signal);
    const entry: Pending = {
      method,
      resolve: (result) => {
        if (!deferred.settled()) {
          deferred.resolve(result);
        }
      },
      reject: (error) => {
        if (!deferred.settled()) {
          deferred.reject(error);
        }
      },
      timer: undefined,
      settled: false,
      ...(late ? { late } : {}),
    };
    this.pending.set(id, entry);
    entry.timer = scheduleTimeout(
      () => {
        entry.settled = true;
        if (!entry.late) {
          this.pending.delete(id);
        }
        entry.reject(
          new CdpFault(
            "protocol",
            "The browser request timed out.",
            undefined,
            Object.freeze({ method }),
          ),
        );
      },
      this.requestTimeout,
      this.signal,
    );
    if (!(await this.send({ id, method, params, sessionId }))) {
      this.pending.delete(id);
      entry.timer?.();
      entry.reject(new CdpFault("connection", "The connection is closed."));
    }
    return deferred.promise;
  }
  notify<M extends Method>(
    method: M,
    params: Params<M>,
    sessionId?: string,
  ): void {
    detach(
      this.send({ id: this.nextId++, method, params, sessionId }),
      Reason.DomCallback,
      "browser native notification",
    );
  }
  close(fault = new CdpFault("connection", "The connection is closed.")): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.openingTimer?.();
    if (!this.opening.settled()) {
      this.opening.reject(fault);
    }
    for (const request of this.pending.values()) {
      request.timer?.();
      if (!request.settled) {
        request.reject(fault);
      }
    }
    this.pending.clear();
    this.signal.removeEventListener("abort", this.abort);
    this.socket.removeEventListener("open", this.onOpen);
    this.socket.removeEventListener("message", this.onMessage);
    this.socket.removeEventListener("error", this.onError);
    this.socket.removeEventListener("close", this.onClose);
    detach(
      Promise.allSettled([
        callAsync(() => {
          this.socket.close();
        }),
      ]),
      Reason.DomCallback,
      "browser socket close",
    );
    // Subscribers can unsubscribe or reenter while the original close publishes.
    const closeListeners = [...this.closeListeners];
    for (const listener of closeListeners) {
      listener(fault);
    }
    this.closeListeners.clear();
    this.listeners.clear();
  }
  private readonly abort = () => {
    return this.close();
  };
  private readonly onOpen = () => {
    this.openingTimer?.();
    if (!this.opening.settled()) {
      this.opening.resolve();
    }
  };
  private readonly onError = () => {
    return this.close(
      new CdpFault(
        "connection",
        "WebSocket connection failed. Check endpoint access, Origin and TLS policy.",
      ),
    );
  };
  private readonly onClose = () => {
    return this.close(new CdpFault("connection", "The browser disconnected."));
  };
  private async send(message: {
    id: number;
    method: string;
    params?: unknown;
    sessionId?: string | undefined;
  }): Promise<boolean> {
    if (this.ended || this.socket.readyState !== 1) {
      return false;
    }
    if (this.socket.bufferedAmount > 4 * 1024 * 1024) {
      this.close(
        new CdpFault("connection", "The browser connection is not draining."),
      );
      return false;
    }
    const [sent] = await Promise.allSettled([
      callAsync(() => {
        this.socket.send(JSON.stringify(message));
      }),
    ]);
    if (sent.status === "rejected") {
      this.onError();
    }
    return sent.status === "fulfilled";
  }
  private async releaseLate(entry: Pending, value: unknown): Promise<void> {
    const [released] = await Promise.allSettled([
      (async () => {
        await entry.late?.(value);
      })(),
    ]);
    if (released.status === "rejected") {
      this.close(
        new CdpFault(
          "protocol",
          "A late browser session could not be released.",
        ),
      );
    }
  }
  private onResponse(value: Record<string, unknown> & { id: number }): void {
    const entry = this.pending.get(value.id);
    if (!entry) {
      return;
    }
    const success = value.error === undefined && isRecord(value.result);
    const failure = value.result === undefined && isRecord(value.error);
    if (!success && !failure) {
      this.close(new CdpFault("protocol", "Invalid CDP response."));
      return;
    }
    this.pending.delete(value.id);
    entry.timer?.();
    if (isRecord(value.error)) {
      if (!entry.settled) {
        const code =
          typeof value.error.code === "number" ? value.error.code : undefined;
        entry.reject(
          new CdpFault(
            "protocol",
            "CDP request failed.",
            code,
            Object.freeze({
              method: entry.method,
              ...(code !== undefined && Number.isSafeInteger(code)
                ? { code }
                : {}),
            }),
          ),
        );
      }
    } else if (entry.settled) {
      if (entry.late) {
        detach(
          this.releaseLate(entry, value.result),
          Reason.DomCallback,
          "browser late session cleanup",
        );
      }
    } else {
      entry.resolve(value.result);
    }
  }
  private readonly onMessage = (event: MessageEvent<unknown>) => {
    if (
      typeof event.data !== "string" ||
      event.data.length > 16 * 1024 * 1024
    ) {
      this.close(new CdpFault("protocol", "Invalid or oversized CDP message."));
      return;
    }
    const value = jsonParseOr<unknown>(event.data, null);
    if (!isRecord(value)) {
      this.close(new CdpFault("protocol", "Invalid CDP envelope."));
      return;
    }
    if (typeof value.id === "number") {
      this.onResponse(value as Record<string, unknown> & { id: number });
    } else if (
      typeof value.method === "string" &&
      (value.params === undefined || isRecord(value.params))
    ) {
      const message: CdpEvent = {
        method: value.method,
        params: value.params ?? {},
        ...(typeof value.sessionId === "string"
          ? { sessionId: value.sessionId }
          : {}),
      };
      const listeners = [...this.listeners];
      for (const listener of listeners) {
        listener(message);
      }
    }
  };
}
