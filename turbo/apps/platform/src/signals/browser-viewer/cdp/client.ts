import { createStore } from "ccstate";
import { timeout } from "signal-timers";
import {
  resetSignal,
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
  readonly method: Method;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: CdpFault) => void;
  readonly store: ReturnType<typeof createStore>;
  settled: boolean;
  late?: (result: unknown) => void | Promise<void>;
}
export type SocketFactory = (url: string) => WebSocket;

const resetOpeningDeadline$ = resetSignal();
const resetRequestDeadline$ = resetSignal();

/** One mounted browser owns its socket, pending requests and native sessions. */
export class CdpClient {
  readonly opened: Promise<void>;
  private readonly socket: WebSocket;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(event: CdpEvent) => void>();
  private readonly closeListeners = new Set<(error: CdpFault) => void>();
  private readonly opening;
  private readonly store = createStore();
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
    timeout(
      () => {
        return this.close(
          new CdpFault("connection", "The connection timed out."),
        );
      },
      requestTimeout,
      { signal: this.store.set(resetOpeningDeadline$, signal) },
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
    // Native responses are delivered in a later task. Acquire the pending
    // request only after send succeeds, so a synchronous send failure cannot
    // leave an unobserved deferred rejection behind.
    if (!this.send({ id, method, params, sessionId })) {
      throw new CdpFault("connection", "The connection is closed.");
    }
    const deferred = createDeferredPromise<Result<M>>(this.signal);
    const entry: Pending = {
      method,
      resolve: (result) => {
        if (!deferred.settled()) {
          deferred.resolve(result as Result<M>);
        }
      },
      reject: (error) => {
        if (!deferred.settled()) {
          deferred.reject(error);
        }
      },
      store: createStore(),
      settled: false,
      ...(late ? { late } : {}),
    };
    this.pending.set(id, entry);
    timeout(
      () => {
        entry.store.set(resetRequestDeadline$);
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
      { signal: entry.store.set(resetRequestDeadline$, this.signal) },
    );
    return await deferred.promise;
  }
  notify<M extends Method>(
    method: M,
    params: Params<M>,
    sessionId?: string,
  ): void {
    this.send({ id: this.nextId++, method, params, sessionId });
  }
  close(fault = new CdpFault("connection", "The connection is closed.")): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.store.set(resetOpeningDeadline$);
    if (!this.opening.settled()) {
      this.opening.reject(fault);
    }
    for (const request of this.pending.values()) {
      request.store.set(resetRequestDeadline$);
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
    // Subscribers can unsubscribe or reenter while the original close publishes.
    const closeListeners = [...this.closeListeners];
    this.closeListeners.clear();
    this.listeners.clear();
    using _disconnection = {
      [Symbol.dispose]: () => {
        for (const listener of closeListeners) {
          listener(fault);
        }
      },
    };
    this.socket.close();
  }
  private readonly abort = () => {
    return this.close();
  };
  private readonly onOpen = () => {
    this.store.set(resetOpeningDeadline$);
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
  private send(message: {
    id: number;
    method: Method;
    params?: unknown;
    sessionId?: string | undefined;
  }): boolean {
    if (this.ended || this.socket.readyState !== 1) {
      return false;
    }
    if (this.socket.bufferedAmount > 4 * 1024 * 1024) {
      this.close(
        new CdpFault("connection", "The browser connection is not draining."),
      );
      return false;
    }
    let sent = false;
    using _transport = {
      [Symbol.dispose]: () => {
        if (!sent) {
          this.onError();
        }
      },
    };
    this.socket.send(JSON.stringify(message));
    sent = true;
    return true;
  }
  private async releaseLate(entry: Pending, value: unknown): Promise<void> {
    let released = false;
    using _session = {
      [Symbol.dispose]: () => {
        if (!released) {
          this.close(
            new CdpFault(
              "protocol",
              "A late browser session could not be released.",
            ),
          );
        }
      },
    };
    await entry.late?.(value);
    released = true;
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
    entry.store.set(resetRequestDeadline$);
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
