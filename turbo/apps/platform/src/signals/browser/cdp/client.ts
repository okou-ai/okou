import {
  callAsync,
  scheduleTimeout,
  createDeferredPromise,
  detach,
  jsonParseOr,
  Reason,
  type DeferredPromise,
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
        > & {
          format?: "jpeg" | "png" | "webp";
        }
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
  readonly reject: (error: unknown) => void;
  timer: (() => void) | undefined;
  unwatch: (() => void) | undefined;
  settled: boolean;
  late?: (result: unknown) => void | Promise<void>;
}
export type SocketFactory = (url: string) => WebSocket;
export interface CdpClient {
  readonly signal: AbortSignal;
  readonly opened: Promise<void>;
  request<M extends Method>(
    method: M,
    params: Params<M>,
    sessionId?: string,
    late?: (result: unknown) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<Result<M>>;
  notify<M extends Method>(
    method: M,
    params: Params<M>,
    sessionId?: string,
  ): void;
  on(listener: (event: CdpEvent) => void): () => void;
  onClose(listener: (error: CdpFault) => void): () => void;
  onEvent(listener: (event: CdpEvent) => void): () => void;
  onDisconnected(listener: (error: CdpFault) => void): () => void;
  close(fault?: CdpFault): void;
}

/** Native protocol correlation only; viewer/domain state stays in ccstate. */
interface Connection {
  readonly socket: WebSocket;
  readonly opening: DeferredPromise<void>;
  readonly pending: Map<number, Pending>;
  readonly listeners: Set<(event: CdpEvent) => void>;
  readonly closeListeners: Set<(fault: CdpFault) => void>;
  openingTimer: (() => void) | undefined;
  nextId: number;
  ended: boolean;
}
interface Message {
  id: number;
  method: Method;
  params?: unknown;
  sessionId?: string | undefined;
}

function createWire(connection: Connection) {
  function close(
    fault = new CdpFault("connection", "The connection is closed."),
  ): void {
    if (connection.ended) {
      return;
    }
    connection.ended = true;
    connection.openingTimer?.();
    if (!connection.opening.settled()) {
      connection.opening.reject(fault);
    }
    for (const entry of connection.pending.values()) {
      entry.timer?.();
      entry.unwatch?.();
      if (!entry.settled) {
        entry.reject(fault);
      }
    }
    connection.pending.clear();
    detach(
      Promise.allSettled([
        callAsync(() => {
          connection.socket.close();
        }),
      ]),
      Reason.DomCallback,
      "browser socket close",
    );
    // Native subscribers may remove themselves or reenter while close publishes.
    const subscribers = [...connection.closeListeners];
    for (const listener of subscribers) {
      listener(fault);
    }
    connection.closeListeners.clear();
    connection.listeners.clear();
  }
  async function send(message: Message): Promise<boolean> {
    if (connection.ended || connection.socket.readyState !== 1) {
      return false;
    }
    if (connection.socket.bufferedAmount > 4 * 1024 * 1024) {
      close(
        new CdpFault("connection", "The browser connection is not draining."),
      );
      return false;
    }
    const [sent] = await Promise.allSettled([
      callAsync(() => {
        connection.socket.send(JSON.stringify(message));
      }),
    ]);
    if (sent.status === "rejected") {
      close(
        new CdpFault(
          "connection",
          "WebSocket connection failed. Check endpoint access, Origin and TLS policy.",
        ),
      );
    }
    return sent.status === "fulfilled";
  }
  return { close, send };
}
type Wire = ReturnType<typeof createWire>;

function createRequests(
  connection: Connection,
  wire: Wire,
  requestTimeout: number,
  signal: AbortSignal,
) {
  async function request<M extends Method>(
    method: M,
    params: Params<M>,
    sessionId?: string,
    late?: (result: unknown) => void | Promise<void>,
    operation?: AbortSignal,
  ): Promise<Result<M>> {
    operation?.throwIfAborted();
    if (connection.ended || connection.socket.readyState !== 1) {
      throw new CdpFault(
        "connection",
        "The connection is closed.",
        undefined,
        Object.freeze({ method }),
      );
    }
    if (connection.pending.size >= 256) {
      const fault = new CdpFault(
        "protocol",
        "Too many pending browser requests.",
      );
      wire.close(fault);
      throw fault;
    }
    const id = connection.nextId++;
    const deferred = createDeferredPromise<Result<M>>(signal);
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
      timer: undefined,
      unwatch: undefined,
      settled: false,
      ...(late ? { late } : {}),
    };
    connection.pending.set(id, entry);
    entry.timer = scheduleTimeout(
      () => {
        entry.settled = true;
        entry.unwatch?.();
        if (!entry.late) {
          connection.pending.delete(id);
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
      requestTimeout,
      signal,
    );
    if (operation) {
      const abortRequest = () => {
        if (entry.settled) {
          return;
        }
        entry.settled = true;
        entry.timer?.();
        entry.unwatch?.();
        if (!entry.late) {
          connection.pending.delete(id);
        }
        entry.reject(operation.reason);
      };
      operation.addEventListener("abort", abortRequest, { once: true });
      entry.unwatch = () => {
        operation.removeEventListener("abort", abortRequest);
      };
    }
    if (!(await wire.send({ id, method, params, sessionId }))) {
      connection.pending.delete(id);
      entry.timer?.();
      entry.unwatch?.();
      entry.reject(new CdpFault("connection", "The connection is closed."));
    }
    return deferred.promise;
  }
  function notify<M extends Method>(
    method: M,
    params: Params<M>,
    sessionId?: string,
  ): void {
    detach(
      wire.send({ id: connection.nextId++, method, params, sessionId }),
      Reason.DomCallback,
      "browser native notification",
    );
  }
  return { request, notify };
}

async function releaseLate(
  entry: Pending,
  value: unknown,
  wire: Wire,
): Promise<void> {
  const [released] = await Promise.allSettled([
    callAsync(() => {
      return entry.late?.(value);
    }),
  ]);
  if (released.status === "rejected") {
    wire.close(
      new CdpFault("protocol", "A late browser session could not be released."),
    );
  }
}

function receiveResponse(
  connection: Connection,
  wire: Wire,
  value: Record<string, unknown> & { id: number },
): void {
  const entry = connection.pending.get(value.id);
  if (!entry) {
    return;
  }
  const success = value.error === undefined && isRecord(value.result);
  const failure = value.result === undefined && isRecord(value.error);
  if (!success && !failure) {
    wire.close(new CdpFault("protocol", "Invalid CDP response."));
    return;
  }
  connection.pending.delete(value.id);
  entry.timer?.();
  entry.unwatch?.();
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
        releaseLate(entry, value.result, wire),
        Reason.DomCallback,
        "browser late session cleanup",
      );
    }
  } else {
    entry.resolve(value.result);
  }
}

function receiveMessage(
  connection: Connection,
  wire: Wire,
  event: MessageEvent<unknown>,
): void {
  if (typeof event.data !== "string" || event.data.length > 16 * 1024 * 1024) {
    wire.close(new CdpFault("protocol", "Invalid or oversized CDP message."));
    return;
  }
  const value = jsonParseOr<unknown>(event.data, null);
  if (!isRecord(value)) {
    wire.close(new CdpFault("protocol", "Invalid CDP envelope."));
    return;
  }
  if (typeof value.id === "number") {
    receiveResponse(
      connection,
      wire,
      value as Record<string, unknown> & { id: number },
    );
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
    const subscribers = [...connection.listeners];
    for (const listener of subscribers) {
      listener(message);
    }
  }
}

function listen(
  connection: Connection,
  wire: Wire,
  requestTimeout: number,
  signal: AbortSignal,
): void {
  const opened = () => {
    connection.openingTimer?.();
    if (!connection.opening.settled()) {
      connection.opening.resolve();
    }
  };
  const message = (event: MessageEvent<unknown>) => {
    receiveMessage(connection, wire, event);
  };
  const error = () => {
    wire.close(
      new CdpFault(
        "connection",
        "WebSocket connection failed. Check endpoint access, Origin and TLS policy.",
      ),
    );
  };
  const closed = () => {
    wire.close(new CdpFault("connection", "The browser disconnected."));
  };
  const abort = () => {
    wire.close();
  };
  connection.socket.addEventListener("open", opened);
  connection.socket.addEventListener("message", message);
  connection.socket.addEventListener("error", error);
  connection.socket.addEventListener("close", closed);
  connection.openingTimer = scheduleTimeout(
    () => {
      wire.close(new CdpFault("connection", "The connection timed out."));
    },
    requestTimeout,
    signal,
  );
  signal.addEventListener("abort", abort, { once: true });
  connection.closeListeners.add(() => {
    signal.removeEventListener("abort", abort);
    connection.socket.removeEventListener("open", opened);
    connection.socket.removeEventListener("message", message);
    connection.socket.removeEventListener("error", error);
    connection.socket.removeEventListener("close", closed);
  });
}

/** One mounted surface owns this native socket adapter and its protocol receipts. */
export function createCdpClient(
  url: string,
  signal: AbortSignal,
  factory: SocketFactory = (endpoint) => {
    return new WebSocket(endpoint);
  },
  requestTimeout = 10_000,
): CdpClient {
  signal.throwIfAborted();
  const connection: Connection = {
    socket: factory(url),
    opening: createDeferredPromise<void>(signal),
    pending: new Map(),
    listeners: new Set(),
    closeListeners: new Set(),
    openingTimer: undefined,
    nextId: 1,
    ended: false,
  };
  const wire = createWire(connection);
  const requests = createRequests(connection, wire, requestTimeout, signal);
  const on = (listener: (event: CdpEvent) => void) => {
    connection.listeners.add(listener);
    return () => {
      return connection.listeners.delete(listener);
    };
  };
  const onClose = (listener: (fault: CdpFault) => void) => {
    connection.closeListeners.add(listener);
    return () => {
      return connection.closeListeners.delete(listener);
    };
  };
  listen(connection, wire, requestTimeout, signal);
  if (signal.aborted) {
    wire.close();
  }
  return {
    signal,
    opened: connection.opening.promise,
    ...requests,
    on,
    onClose,
    onEvent: on,
    onDisconnected: onClose,
    close: wire.close,
  };
}
