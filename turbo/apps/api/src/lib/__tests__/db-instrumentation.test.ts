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
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  createInstrumentedPgStream,
  instrumentPgPool,
  withPgPoolAcquisitionCapture,
} from "../db-instrumentation";
import { env } from "../env";

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

describe("instrumentPgPool", () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let tracer: Tracer;
  let pools: Pool[];

  function createPool(
    config: PoolConfig = {},
    queryTracer: Tracer = tracer,
  ): Pool {
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
    return tracer.startActiveSpan(parentName, (span) => {
      return operation().finally(() => {
        span.end();
      });
    });
  }

  beforeAll(() => {
    const contextManager = new AsyncLocalStorageContextManager().enable();
    if (!context.setGlobalContextManager(contextManager)) {
      throw new Error(
        "Failed to install the global context manager for database instrumentation tests",
      );
    }
  });

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    tracer = provider.getTracer("db-instrumentation-test");
    pools = [];
  });

  afterEach(async () => {
    await Promise.all(
      pools.map((pool) => {
        return pool.end();
      }),
    );
    await provider.shutdown();
  });

  afterAll(() => {
    context.disable();
  });

  it("attributes new, idle, and queued acquisition to each query span", async () => {
    const pool = createPool();
    const newStatement = "SELECT 101 AS new_path";
    const idleStatement = "SELECT 102 AS idle_path";
    const queuedStatement = "SELECT 103 AS queued_path";

    const newResult = await pool.query(newStatement);
    const idleResult = await pool.query(idleStatement);

    const heldClient = await pool.connect();
    const queuedQuery = pool.query(queuedStatement);
    const waitingCount = pool.waitingCount;
    heldClient.release();
    const queuedResult = await queuedQuery;

    expect(waitingCount).toBe(1);
    expect(newResult.rowCount).toBe(1);
    expect(idleResult.rowCount).toBe(1);
    expect(queuedResult.rowCount).toBe(1);
    const newSpan = findSpan(newStatement);
    const idleSpan = findSpan(idleStatement);
    const queuedSpan = findSpan(queuedStatement);
    expectAcquisition(newSpan, "new");
    expectAcquisition(idleSpan, "idle");
    expectAcquisition(queuedSpan, "queued");
    expectConnectionAcquisition(newSpan);
    expectNoConnectionAcquisition(idleSpan);
    expectNoConnectionAcquisition(queuedSpan);
  });

  it("captures pool acquisition paths per concurrent manifest lookup", async () => {
    const pool = createPool();
    const first = {
      acquisitions: [] as { durationMs: number; path: AcquirePath }[],
    };
    const second = {
      acquisitions: [] as { durationMs: number; path: AcquirePath }[],
    };

    await withPgPoolAcquisitionCapture(first, async () => {
      await pool.query("SELECT 401 AS captured_new");
      await pool.query("SELECT 402 AS captured_idle");
    });

    const heldClient = await pool.connect();
    const firstQueued = withPgPoolAcquisitionCapture(first, async () => {
      return await pool.query("SELECT 403 AS captured_first_queued");
    });
    const secondQueued = withPgPoolAcquisitionCapture(second, async () => {
      return await pool.query("SELECT 404 AS captured_second_queued");
    });
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
    }
  });

  it("captures pool acquisition without a recording query span", async () => {
    // A production API request cannot choose the process tracer; exercise this
    // infrastructure boundary with a real pool and a non-recording tracer.
    const pool = createPool(
      {},
      new ProxyTracerProvider().getTracer("db-instrumentation-noop-test"),
    );
    const capture = {
      acquisitions: [] as { durationMs: number; path: AcquirePath }[],
    };

    const result = await withPgPoolAcquisitionCapture(capture, async () => {
      return await pool.query("SELECT 405 AS captured_without_span");
    });

    expect(result.rowCount).toBe(1);
    expect(capture.acquisitions).toStrictEqual([
      { durationMs: expect.any(Number), path: "new" },
    ]);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("reserves idle and new capacity for earlier synchronous queries", async () => {
    const pool = createPool({ max: 2 });
    const warmStatement = "SELECT 104 AS warm_pool";
    const idleStatement = "SELECT 105 AS burst_idle";
    const newStatement = "SELECT 106 AS burst_new";
    const queuedStatement = "SELECT 107 AS burst_queued";

    await pool.query(warmStatement);
    const idleQuery = pool.query(idleStatement);
    const newQuery = pool.query(newStatement);
    const queuedQuery = pool.query(queuedStatement);
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
    expectAcquisition(findSpan(warmStatement), "new");
    expectAcquisition(findSpan(idleStatement), "idle");
    expectAcquisition(findSpan(newStatement), "new");
    expectAcquisition(findSpan(queuedStatement), "queued");
  });

  it("classifies replacement connections while older queries remain queued", async () => {
    const pool = createPool({ max: 2 });
    const clientA = await pool.connect();
    const clientB = await pool.connect();
    const queuedStatementA = "SELECT 108 AS replacement_queue_a";
    const queuedStatementB = "SELECT 109 AS replacement_queue_b";
    const replacementStatement = "SELECT 110 AS replacement_new";

    const queuedQueryA = pool.query(queuedStatementA);
    const queuedQueryB = pool.query(queuedStatementB);
    clientA.release(new Error("retire test client"));

    expect(pool.totalCount).toBe(1);
    expect(pool.idleCount).toBe(0);
    expect(pool.waitingCount).toBe(2);
    const replacementQuery = pool.query(replacementStatement);
    clientB.release();

    const [queuedResultA, queuedResultB, replacementResult] = await Promise.all(
      [queuedQueryA, queuedQueryB, replacementQuery],
    );

    expect(queuedResultA.rowCount).toBe(1);
    expect(queuedResultB.rowCount).toBe(1);
    expect(replacementResult.rowCount).toBe(1);
    expectAcquisition(findSpan(queuedStatementA), "queued");
    expectAcquisition(findSpan(queuedStatementB), "queued");
    expectAcquisition(findSpan(replacementStatement), "new");
  });

  it("keeps concurrent queued measurements on their originating traces", async () => {
    const pool = createPool();
    const heldClient = await pool.connect();
    const statementA = "SELECT 201 AS queued_a";
    const statementB = "SELECT 202 AS queued_b";

    const queryA = runUnderParent("parent-a", () => {
      return pool.query(statementA);
    });
    const queryB = runUnderParent("parent-b", () => {
      return pool.query(statementB);
    });
    const waitingCount = pool.waitingCount;

    heldClient.release();
    await Promise.all([queryA, queryB]);

    expect(waitingCount).toBe(2);
    const spanA = findSpan(statementA);
    const spanB = findSpan(statementB);
    const parentA = findNamedSpan("parent-a");
    const parentB = findNamedSpan("parent-b");
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

  it("preserves acquisition and query failures and releases clients", async () => {
    const timeoutPool = createPool({ connectionTimeoutMillis: 25 });
    const heldClient = await timeoutPool.connect();
    const timeoutStatement = "SELECT 301 AS acquisition_timeout";
    const timeoutCapture = {
      acquisitions: [] as { durationMs: number; path: AcquirePath }[],
    };

    const timeoutError = await captureRejection(
      withPgPoolAcquisitionCapture(timeoutCapture, async () => {
        return await timeoutPool.query(timeoutStatement);
      }),
    );
    heldClient.release();

    expect(timeoutError).toBeInstanceOf(Error);
    expect(timeoutError).toHaveProperty(
      "message",
      "timeout exceeded when trying to connect",
    );
    const timeoutSpan = findSpan(timeoutStatement);
    expect(timeoutSpan.status.code).toBe(SpanStatusCode.ERROR);
    expectAcquisition(timeoutSpan, "queued");
    expect(timeoutCapture.acquisitions).toStrictEqual([
      { durationMs: expect.any(Number), path: "queued" },
    ]);

    const failurePool = createPool();
    const invalidStatement =
      "SELECT * FROM okou_missing_db_instrumentation_table";
    const recoveryStatement = "SELECT 302 AS recovered";
    const queryError = await captureRejection(
      failurePool.query(invalidStatement),
    );
    const recoveryResult = await failurePool.query(recoveryStatement);

    expect(queryError).toBeInstanceOf(Error);
    expect(recoveryResult.rowCount).toBe(1);
    const failureSpan = findSpan(invalidStatement);
    expect(failureSpan.status.code).toBe(SpanStatusCode.ERROR);
    expectAcquisition(failureSpan, "new");
    expectAcquisition(findSpan(recoveryStatement), "new");
  });

  it("preserves direct callbacks and instruments reused clients only once", async () => {
    const pool = createPool();
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
      release();
    });

    const statementA = "SELECT 401 AS reused_a";
    const statementB = "SELECT 402 AS reused_b";
    // With max: 1, this checkout cannot resolve until the callback above has
    // received and released the sole client.
    const clientA = await pool.connect();
    const resultA = await clientA.query(statementA);
    clientA.release();

    const clientB = await pool.connect();
    const sameClient = clientB === clientA;
    const resultB = await clientB.query(statementB);
    clientB.release();

    expect(callbackReturn).toBeUndefined();
    expect(callbackError).toBeUndefined();
    expect(callbackClient).toBe(clientA);
    expect(sameClient).toBeTruthy();
    expect(resultA.rowCount).toBe(1);
    expect(resultB.rowCount).toBe(1);
    expect(
      exporter.getFinishedSpans().filter((span) => {
        return span.attributes["db.statement"] === statementA;
      }),
    ).toHaveLength(1);
    expect(
      exporter.getFinishedSpans().filter((span) => {
        return span.attributes["db.statement"] === statementB;
      }),
    ).toHaveLength(1);
    expect(
      findSpan(statementA).attributes[ACQUIRE_PATH_ATTRIBUTE],
    ).toBeUndefined();
    expect(
      findSpan(statementB).attributes[ACQUIRE_PATH_ATTRIBUTE],
    ).toBeUndefined();
  });
});
