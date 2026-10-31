import {
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
  readonly method: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: unknown) => void;
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
  requestRaw(
    method: string,
    params: unknown,
    sessionId?: string,
    late?: (result: unknown) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<unknown>;
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
  nextId: number;
  ended: boolean;
}
interface Message {
  id: number;
  method: string;
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
    if (!connection.opening.settled()) {
      connection.opening.reject(fault);
    }
    for (const entry of connection.pending.values()) {
      entry.unwatch?.();
      if (!entry.settled) {
        entry.reject(fault);
      }
    }
    connection.pending.clear();
    // Native subscribers may remove themselves or reenter while close publishes.
    const subscribers = [...connection.closeListeners];
    for (const listener of subscribers) {
      listener(fault);
    }
    connection.closeListeners.clear();
    connection.listeners.clear();
    // Last, so a failing native close cannot skip the protocol teardown above.
    connection.socket.close();
  }
  function send(message: Message): boolean {
    if (connection.ended || connection.socket.readyState !== 1) {
      return false;
    }
    if (connection.socket.bufferedAmount > 4 * 1024 * 1024) {
      close(
        new CdpFault("connection", "The browser connection is not draining."),
      );
      return false;
    }
    connection.socket.send(JSON.stringify(message));
    return true;
  }
  return { close, send };
}
type Wire = ReturnType<typeof createWire>;

function createRequests(
  connection: Connection,
  wire: Wire,
  signal: AbortSignal,
) {
  async function requestRaw(
    method: string,
    params: unknown,
    sessionId?: string,
    late?: (result: unknown) => void | Promise<void>,
    operation?: AbortSignal,
  ): Promise<unknown> {
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
    // Responses arrive in a later task, so a request is pending only once its
    // message was written; a failed write rejects without leaving an entry.
    if (!wire.send({ id, method, params, sessionId })) {
      throw new CdpFault("connection", "The connection is closed.");
    }
    const deferred = createDeferredPromise<unknown>(signal);
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
      unwatch: undefined,
      settled: false,
      ...(late ? { late } : {}),
    };
    connection.pending.set(id, entry);
    if (operation) {
      const abortRequest = () => {
        if (entry.settled) {
          return;
        }
        entry.settled = true;
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
    return await deferred.promise;
  }
  function notify<M extends Method>(
    method: M,
    params: Params<M>,
    sessionId?: string,
  ): void {
    wire.send({ id: connection.nextId++, method, params, sessionId });
  }
  async function request<M extends Method>(
    method: M,
    params: Params<M>,
    sessionId?: string,
    late?: (result: unknown) => void | Promise<void>,
    operation?: AbortSignal,
  ): Promise<Result<M>> {
    return (await requestRaw(
      method,
      params,
      sessionId,
      late,
      operation,
    )) as Result<M>;
  }
  return { request, requestRaw, notify };
}

async function releaseLate(
  entry: Pending,
  value: unknown,
  wire: Wire,
): Promise<void> {
  // An unreleased late session must not outlive its connection.
  let released = false;
  using _release = {
    [Symbol.dispose]: () => {
      if (!released) {
        wire.close(
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

function listen(connection: Connection, wire: Wire, signal: AbortSignal): void {
  const opened = () => {
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
  options: { readonly factory?: SocketFactory },
  signal: AbortSignal,
): CdpClient {
  signal.throwIfAborted();
  const factory =
    options.factory ??
    ((endpoint: string) => {
      return new WebSocket(endpoint);
    });
  const connection: Connection = {
    socket: factory(url),
    opening: createDeferredPromise<void>(signal),
    pending: new Map(),
    listeners: new Set(),
    closeListeners: new Set(),
    nextId: 1,
    ended: false,
  };
  const wire = createWire(connection);
  const requests = createRequests(connection, wire, signal);
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
  listen(connection, wire, signal);
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
