import { AsyncLocalStorage } from "node:async_hooks";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { Socket, type LookupFunction, type SocketConnectOpts } from "node:net";
import { performance } from "node:perf_hooks";

import {
  context,
  createContextKey,
  SpanKind,
  SpanStatusCode,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { createStore, state } from "ccstate";
import type { Pool, PoolClient } from "pg";

import { singleton } from "./singleton";
import { deriveSqlSpanName } from "./sql-span-name";

const POOL_QUERY_SPAN_KEY = createContextKey("vm0.pg.pool-query-span");
const POOL_ACQUIRE_DURATION_ATTRIBUTE = "vm0.db.pool.acquire.duration_ms";
const POOL_ACQUIRE_PATH_ATTRIBUTE = "vm0.db.pool.acquire.path";
const CONNECTION_LOOKUP_DURATION_ATTRIBUTE =
  "vm0.db.connection.lookup.duration_ms";
const CONNECTION_LOOKUP_HEDGED_ATTRIBUTE = "vm0.db.connection.lookup.hedged";
const CONNECTION_LOOKUP_HEDGE_BUDGET_UNAVAILABLE_ATTRIBUTE =
  "vm0.db.connection.lookup.hedge_budget_unavailable";
const CONNECTION_LOOKUP_SOURCE_ATTRIBUTE = "vm0.db.connection.lookup.source";
const CONNECTION_SOCKET_CONNECT_DURATION_ATTRIBUTE =
  "vm0.db.connection.socket_connect.duration_ms";
const CONNECTION_ATTEMPT_COUNT_ATTRIBUTE = "vm0.db.connection.attempt_count";
const CONNECTION_ATTEMPT_FAILED_COUNT_ATTRIBUTE =
  "vm0.db.connection.attempt_failed_count";
const CONNECTION_ATTEMPT_TIMEOUT_COUNT_ATTRIBUTE =
  "vm0.db.connection.attempt_timeout_count";
const CONNECTION_ADDRESS_FAMILY_ATTRIBUTE = "vm0.db.connection.address_family";
const LOOKUP_HEDGE_DELAY_MS = 150;

type AnyArgs = readonly unknown[];
type PgQuery = (...args: AnyArgs) => unknown;
type PoolAcquirePath = "idle" | "new" | "queued";
export interface PgPoolAcquisition {
  readonly durationMs: number;
  readonly path: PoolAcquirePath;
}

export interface PgPoolAcquisitionCapture {
  readonly acquisitions: PgPoolAcquisition[];
}

const scopedPgPoolAcquisitionCapture = singleton(() => {
  return new AsyncLocalStorage<PgPoolAcquisitionCapture>();
});

export async function withPgPoolAcquisitionCapture<T>(
  capture: PgPoolAcquisitionCapture,
  operation: () => Promise<T>,
): Promise<T> {
  return await scopedPgPoolAcquisitionCapture().run(capture, operation);
}

type PoolRelease = (error?: Error | boolean) => void;
type PoolConnectCallback = (
  error: Error | undefined,
  client?: PoolClient,
  release?: PoolRelease,
) => void;
type LookupSource = "primary" | "secondary";

interface InstrumentedPgStreamOptions {
  lookup?: LookupFunction;
  lookupHedgeDelayMs?: number;
}

const systemLookup: LookupFunction = dnsLookup;
const secondaryLookupInFlight$ = state(false);
const lookupHedgeStore = createStore();

class PoolQuerySpan {
  constructor(readonly span: Span) {}
}

function claimSecondaryLookup(): boolean {
  if (lookupHedgeStore.get(secondaryLookupInFlight$)) {
    return false;
  }
  lookupHedgeStore.set(secondaryLookupInFlight$, true);
  return true;
}

function releaseSecondaryLookup(): void {
  lookupHedgeStore.set(secondaryLookupInFlight$, false);
}

function createHedgedLookup(
  socket: Socket,
  lookup: LookupFunction,
  hedgeDelayMs: number,
  querySpan: Span | undefined,
): LookupFunction {
  return function hedgedLookup(hostname, options, callback): void {
    let delivered = false;
    let primarySettled = false;
    let secondaryStarted = false;
    let secondarySettled = false;
    let holdsHedgeBudget = false;
    let hedgeDelayController: AbortController | undefined;

    function removePendingHedgeListeners(): void {
      socket.removeListener("close", cancelPendingHedge);
      socket.removeListener("timeout", cancelPendingHedge);
    }

    function cancelPendingHedge(): void {
      hedgeDelayController?.abort();
      hedgeDelayController = undefined;
      removePendingHedgeListeners();
    }

    function releaseHedgeBudget(): void {
      if (holdsHedgeBudget && primarySettled && secondarySettled) {
        holdsHedgeBudget = false;
        releaseSecondaryLookup();
      }
    }

    function deliver(
      source: LookupSource,
      error: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ): void {
      if (delivered) {
        return;
      }
      delivered = true;
      cancelPendingHedge();
      if (secondaryStarted) {
        querySpan?.setAttribute(CONNECTION_LOOKUP_SOURCE_ATTRIBUTE, source);
      }
      callback(error, address, family);
    }

    function onPrimaryLookup(
      error: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ): void {
      primarySettled = true;
      releaseHedgeBudget();
      deliver("primary", error, address, family);
    }

    function onSecondaryLookup(
      error: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ): void {
      secondarySettled = true;
      releaseHedgeBudget();
      if (error === null) {
        deliver("secondary", error, address, family);
      }
    }

    function startSecondaryLookup(): void {
      hedgeDelayController = undefined;
      removePendingHedgeListeners();
      if (primarySettled || socket.destroyed || !socket.connecting) {
        return;
      }
      if (!claimSecondaryLookup()) {
        querySpan?.setAttribute(
          CONNECTION_LOOKUP_HEDGE_BUDGET_UNAVAILABLE_ATTRIBUTE,
          true,
        );
        return;
      }

      holdsHedgeBudget = true;
      secondaryStarted = true;
      querySpan?.setAttribute(CONNECTION_LOOKUP_HEDGED_ATTRIBUTE, true);
      lookup(hostname, options, onSecondaryLookup);
    }

    lookup(hostname, options, onPrimaryLookup);
    if (primarySettled || socket.destroyed || !socket.connecting) {
      return;
    }

    socket.once("close", cancelPendingHedge);
    socket.once("timeout", cancelPendingHedge);
    const delayController = new AbortController();
    hedgeDelayController = delayController;
    const delaySignal = AbortSignal.any([
      delayController.signal,
      AbortSignal.timeout(hedgeDelayMs),
    ]);
    delaySignal.addEventListener(
      "abort",
      () => {
        if (!delayController.signal.aborted) {
          startSecondaryLookup();
        }
      },
      { once: true },
    );
  };
}

class InstrumentedPgSocket extends Socket {
  constructor(
    private readonly lookup: LookupFunction,
    private readonly lookupHedgeDelayMs: number,
    private readonly querySpan: Span | undefined,
  ) {
    super();
  }

  override connect(
    options: SocketConnectOpts,
    connectionListener?: () => void,
  ): this;
  override connect(
    port: number,
    host: string,
    connectionListener?: () => void,
  ): this;
  override connect(port: number, connectionListener?: () => void): this;
  override connect(path: string, connectionListener?: () => void): this;
  override connect(
    optionsOrPortOrPath: SocketConnectOpts | number | string,
    hostOrListener?: string | (() => void),
    connectionListener?: () => void,
  ): this {
    if (typeof optionsOrPortOrPath === "number") {
      if (typeof hostOrListener === "string") {
        return super.connect(
          {
            port: optionsOrPortOrPath,
            host: hostOrListener,
            lookup: createHedgedLookup(
              this,
              this.lookup,
              this.lookupHedgeDelayMs,
              this.querySpan,
            ),
          },
          connectionListener,
        );
      }
      if (hostOrListener) {
        return super.connect(optionsOrPortOrPath, hostOrListener);
      }
      return super.connect(optionsOrPortOrPath);
    }

    if (typeof optionsOrPortOrPath === "string") {
      if (typeof hostOrListener === "function") {
        return super.connect(optionsOrPortOrPath, hostOrListener);
      }
      return super.connect(optionsOrPortOrPath);
    }

    if (typeof hostOrListener === "function") {
      return super.connect(optionsOrPortOrPath, hostOrListener);
    }
    return super.connect(optionsOrPortOrPath);
  }
}

function normalizeAddressFamily(
  family: string | undefined,
): "ipv4" | "ipv6" | undefined {
  if (family === "IPv4") {
    return "ipv4";
  }
  if (family === "IPv6") {
    return "ipv6";
  }
  return undefined;
}

export function createInstrumentedPgStream(
  options: InstrumentedPgStreamOptions = {},
): Socket {
  const markedSpan = context.active().getValue(POOL_QUERY_SPAN_KEY);
  const querySpan =
    markedSpan instanceof PoolQuerySpan && markedSpan.span.isRecording()
      ? markedSpan.span
      : undefined;
  const socket = new InstrumentedPgSocket(
    options.lookup ?? systemLookup,
    options.lookupHedgeDelayMs ?? LOOKUP_HEDGE_DELAY_MS,
    querySpan,
  );
  if (!querySpan) {
    return socket;
  }
  const recordingSpan = querySpan;

  const startedAt = performance.now();
  let attemptCount = 0;
  let failedAttemptCount = 0;
  let timedOutAttemptCount = 0;

  function onLookup(): void {
    recordingSpan.setAttribute(
      CONNECTION_LOOKUP_DURATION_ATTRIBUTE,
      performance.now() - startedAt,
    );
  }

  function onConnectionAttempt(): void {
    attemptCount += 1;
    recordingSpan.setAttribute(
      CONNECTION_ATTEMPT_COUNT_ATTRIBUTE,
      attemptCount,
    );
  }

  function onConnectionAttemptFailed(): void {
    failedAttemptCount += 1;
    recordingSpan.setAttribute(
      CONNECTION_ATTEMPT_FAILED_COUNT_ATTRIBUTE,
      failedAttemptCount,
    );
  }

  function onConnectionAttemptTimeout(): void {
    timedOutAttemptCount += 1;
    recordingSpan.setAttribute(
      CONNECTION_ATTEMPT_TIMEOUT_COUNT_ATTRIBUTE,
      timedOutAttemptCount,
    );
  }

  function removePhaseListeners(): void {
    socket.removeListener("lookup", onLookup);
    socket.removeListener("connectionAttempt", onConnectionAttempt);
    socket.removeListener("connectionAttemptFailed", onConnectionAttemptFailed);
    socket.removeListener(
      "connectionAttemptTimeout",
      onConnectionAttemptTimeout,
    );
    socket.removeListener("connect", onConnect);
    socket.removeListener("close", removePhaseListeners);
  }

  function onConnect(): void {
    recordingSpan.setAttribute(
      CONNECTION_SOCKET_CONNECT_DURATION_ATTRIBUTE,
      performance.now() - startedAt,
    );
    const addressFamily = normalizeAddressFamily(socket.remoteFamily);
    if (addressFamily) {
      recordingSpan.setAttribute(
        CONNECTION_ADDRESS_FAMILY_ATTRIBUTE,
        addressFamily,
      );
    }
    removePhaseListeners();
  }

  socket.once("lookup", onLookup);
  socket.on("connectionAttempt", onConnectionAttempt);
  socket.on("connectionAttemptFailed", onConnectionAttemptFailed);
  socket.on("connectionAttemptTimeout", onConnectionAttemptTimeout);
  socket.once("connect", onConnect);
  socket.once("close", removePhaseListeners);

  return socket;
}

function extractSql(args: AnyArgs): string {
  const first = args[0];
  if (typeof first === "string") {
    return first;
  }
  if (
    first &&
    typeof first === "object" &&
    "text" in first &&
    typeof first.text === "string"
  ) {
    return first.text;
  }
  return "pg.query";
}

function acquisitionPath(pool: Pool): PoolAcquirePath {
  // With no idle client, pg-pool either starts a connection immediately or
  // queues solely based on whether the pool is full. This can leapfrog older
  // waiters while a removed client is still closing.
  if (pool.idleCount === 0) {
    return pool.totalCount < pool.options.max ? "new" : "queued";
  }

  // Idle delivery is deferred to the next tick, so a synchronous burst can
  // observe the same idle clients before earlier waiters receive them. Treat
  // waitingCount as the new request's zero-based position and reserve both
  // idle clients and remaining connection slots for earlier requests.
  const position = pool.waitingCount;
  if (position < pool.idleCount) {
    return "idle";
  }
  const availableClientCount =
    pool.idleCount + pool.options.max - pool.totalCount;
  if (position < availableClientCount) {
    return "new";
  }
  return "queued";
}

function isPoolConnectCallback(value: unknown): value is PoolConnectCallback {
  return typeof value === "function";
}

function instrumentQuery(
  target: object,
  original: PgQuery,
  tracer: Tracer,
  markPoolQuery: boolean,
): PgQuery {
  return function instrumentedQuery(this: unknown, ...args: AnyArgs): unknown {
    // pg query is overloaded: when the caller passes a trailing callback
    // (pool.query does this internally to drive client.query), the result is
    // undefined and the callback is the only completion signal. The outer
    // pool query already produced a span, so pass callback-style client
    // queries straight through.
    if (typeof args[args.length - 1] === "function") {
      return Reflect.apply(original, target, args);
    }

    const sql = extractSql(args);
    const spanName = deriveSqlSpanName(sql) ?? "pg.query";
    return tracer.startActiveSpan(
      spanName,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "db.system": "postgresql",
          "db.statement": sql,
        },
      },
      (span) => {
        // Pool-level queries mark their exact outer span while pg-pool
        // synchronously calls connect(callback). The callback may run much
        // later, so acquisition instrumentation captures this marked span at
        // connect entry instead of looking up whichever request context is
        // active when a queued client finally becomes available.
        const execute = (): Promise<unknown> => {
          return Reflect.apply(original, target, args) as Promise<unknown>;
        };
        const query =
          markPoolQuery && span.isRecording()
            ? context.with(
                context
                  .active()
                  .setValue(POOL_QUERY_SPAN_KEY, new PoolQuerySpan(span)),
                execute,
              )
            : execute();

        // The span parents to whatever request span is active when the query
        // starts. Slice DB spans by route via a trace_id join to the Hono
        // server span; never copy request-scoped attributes onto pooled
        // client spans.
        return query
          .then(
            (result) => {
              span.setStatus({ code: SpanStatusCode.OK });
              return result;
            },
            (error: unknown) => {
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: error instanceof Error ? error.message : String(error),
              });
              span.recordException(
                error instanceof Error ? error : String(error),
              );
              throw error;
            },
          )
          .finally(() => {
            span.end();
          });
      },
    );
  } as PgQuery;
}

export function instrumentPgPool(pool: Pool, tracer: Tracer): Pool {
  const originalQuery = pool.query.bind(pool) as PgQuery;
  pool.query = instrumentQuery(
    pool,
    originalQuery,
    tracer,
    true,
  ) as Pool["query"];

  const instrumentedClients = new WeakSet<PoolClient>();
  const originalConnect = pool.connect.bind(pool);
  pool.connect = function patchedConnect(...args: AnyArgs) {
    const callback = args[args.length - 1];
    if (isPoolConnectCallback(callback)) {
      const markedSpan = context.active().getValue(POOL_QUERY_SPAN_KEY);
      const capture = scopedPgPoolAcquisitionCapture.peek()?.getStore();
      if (!(markedSpan instanceof PoolQuerySpan) && !capture) {
        return Reflect.apply(originalConnect, pool, args);
      }

      const startedAt = performance.now();
      const path = acquisitionPath(pool);
      const wrappedCallback: PoolConnectCallback = (error, client, release) => {
        const durationMs = performance.now() - startedAt;
        if (markedSpan instanceof PoolQuerySpan) {
          markedSpan.span.setAttributes({
            [POOL_ACQUIRE_DURATION_ATTRIBUTE]: durationMs,
            [POOL_ACQUIRE_PATH_ATTRIBUTE]: path,
          });
        }
        capture?.acquisitions.push({ durationMs, path });
        callback(error, client, release);
      };
      const wrappedArgs = [...args.slice(0, -1), wrappedCallback] as const;
      return Reflect.apply(originalConnect, pool, wrappedArgs);
    }

    const promise = Reflect.apply(
      originalConnect,
      pool,
      args,
    ) as Promise<PoolClient>;
    return promise.then((client) => {
      if (instrumentedClients.has(client)) {
        return client;
      }
      const clientQuery = client.query.bind(client) as PgQuery;
      client.query = instrumentQuery(
        client,
        clientQuery,
        tracer,
        false,
      ) as PoolClient["query"];
      instrumentedClients.add(client);
      return client;
    });
  } as Pool["connect"];

  return pool;
}
