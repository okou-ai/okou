import {
  context,
  ProxyTracerProvider,
  SpanStatusCode,
  type Tracer,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";

import {
  createInstrumentedPgStream,
  instrumentPgPool,
  withPgPoolAcquisitionCapture,
  withPgQueryExecutionCapture,
  type PgPoolAcquisition,
  type PgQueryExecution,
} from "../db-instrumentation";
import { env } from "../env";
import { withRequestRuntime, type RequestRuntime } from "../request-runtime";
import { settleIncludingAbort } from "../../signals/utils";

const ACQUIRE_DURATION_ATTRIBUTE = "vm0.db.pool.acquire.duration_ms";
const ACQUIRE_PATH_ATTRIBUTE = "vm0.db.pool.acquire.path";
const CONNECTION_LOOKUP_DURATION_ATTRIBUTE =
  "vm0.db.connection.lookup.duration_ms";
const CONNECTION_SOCKET_CONNECT_DURATION_ATTRIBUTE =
  "vm0.db.connection.socket_connect.duration_ms";
const CONNECTION_ATTEMPT_COUNT_ATTRIBUTE = "vm0.db.connection.attempt_count";
const CONNECTION_ATTEMPT_FAILED_COUNT_ATTRIBUTE =
  "vm0.db.connection.attempt_failed_count";
const CONNECTION_ATTEMPT_TIMEOUT_COUNT_ATTRIBUTE =
  "vm0.db.connection.attempt_timeout_count";
const CONNECTION_ADDRESS_FAMILY_ATTRIBUTE = "vm0.db.connection.address_family";

const CONNECTION_ATTRIBUTE_NAMES = [
  CONNECTION_LOOKUP_DURATION_ATTRIBUTE,
  CONNECTION_SOCKET_CONNECT_DURATION_ATTRIBUTE,
  CONNECTION_ATTEMPT_COUNT_ATTRIBUTE,
  CONNECTION_ATTEMPT_FAILED_COUNT_ATTRIBUTE,
  CONNECTION_ATTEMPT_TIMEOUT_COUNT_ATTRIBUTE,
  CONNECTION_ADDRESS_FAMILY_ATTRIBUTE,
] as const;

type AcquirePath = "idle" | "new" | "queued";

function expectAcquisition(span: ReadableSpan, path: AcquirePath): void {
  expect(span.attributes[ACQUIRE_PATH_ATTRIBUTE]).toBe(path);
  const duration = span.attributes[ACQUIRE_DURATION_ATTRIBUTE];
  expect(typeof duration).toBe("number");
  if (typeof duration !== "number") {
    throw new Error("Acquisition duration is not numeric");
  }
  expect(duration).toBeGreaterThanOrEqual(0);
}

function numericAttribute(
  span: ReadableSpan,
  name: string,
): number | undefined {
  const value = span.attributes[name];
  if (value === undefined) {
    return undefined;
  }
  expect(typeof value).toBe("number");
  if (typeof value !== "number") {
    throw new Error(`${name} is not numeric`);
  }
  return value;
}

function expectConnectionAcquisition(span: ReadableSpan): void {
  const socketConnectDuration = numericAttribute(
    span,
    CONNECTION_SOCKET_CONNECT_DURATION_ATTRIBUTE,
  );
  expect(socketConnectDuration).toBeDefined();
  if (socketConnectDuration === undefined) {
    throw new Error("Socket connect duration is missing");
  }
  expect(socketConnectDuration).toBeGreaterThanOrEqual(0);

  expect(span.attributes[CONNECTION_ADDRESS_FAMILY_ATTRIBUTE]).toMatch(
    /^ipv[46]$/,
  );

  const lookupDuration = numericAttribute(
    span,
    CONNECTION_LOOKUP_DURATION_ATTRIBUTE,
  );
  const attemptCount = numericAttribute(
    span,
    CONNECTION_ATTEMPT_COUNT_ATTRIBUTE,
  );
  const failedAttemptCount = numericAttribute(
    span,
    CONNECTION_ATTEMPT_FAILED_COUNT_ATTRIBUTE,
  );
  const timedOutAttemptCount = numericAttribute(
    span,
    CONNECTION_ATTEMPT_TIMEOUT_COUNT_ATTRIBUTE,
  );

  const optionalTelemetryObservation = {
    lookupDuration: {
      nonNegativeWhenPresent:
        lookupDuration === undefined || lookupDuration >= 0,
      noGreaterThanSocketConnectWhenPresent:
        lookupDuration === undefined || lookupDuration <= socketConnectDuration,
    },
    attemptCount: {
      integerWhenPresent:
        attemptCount === undefined || Number.isInteger(attemptCount),
      positiveWhenPresent: attemptCount === undefined || attemptCount > 0,
    },
    failedAttemptCount: {
      integerWhenPresent:
        failedAttemptCount === undefined ||
        Number.isInteger(failedAttemptCount),
      positiveWhenPresent:
        failedAttemptCount === undefined || failedAttemptCount > 0,
      attemptCountPresentWhenPresent:
        failedAttemptCount === undefined || attemptCount !== undefined,
      noGreaterThanAttemptCountWhenPresent:
        failedAttemptCount === undefined ||
        (attemptCount !== undefined && failedAttemptCount <= attemptCount),
    },
    timedOutAttemptCount: {
      integerWhenPresent:
        timedOutAttemptCount === undefined ||
        Number.isInteger(timedOutAttemptCount),
      positiveWhenPresent:
        timedOutAttemptCount === undefined || timedOutAttemptCount > 0,
      attemptCountPresentWhenPresent:
        timedOutAttemptCount === undefined || attemptCount !== undefined,
      noGreaterThanAttemptCountWhenPresent:
        timedOutAttemptCount === undefined ||
        (attemptCount !== undefined && timedOutAttemptCount <= attemptCount),
    },
  };

  expect(optionalTelemetryObservation).toStrictEqual({
    lookupDuration: {
      nonNegativeWhenPresent: true,
      noGreaterThanSocketConnectWhenPresent: true,
    },
    attemptCount: {
      integerWhenPresent: true,
      positiveWhenPresent: true,
    },
    failedAttemptCount: {
      integerWhenPresent: true,
      positiveWhenPresent: true,
      attemptCountPresentWhenPresent: true,
      noGreaterThanAttemptCountWhenPresent: true,
    },
    timedOutAttemptCount: {
      integerWhenPresent: true,
      positiveWhenPresent: true,
      attemptCountPresentWhenPresent: true,
      noGreaterThanAttemptCountWhenPresent: true,
    },
  });
}

function expectNoConnectionAcquisition(span: ReadableSpan): void {
  for (const name of CONNECTION_ATTRIBUTE_NAMES) {
    expect(span.attributes[name]).toBeUndefined();
  }
}

function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      return undefined;
    },
    (error: unknown) => {
      return error;
    },
  );
}

function createPgTestResources() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer("db-instrumentation-test");
  const runtimeTracer = provider.getTracer("worker-runtime-test");
  const pools: Pool[] = [];
  const releases = new Set<PoolClient["release"]>();
  const pending = new Set<Promise<unknown>>();
  let closing = false;
  let cleanup: Promise<void> | undefined;

  function requireOpen(): void {
    if (closing) {
      throw new Error("PG test resources are closing");
    }
  }

  function ownPendingWork(work: Promise<unknown>): void {
    pending.add(work);
    // Observe rejection immediately. Cleanup joins abandoned work without
    // masking the original outcome returned to the test by track().
    void work.then(
      () => {
        pending.delete(work);
      },
      () => {
        pending.delete(work);
      },
    );
  }

  function track<T>(work: Promise<T>): Promise<T> {
    ownPendingWork(work);
    return work;
  }

  function ownClient(
    client: PoolClient,
    originalRelease: PoolClient["release"] = client.release.bind(client),
  ) {
    let released = false;
    const release: PoolClient["release"] = (error) => {
      if (released) {
        return;
      }
      released = true;
      releases.delete(release);
      originalRelease(error);
    };
    releases.add(release);
    // A queued acquisition may arrive while timeout cleanup is draining work.
    if (closing) {
      release(true);
    }
    return { client, release };
  }

  function connect(pool: Pool) {
    requireOpen();
    return track(
      pool.connect().then((client) => {
        const lease = ownClient(client);
        requireOpen();
        return lease;
      }),
    );
  }

  function query(pool: Pool, statement: string) {
    requireOpen();
    return track(pool.query(statement));
  }

  function queryClient(client: PoolClient, statement: string) {
    requireOpen();
    return track(client.query(statement));
  }

  function close(): Promise<void> {
    cleanup ??= (async () => {
      closing = true;
      const failures: unknown[] = [];
      for (const release of releases) {
        const released = await settleIncludingAbort(() => {
          // Destroy outstanding leases so an in-flight direct query also ends.
          release(true);
        });
        if (!released.ok) {
          failures.push(released.error);
        }
      }
      await Promise.allSettled(pending);
      const ended = await Promise.allSettled(
        pools.map((pool) => {
          return pool.end();
        }),
      );
      for (const result of ended) {
        if (result.status === "rejected") {
          failures.push(result.reason);
        }
      }
      const shutdown = await settleIncludingAbort(() => {
        return provider.shutdown();
      });
      if (!shutdown.ok) {
        failures.push(shutdown.error);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "PG test resource cleanup failed");
      }
    })();
    return cleanup;
  }

  function createPool(
    config: PoolConfig = {},
    queryTracer: Tracer = tracer,
  ): Pool {
    requireOpen();
    const pool = instrumentPgPool(
      new Pool({
        allowExitOnIdle: true,
        connectionString: env("DATABASE_URL"),
        idleTimeoutMillis: 0,
        max: 1,
        ...config,
        stream: createInstrumentedPgStream,
      }),
      queryTracer,
    );
    pools.push(pool);
    return pool;
  }

  function findSpan(statement: string): ReadableSpan {
    const span = exporter.getFinishedSpans().find((candidate) => {
      return candidate.attributes["db.statement"] === statement;
    });
    if (!span) {
      throw new Error(`No span found for statement: ${statement}`);
    }
    return span;
  }

  function findNamedSpan(name: string): ReadableSpan {
    const span = exporter.getFinishedSpans().find((candidate) => {
      return candidate.name === name;
    });
    if (!span) {
      throw new Error(`No span found with name: ${name}`);
    }
    return span;
  }

  function runUnderParent<T>(
    parentName: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    requireOpen();
    return track(
      tracer.startActiveSpan(parentName, (span) => {
        return operation().finally(() => {
          span.end();
        });
      }),
    );
  }

  function runUnderWorkerRuntime<T>(operation: () => Promise<T>): Promise<T> {
    // Infrastructure exception: model only the platform-owned span factory.
    // Query execution and queued acquisition still use the real pg pool.
    const runtime: RequestRuntime = {
      nativeTelemetry: true,
      database() {
        throw new Error("Use the test-owned pg pool");
      },
      waitUntil: ownPendingWork,
      observeHttp() {},
      traceQuery(name, sql, execute) {
        return runtimeTracer.startActiveSpan(
          name,
          { attributes: { "db.statement": sql } },
          (span) => {
            return execute(span).finally(() => {
              span.end();
            });
          },
        );
      },
    };
    return track(withRequestRuntime(runtime, operation));
  }

  onTestFinished(close);
  return {
    exporter,
    createPool,
    connect,
    ownClient,
    query,
    queryClient,
    track,
    close,
    findSpan,
    findNamedSpan,
    runUnderParent,
    runUnderWorkerRuntime,
  };
}

describe("instrumentPgPool", () => {
  beforeAll(() => {
    const contextManager = new AsyncLocalStorageContextManager().enable();
    if (!context.setGlobalContextManager(contextManager)) {
      throw new Error(
        "Failed to install the global context manager for database instrumentation tests",
      );
    }
  });

  afterAll(() => {
    context.disable();
  });

  it("attributes new, idle, and queued acquisition to each query span", async () => {
    const pg = createPgTestResources();
    const pool = pg.createPool();
    const newStatement = "SELECT 101 AS new_path";
    const idleStatement = "SELECT 102 AS idle_path";
    const queuedStatement = "SELECT 103 AS queued_path";

    const newResult = await pg.query(pool, newStatement);
    const idleResult = await pg.query(pool, idleStatement);

    const heldClient = await pg.connect(pool);
    const queuedQuery = pg.query(pool, queuedStatement);
    const waitingCount = pool.waitingCount;
    heldClient.release();
    const queuedResult = await queuedQuery;

    expect(waitingCount).toBe(1);
    expect(newResult.rowCount).toBe(1);
    expect(idleResult.rowCount).toBe(1);
    expect(queuedResult.rowCount).toBe(1);
    const newSpan = pg.findSpan(newStatement);
    const idleSpan = pg.findSpan(idleStatement);
    const queuedSpan = pg.findSpan(queuedStatement);
    expectAcquisition(newSpan, "new");
    expectAcquisition(idleSpan, "idle");
    expectAcquisition(queuedSpan, "queued");
    expectConnectionAcquisition(newSpan);
    expectNoConnectionAcquisition(idleSpan);
    expectNoConnectionAcquisition(queuedSpan);
  });

  it("captures pool acquisition paths per concurrent manifest lookup", async () => {
    const pg = createPgTestResources();
    const pool = pg.createPool();
    const first = { acquisitions: [] as PgPoolAcquisition[] };
    const second = { acquisitions: [] as PgPoolAcquisition[] };

    await withPgPoolAcquisitionCapture(first, async () => {
      await pg.query(pool, "SELECT 401 AS captured_new");
      await pg.query(pool, "SELECT 402 AS captured_idle");
    });

    const heldClient = await pg.connect(pool);
    const firstQueued = pg.track(
      withPgPoolAcquisitionCapture(first, async () => {
        return await pg.query(pool, "SELECT 403 AS captured_first_queued");
      }),
    );
    const secondQueued = pg.track(
      withPgPoolAcquisitionCapture(second, async () => {
        return await pg.query(pool, "SELECT 404 AS captured_second_queued");
      }),
    );
    expect(pool.waitingCount).toBe(2);
    heldClient.release();
    await Promise.all([firstQueued, secondQueued]);

    expect(
      first.acquisitions.map(({ path }) => {
        return path;
      }),
    ).toStrictEqual(["new", "idle", "queued"]);
    expect(
      second.acquisitions.map(({ path }) => {
        return path;
      }),
    ).toStrictEqual(["queued"]);
    for (const acquisition of [...first.acquisitions, ...second.acquisitions]) {
      expect(Number.isFinite(acquisition.durationMs)).toBeTruthy();
      expect(acquisition.durationMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(acquisition.finishedAt)).toBeTruthy();
    }
  });

  it("captures pool acquisition without a recording query span", async () => {
    const pg = createPgTestResources();
    // A production API request cannot choose the process tracer; exercise this
    // infrastructure boundary with a real pool and a non-recording tracer.
    const pool = pg.createPool(
      {},
      new ProxyTracerProvider().getTracer("db-instrumentation-noop-test"),
    );
    const capture = { acquisitions: [] as PgPoolAcquisition[] };

    const result = await withPgPoolAcquisitionCapture(capture, async () => {
      return await pg.query(pool, "SELECT 405 AS captured_without_span");
    });

    expect(result.rowCount).toBe(1);
    expect(capture.acquisitions).toStrictEqual([
      {
        durationMs: expect.any(Number),
        path: "new",
        finishedAt: expect.any(Number),
      },
    ]);
    expect(pg.exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("isolates callback and Promise query captures across queued requests", async () => {
    const pg = createPgTestResources();
    // Infrastructure exception: real callers cannot select pg transport style
    // or the process tracer. Exercise both against one real, saturated pool.
    const pool = pg.createPool(
      {},
      new ProxyTracerProvider().getTracer("db-capture-noop-test"),
    );
    const firstPool = { acquisitions: [] as PgPoolAcquisition[] };
    const secondPool = { acquisitions: [] as PgPoolAcquisition[] };
    const firstQuery = { executions: [] as PgQueryExecution[] };
    const secondQuery = { executions: [] as PgQueryExecution[] };
    await withPgPoolAcquisitionCapture(firstPool, async () => {
      await withPgQueryExecutionCapture(firstQuery, async () => {
        await pg.query(pool, "SELECT 411 AS callback_capture");
      });
    });
    const heldClient = await pg.connect(pool);
    const first = pg.track(
      withPgPoolAcquisitionCapture(firstPool, async () => {
        return await withPgQueryExecutionCapture(firstQuery, async () => {
          const client = await pg.connect(pool);
          return await pg
            .queryClient(client.client, "SELECT 412 AS promise_capture")
            .finally(() => {
              client.release();
            });
        });
      }),
    );
    const second = pg.track(
      withPgPoolAcquisitionCapture(secondPool, async () => {
        return await withPgQueryExecutionCapture(secondQuery, async () => {
          return await pg.query(pool, "SELECT 413 AS second_callback_capture");
        });
      }),
    );
    const uncaptured = pg.query(pool, "SELECT 415 AS uncaptured_callback");
    const waitingCount = pool.waitingCount;
    heldClient.release();
    expect(waitingCount).toBe(3);
    const results = await Promise.all([first, second, uncaptured]);
    expect(
      results.map((result) => {
        return result.rowCount;
      }),
    ).toStrictEqual([1, 1, 1]);
    expect(
      firstPool.acquisitions.map((entry) => {
        return entry.path;
      }),
    ).toStrictEqual(["new", "queued"]);
    expect(
      secondPool.acquisitions.map((entry) => {
        return entry.path;
      }),
    ).toStrictEqual(["queued"]);
    expect(firstQuery.executions).toHaveLength(2);
    expect(secondQuery.executions).toHaveLength(1);
    for (const execution of [
      ...firstQuery.executions,
      ...secondQuery.executions,
    ]) {
      expect(Number.isFinite(execution.durationMs)).toBeTruthy();
      expect(execution.durationMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(execution.finishedAt)).toBeTruthy();
    }
    expect(pg.exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("captures failed Promise acquisition without inventing SQL execution", async () => {
    const pg = createPgTestResources();
    const pool = pg.createPool({ connectionTimeoutMillis: 25 });
    const heldClient = await pg.connect(pool);
    const capture = { acquisitions: [] as PgPoolAcquisition[] };
    const query = { executions: [] as PgQueryExecution[] };
    const error = await captureRejection(
      withPgPoolAcquisitionCapture(capture, async () => {
        return await withPgQueryExecutionCapture(query, async () => {
          return await pg.connect(pool);
        });
      }),
    );
    heldClient.release();
    expect(error).toHaveProperty(
      "message",
      "timeout exceeded when trying to connect",
    );
    expect(capture.acquisitions).toStrictEqual([
      {
        durationMs: expect.any(Number),
        path: "queued",
        finishedAt: expect.any(Number),
      },
    ]);
    expect(query.executions).toHaveLength(0);
    const recovered = await pg.query(
      pool,
      "SELECT 414 AS acquisition_recovered",
    );
    expect(recovered.rowCount).toBe(1);
  });

  it("reserves idle and new capacity for earlier synchronous queries", async () => {
    const pg = createPgTestResources();
    const pool = pg.createPool({ max: 2 });
    const warmStatement = "SELECT 104 AS warm_pool";
    const idleStatement = "SELECT 105 AS burst_idle";
    const newStatement = "SELECT 106 AS burst_new";
    const queuedStatement = "SELECT 107 AS burst_queued";

    await pg.query(pool, warmStatement);
    const idleQuery = pg.query(pool, idleStatement);
    const newQuery = pg.query(pool, newStatement);
    const queuedQuery = pg.query(pool, queuedStatement);
    const waitingCount = pool.waitingCount;

    const [idleResult, newResult, queuedResult] = await Promise.all([
      idleQuery,
      newQuery,
      queuedQuery,
    ]);

    expect(waitingCount).toBe(3);
    expect(idleResult.rowCount).toBe(1);
    expect(newResult.rowCount).toBe(1);
    expect(queuedResult.rowCount).toBe(1);
    expectAcquisition(pg.findSpan(warmStatement), "new");
    expectAcquisition(pg.findSpan(idleStatement), "idle");
    expectAcquisition(pg.findSpan(newStatement), "new");
    expectAcquisition(pg.findSpan(queuedStatement), "queued");
  });

  it("classifies replacement connections while older queries remain queued", async () => {
    const pg = createPgTestResources();
    const pool = pg.createPool({ max: 2 });
    const clientA = await pg.connect(pool);
    const clientB = await pg.connect(pool);
    const queuedStatementA = "SELECT 108 AS replacement_queue_a";
    const queuedStatementB = "SELECT 109 AS replacement_queue_b";
    const replacementStatement = "SELECT 110 AS replacement_new";

    const queuedQueryA = pg.query(pool, queuedStatementA);
    const queuedQueryB = pg.query(pool, queuedStatementB);
    clientA.release(new Error("retire test client"));

    expect(pool.totalCount).toBe(1);
    expect(pool.idleCount).toBe(0);
    expect(pool.waitingCount).toBe(2);
    const replacementQuery = pg.query(pool, replacementStatement);
    clientB.release();

    const [queuedResultA, queuedResultB, replacementResult] = await Promise.all(
      [queuedQueryA, queuedQueryB, replacementQuery],
    );

    expect(queuedResultA.rowCount).toBe(1);
    expect(queuedResultB.rowCount).toBe(1);
    expect(replacementResult.rowCount).toBe(1);
    expectAcquisition(pg.findSpan(queuedStatementA), "queued");
    expectAcquisition(pg.findSpan(queuedStatementB), "queued");
    expectAcquisition(pg.findSpan(replacementStatement), "new");
  });

  it("keeps concurrent queued measurements on their originating traces", async () => {
    const pg = createPgTestResources();
    const pool = pg.createPool();
    const heldClient = await pg.connect(pool);
    const statementA = "SELECT 201 AS queued_a";
    const statementB = "SELECT 202 AS queued_b";

    const queryA = pg.runUnderParent("parent-a", () => {
      return pg.query(pool, statementA);
    });
    const queryB = pg.runUnderParent("parent-b", () => {
      return pg.query(pool, statementB);
    });
    const waitingCount = pool.waitingCount;

    heldClient.release();
    await Promise.all([queryA, queryB]);

    expect(waitingCount).toBe(2);
    const spanA = pg.findSpan(statementA);
    const spanB = pg.findSpan(statementB);
    const parentA = pg.findNamedSpan("parent-a");
    const parentB = pg.findNamedSpan("parent-b");
    expectAcquisition(spanA, "queued");
    expectAcquisition(spanB, "queued");
    expect(spanA.spanContext().traceId).toBe(parentA.spanContext().traceId);
    expect(spanA.parentSpanContext?.spanId).toBe(parentA.spanContext().spanId);
    expect(spanB.spanContext().traceId).toBe(parentB.spanContext().traceId);
    expect(spanB.parentSpanContext?.spanId).toBe(parentB.spanContext().spanId);
    expect(parentA.spanContext().traceId).not.toBe(
      parentB.spanContext().traceId,
    );
  });

  it("preserves acquisition measurements on Workers query spans", async () => {
    const pg = createPgTestResources();
    const pool = pg.createPool();
    const warmStatement = "SELECT 501 AS worker_new";
    const idleStatement = "SELECT 502 AS worker_idle";
    const queuedStatementA = "SELECT 503 AS worker_queued_a";
    const queuedStatementB = "SELECT 504 AS worker_queued_b";

    await pg.runUnderWorkerRuntime(() => {
      return pg.query(pool, warmStatement);
    });
    await pg.runUnderWorkerRuntime(() => {
      return pg.query(pool, idleStatement);
    });
    const heldClient = await pg.connect(pool);
    const queryA = pg.runUnderWorkerRuntime(() => {
      return pg.query(pool, queuedStatementA);
    });
    const queryB = pg.runUnderWorkerRuntime(() => {
      return pg.query(pool, queuedStatementB);
    });
    const waitingCount = pool.waitingCount;
    heldClient.release();
    const results = await Promise.all([queryA, queryB]);

    expect(waitingCount).toBe(2);
    expect(
      results.map((result) => {
        return result.rowCount;
      }),
    ).toStrictEqual([1, 1]);
    expectAcquisition(pg.findSpan(warmStatement), "new");
    expectAcquisition(pg.findSpan(idleStatement), "idle");
    expectAcquisition(pg.findSpan(queuedStatementA), "queued");
    expectAcquisition(pg.findSpan(queuedStatementB), "queued");
    const spans = pg.exporter.getFinishedSpans();
    expect(spans).toHaveLength(4);
    expect(
      spans.every((span) => {
        return span.instrumentationScope.name === "worker-runtime-test";
      }),
    ).toBeTruthy();
  });

  it("retains Workers acquisition failures and allows the next query", async () => {
    const pg = createPgTestResources();
    const pool = pg.createPool({ connectionTimeoutMillis: 25 });
    const heldClient = await pg.connect(pool);
    const timeoutStatement = "SELECT 505 AS worker_acquisition_timeout";
    const recoveryStatement = "SELECT 506 AS worker_recovered";

    const error = await captureRejection(
      pg.runUnderWorkerRuntime(() => {
        return pg.query(pool, timeoutStatement);
      }),
    );
    heldClient.release();
    const recovered = await pg.runUnderWorkerRuntime(() => {
      return pg.query(pool, recoveryStatement);
    });

    expect(error).toHaveProperty(
      "message",
      "timeout exceeded when trying to connect",
    );
    expect(recovered.rowCount).toBe(1);
    expectAcquisition(pg.findSpan(timeoutStatement), "queued");
    expectAcquisition(pg.findSpan(recoveryStatement), "idle");
    expect(pg.exporter.getFinishedSpans()).toHaveLength(2);
  });

  it("preserves acquisition and query failures and releases clients", async () => {
    const pg = createPgTestResources();
    const timeoutPool = pg.createPool({ connectionTimeoutMillis: 25 });
    const heldClient = await pg.connect(timeoutPool);
    const timeoutStatement = "SELECT 301 AS acquisition_timeout";
    const timeoutCapture = { acquisitions: [] as PgPoolAcquisition[] };

    const timeoutError = await captureRejection(
      withPgPoolAcquisitionCapture(timeoutCapture, async () => {
        return await pg.query(timeoutPool, timeoutStatement);
      }),
    );
    heldClient.release();

    expect(timeoutError).toBeInstanceOf(Error);
    expect(timeoutError).toHaveProperty(
      "message",
      "timeout exceeded when trying to connect",
    );
    const timeoutSpan = pg.findSpan(timeoutStatement);
    expect(timeoutSpan.status.code).toBe(SpanStatusCode.ERROR);
    expectAcquisition(timeoutSpan, "queued");
    expect(timeoutCapture.acquisitions).toStrictEqual([
      {
        durationMs: expect.any(Number),
        path: "queued",
        finishedAt: expect.any(Number),
      },
    ]);

    const failurePool = pg.createPool();
    const invalidStatement =
      "SELECT * FROM okou_missing_db_instrumentation_table";
    const recoveryStatement = "SELECT 302 AS recovered";
    const failureCapture = { executions: [] as PgQueryExecution[] };
    const queryError = await captureRejection(
      withPgQueryExecutionCapture(failureCapture, async () => {
        return await pg.query(failurePool, invalidStatement);
      }),
    );
    const client = await pg.connect(failurePool);
    const directError = await captureRejection(
      withPgQueryExecutionCapture(failureCapture, async () => {
        return await pg.queryClient(client.client, invalidStatement);
      }).finally(() => {
        client.release();
      }),
    );
    expect(directError).toBeInstanceOf(Error);
    expect(failureCapture.executions).toHaveLength(2);
    const recoveryResult = await pg.query(failurePool, recoveryStatement);

    expect(queryError).toBeInstanceOf(Error);
    expect(recoveryResult.rowCount).toBe(1);
    const failureSpan = pg.findSpan(invalidStatement);
    expect(failureSpan.status.code).toBe(SpanStatusCode.ERROR);
    expectAcquisition(failureSpan, "new");
    expectAcquisition(pg.findSpan(recoveryStatement), "idle");
  });

  it("preserves direct callbacks and instruments reused clients only once", async () => {
    const pg = createPgTestResources();
    const pool = pg.createPool();
    let callbackError: Error | undefined;
    let callbackClient: PoolClient | undefined;
    const callbackReturn = pool.connect((error, client, release) => {
      if (error) {
        callbackError = error;
        return;
      }
      if (!client || !release) {
        callbackError = new Error("Pool callback did not return a client");
        return;
      }
      callbackClient = client;
      pg.ownClient(client, release).release();
    });

    const statementA = "SELECT 401 AS reused_a";
    const statementB = "SELECT 402 AS reused_b";
    // With max: 1, this checkout cannot resolve until the callback above has
    // received and released the sole client.
    const clientA = await pg.connect(pool);
    const resultA = await pg.queryClient(clientA.client, statementA);
    clientA.release();

    const clientB = await pg.connect(pool);
    const sameClient = clientB.client === clientA.client;
    const resultB = await pg.queryClient(clientB.client, statementB);
    clientB.release();

    expect(callbackReturn).toBeUndefined();
    expect(callbackError).toBeUndefined();
    expect(callbackClient).toBe(clientA.client);
    expect(sameClient).toBeTruthy();
    expect(resultA.rowCount).toBe(1);
    expect(resultB.rowCount).toBe(1);
    expect(
      pg.exporter.getFinishedSpans().filter((span) => {
        return span.attributes["db.statement"] === statementA;
      }),
    ).toHaveLength(1);
    expect(
      pg.exporter.getFinishedSpans().filter((span) => {
        return span.attributes["db.statement"] === statementB;
      }),
    ).toHaveLength(1);
    expect(
      pg.findSpan(statementA).attributes[ACQUIRE_PATH_ATTRIBUTE],
    ).toBeUndefined();
    expect(
      pg.findSpan(statementB).attributes[ACQUIRE_PATH_ATTRIBUTE],
    ).toBeUndefined();
  });

  it("releases abandoned checkouts and drains queued queries before shutdown", async () => {
    // The infrastructure owner must survive an early exit, including a
    // successful checkout discarded by a test expecting acquisition failure.
    const pg = createPgTestResources();
    const pool = pg.createPool({ max: 2 });
    const held = await pg.connect(pool);
    await captureRejection(pg.connect(pool));
    const queued = pg.query(pool, "SELECT 416 AS cleanup_queued");

    const closed = pg.close();
    await expect(queued).resolves.toHaveProperty("rowCount", 1);
    await closed;
    expect(() => {
      held.release();
    }).not.toThrow();
    await pg.close();
    await expect(pool.connect()).rejects.toThrow(
      "Cannot use a pool after calling end on the pool",
    );
  });

  it("releases a queued checkout delivered after cleanup starts", async () => {
    const pg = createPgTestResources();
    const pool = pg.createPool();
    await pg.connect(pool);
    const queued = pg.connect(pool);

    const closed = pg.close();
    await expect(queued).rejects.toThrow("PG test resources are closing");
    await closed;
    await expect(pool.connect()).rejects.toThrow(
      "Cannot use a pool after calling end on the pool",
    );
  });
});
