import {
  createDeferredPromise,
  detach,
  jsonParseOr,
  Reason,
  setLoop,
  type DeferredPromise,
} from "../../utils.ts";
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping";
import { addBreadcrumb } from "@sentry/browser";
import { CdpFault, isRecord, type CdpConnectionObservation } from "./errors.ts";
import { maximumCdpMessageLength } from "../display/limits.ts";
import { now } from "../../../lib/time.ts";

const responseTimeoutMs = 30_000;

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
  readonly sessionId: string | undefined;
  readonly deadline: number;
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
  failure: CdpFault | null;
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
    if (connection.failure) {
      return;
    }
    connection.failure = fault;
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
    if (connection.failure || connection.socket.readyState !== 1) {
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
type ConnectionRole = "control" | "frames";

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
    if (connection.failure || connection.socket.readyState !== 1) {
      throw new CdpFault(
        "connection",
        "The connection is closed.",
        undefined,
        Object.freeze({ method }),
        connection.failure ? { cause: connection.failure } : undefined,
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
      throw new CdpFault(
        "connection",
        "The connection is closed.",
        undefined,
        Object.freeze({ method }),
        connection.failure ? { cause: connection.failure } : undefined,
      );
    }
    // The returned operation owns handling/reporting. This wire receipt must
    // not independently report a failure that its caller may handle normally.
    const deferred = createDeferredPromise<unknown>(
      { rejection: "owner" },
      signal,
    );
    const entry: Pending = {
      method,
      sessionId,
      deadline: now() + responseTimeoutMs,
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

function endSession(connection: Connection, sessionId: string): void {
  for (const [id, entry] of connection.pending) {
    if (entry.sessionId !== sessionId) {
      continue;
    }
    connection.pending.delete(id);
    entry.unwatch?.();
    entry.unwatch = undefined;
    if (!entry.settled) {
      entry.settled = true;
      entry.reject(
        new CdpFault(
          "target-unavailable",
          "The browser target session is closed.",
          undefined,
          Object.freeze({ method: entry.method }),
        ),
      );
    }
  }
}

function receiveMessage(
  connection: Connection,
  wire: Wire,
  event: MessageEvent<unknown>,
): void {
  if (
    typeof event.data !== "string" ||
    event.data.length > maximumCdpMessageLength
  ) {
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
    if (
      message.method === "Target.detachedFromTarget" &&
      typeof message.params.sessionId === "string"
    ) {
      endSession(connection, message.params.sessionId);
    }
    const subscribers = [...connection.listeners];
    for (const listener of subscribers) {
      listener(message);
    }
  }
}

function listen(
  connection: Connection,
  wire: Wire,
  signal: AbortSignal,
  role: ConnectionRole | undefined,
): void {
  let phase: "before-open" | "after-open" = "before-open";
  const opened = () => {
    phase = "after-open";
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
        `WebSocket error (phase=${phase}, readyState=${connection.socket.readyState}; close details unavailable).`,
        undefined,
        undefined,
        {
          connection: {
            source: "native-error",
            ...observeConnection(connection, role, phase),
          },
        },
      ),
    );
  };
  const closed = (event: CloseEvent) => {
    // Snapshot written requests before teardown clears them. Missing responses
    // do not establish whether the remote effects occurred or are safe to retry.
    const observation: CdpConnectionObservation = {
      source: "native-close",
      ...observeConnection(connection, role, phase),
      code: event.code,
      was_clean: event.wasClean,
    };
    addBreadcrumb({
      category: "browser.connection",
      level: "info",
      data: { ...observation },
    });
    wire.close(
      new CdpFault(
        "connection",
        `WebSocket closed (phase=${phase}, readyState=${connection.socket.readyState}, code=${event.code}, wasClean=${event.wasClean}).`,
        undefined,
        undefined,
        { connection: observation },
      ),
    );
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

function observeConnection(
  connection: Connection,
  role: ConnectionRole | undefined,
  phase: "before-open" | "after-open",
) {
  let cancelled = 0;
  for (const entry of connection.pending.values()) {
    if (entry.settled) {
      cancelled++;
    }
  }
  return {
    ...(role ? { role } : {}),
    phase: phase === "after-open" ? ("open" as const) : ("opening" as const),
    ready_state: connection.socket.readyState,
    pending_requests: connection.pending.size - cancelled,
    cancelled_awaiting_response: cancelled,
  };
}

/** HTTP renewal and incoming events are not receipts for an outstanding request. */
function observeDeadlines(
  connection: Connection,
  wire: Wire,
  signal: AbortSignal,
  role: ConnectionRole | undefined,
): void {
  const openingDeadline = now() + responseTimeoutMs;
  setLoop(
    () => {
      if (connection.failure) {
        return true;
      }
      const opening = !connection.opening.settled();
      const time = now();
      const expired = [...connection.pending.values()].find((entry) => {
        return time >= entry.deadline;
      });
      if ((opening && time >= openingDeadline) || expired) {
        // An unanswered write has an unknown outcome. Retire its original wire;
        // never retry it or let a late reply authorize a replacement connection.
        wire.close(
          new CdpFault(
            "connection",
            opening
              ? "The browser connection did not open in time. Reconnect the browser."
              : "The browser did not respond in time. Reconnect the browser.",
            undefined,
            expired ? Object.freeze({ method: expired.method }) : undefined,
            {
              connection: {
                source: opening ? "opening-timeout" : "response-timeout",
                ...observeConnection(
                  connection,
                  role,
                  opening ? "before-open" : "after-open",
                ),
              },
            },
          ),
        );
        return true;
      }
      return false;
    },
    1000,
    signal,
    { testIntervalMs: 10 },
  );
}

/** One mounted surface owns this native socket adapter and its protocol receipts. */
export function createCdpClient(
  url: string,
  options: {
    readonly factory?: SocketFactory;
    readonly role?: ConnectionRole;
  },
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
    opening: createDeferredPromise<void>({ rejection: "owner" }, signal),
    pending: new Map(),
    listeners: new Set(),
    closeListeners: new Set(),
    nextId: 1,
    failure: null,
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
  listen(connection, wire, signal, options.role);
  observeDeadlines(connection, wire, signal, options.role);
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
