import { EVENT } from "@axiomhq/logging";
import { describe, it, expect, vi, beforeEach, onTestFinished } from "vitest";

import { mockEnv, mockOptionalEnv } from "../env";
import { flushLogs, logger, __resetForTest } from "../log";
import { testContext } from "../../__tests__/test-context";

const { axiom, axiomLogging, console: consoleOutput } = testContext().mocks;

const CANONICAL_DEBUG_KEY = "OKOU_DEBUG";
function configureDebug(value: string | undefined): void {
  mockEnv(CANONICAL_DEBUG_KEY, value);
}

beforeEach(() => {
  __resetForTest();
  axiomLogging.flush.mockResolvedValue(undefined);
});

describe("debug environment", () => {
  it.each([
    { description: "missing canonical input", value: undefined },
    { description: "empty canonical input", value: "" },
  ])("keeps the info level for $description", ({ value }) => {
    configureDebug(value);

    expect(logger("debug-target").level).toBe("info");
  });

  it.each([
    {
      description: "the global wildcard",
      value: "*",
      enabled: ["anything", "api:worker"],
      disabled: [],
    },
    {
      description: "a namespace-prefix wildcard",
      value: "api:*",
      enabled: ["api:worker", "api:"],
      disabled: ["api", "apis:worker"],
    },
    {
      description: "an exact logger name",
      value: "ExactLogger",
      enabled: ["ExactLogger"],
      disabled: ["exactlogger", "ExactLogger:child"],
    },
    {
      description: "trimmed comma-separated entries",
      value: " exact-one, , api:*, exact-two, ",
      enabled: ["exact-one", "api:child", "exact-two"],
      disabled: ["exact", "other"],
    },
    {
      description: "discarded empty entries",
      value: " ,  , ",
      enabled: [],
      disabled: ["anything"],
    },
    {
      description: "a non-matching pattern",
      value: "another-logger",
      enabled: [],
      disabled: ["target-logger"],
    },
  ])("preserves $description behavior", ({ value, enabled, disabled }) => {
    configureDebug(value);

    for (const name of enabled) {
      expect(logger(name).level).toBe("debug");
    }
    for (const name of disabled) {
      expect(logger(name).level).toBe("info");
    }
  });

  it("does not emit the canonical environment value to logs", () => {
    const value = `private-debug-pattern-${"x".repeat(113)}`;
    configureDebug(value);

    expect(logger(value).level).toBe("debug");
    expect(axiomLogging.debug).not.toHaveBeenCalled();
    expect(axiomLogging.info).not.toHaveBeenCalled();
    expect(axiomLogging.warn).not.toHaveBeenCalled();
    expect(axiomLogging.error).not.toHaveBeenCalled();
  });

  it("keeps configuration and logger levels cached until the existing reset", () => {
    configureDebug("CachedLogger");

    const cached = logger("CachedLogger");
    expect(cached.level).toBe("debug");
    mockEnv(CANONICAL_DEBUG_KEY, "AfterResetLogger");

    expect(logger("CachedLogger")).toBe(cached);
    expect(logger("CachedLogger").level).toBe("debug");
    expect(logger("AfterResetLogger").level).toBe("info");

    __resetForTest();

    expect(logger("AfterResetLogger").level).toBe("debug");
  });

  it("keeps the generic DEBUG convention unrelated", () => {
    configureDebug(undefined);
    mockOptionalEnv("DEBUG", "*");

    expect(logger("generic-debug-convention").level).toBe("info");
  });
});

// ── logToAxiom dispatches to correct @axiomhq/logging level ─────────────────

describe("logToAxiom level dispatch", () => {
  it("dispatches debug to alog.debug with source: api", () => {
    const log = logger("test-debug");
    log.debug("hello", { key: "value" });

    expect(axiomLogging.debug).toHaveBeenCalledWith("hello", {
      key: "value",
      context: "test-debug",
      [EVENT]: { source: "api" },
    });
  });

  it("dispatches info to alog.info with source: api", () => {
    const log = logger("test-info");
    log.info("info msg");

    expect(axiomLogging.info).toHaveBeenCalledWith("info msg", {
      context: "test-info",
      [EVENT]: { source: "api" },
    });
  });

  it("dispatches warn to alog.warn with source: api", () => {
    const log = logger("test-warn");
    log.warn("warning");

    expect(axiomLogging.warn).toHaveBeenCalledWith("warning", {
      context: "test-warn",
      [EVENT]: { source: "api" },
    });
  });

  it("dispatches error to alog.error with source: api", () => {
    const log = logger("test-err");
    log.error("boom");

    expect(axiomLogging.error).toHaveBeenCalledWith("boom", {
      context: "test-err",
      [EVENT]: { source: "api" },
    });
  });

  it("dispatches fatal to alog.error with source: api", () => {
    const log = logger("test-fatal");
    log.fatal("dead");

    expect(axiomLogging.error).toHaveBeenCalledWith("dead", {
      context: "test-fatal",
      [EVENT]: { source: "api" },
    });
  });

  it("converts non-string first arg to string for the Axiom message", () => {
    const log = logger("test-obj");
    const obj = { nested: true };
    log.info(obj);

    expect(axiomLogging.info).toHaveBeenCalledWith(
      String(obj),
      expect.objectContaining({ [EVENT]: { source: "api" } }),
    );
  });

  it("uses a fallback Axiom message when string conversion throws", () => {
    const log = logger("test-bad-string");
    const value = {
      [Symbol.toPrimitive]() {
        throw new Error("string conversion failed");
      },
    };

    expect(() => {
      log.info(value);
    }).not.toThrow();

    expect(axiomLogging.info).toHaveBeenCalledWith(
      "[Unreadable]",
      expect.objectContaining({ [EVENT]: { source: "api" } }),
    );
  });
});

// ── Axiom log calls include [EVENT]: { source: "api" } ───────────────────────────────────

describe("Axiom log source field", () => {
  it("includes source: api in info logs", () => {
    const log = logger("source-test");
    log.info("msg");

    expect(axiomLogging.info).toHaveBeenCalledWith(
      "msg",
      expect.objectContaining({ [EVENT]: { source: "api" } }),
    );
  });

  it("includes source: api in error logs with Error objects", () => {
    const log = logger("source-err");
    const err = new Error("fail");
    log.error(err);

    expect(axiomLogging.error).toHaveBeenCalledWith(
      "fail",
      expect.objectContaining({ [EVENT]: { source: "api" } }),
    );
  });

  it("uses a fallback Axiom message when Error.message is unreadable", () => {
    const log = logger("source-unreadable-err");
    const err = new Error("fail");
    Object.defineProperty(err, "message", {
      get() {
        throw new Error("message getter failed");
      },
    });

    expect(() => {
      log.error(err);
    }).not.toThrow();

    expect(axiomLogging.error).toHaveBeenCalledWith(
      "[Unreadable]",
      expect.objectContaining({
        error: expect.objectContaining({
          message: "[Unreadable]",
        }),
        [EVENT]: { source: "api" },
      }),
    );
  });

  it("places context before spread fields so user fields don't overwrite context", () => {
    const log = logger("ctx-test");
    log.warn("msg", { context: "evil" });

    // context should be from the logger name, not from user fields
    expect(axiomLogging.warn).toHaveBeenCalledWith("msg", {
      context: "ctx-test",
      [EVENT]: { source: "api" },
    });
  });

  it("lifts usage underbilling fields into the Axiom event root", () => {
    const log = logger("underbilling-test");
    log.error("underbilling", {
      type: "usage_underbilling",
      reason: "run_not_found",
      underbilling_class: "confirmed",
      component: "api",
      orgId: "org-test",
    });

    expect(axiomLogging.error).toHaveBeenCalledWith("underbilling", {
      type: "usage_underbilling",
      reason: "run_not_found",
      underbilling_class: "confirmed",
      component: "api",
      orgId: "org-test",
      context: "underbilling-test",
      [EVENT]: {
        source: "api",
        type: "usage_underbilling",
        reason: "run_not_found",
        underbilling_class: "confirmed",
        component: "api",
      },
    });
  });

  it("lifts unhandled request error fields into the Axiom event root", () => {
    const log = logger("unhandled-request-test");
    log.error("Unhandled request error: database column missing", {
      type: "unhandled_request_error",
      errorSummary: "database column missing",
      route: "/api/test/:id",
      method: "GET",
      errorCode: "42703",
      error: { message: "database column missing" },
    });

    expect(axiomLogging.error).toHaveBeenCalledWith(
      "Unhandled request error: database column missing",
      {
        type: "unhandled_request_error",
        errorSummary: "database column missing",
        route: "/api/test/:id",
        method: "GET",
        errorCode: "42703",
        error: { message: "database column missing" },
        context: "unhandled-request-test",
        [EVENT]: {
          source: "api",
          type: "unhandled_request_error",
          errorSummary: "database column missing",
          route: "/api/test/:id",
          method: "GET",
          errorCode: "42703",
        },
      },
    );
  });

  it.each([
    [521, "transient_read_exhausted"],
    [null, "transport_read_exhausted"],
  ])(
    "lifts sanitized provider-unavailable fields for %s / %s",
    (providerStatus, failureClass) => {
      const log = logger("provider-unavailable-test");
      log.error("Clerk read unavailable during scrape authentication", {
        type: "provider_unavailable",
        provider: "clerk",
        provider_status: providerStatus,
        failure_class: failureClass,
        method: "POST",
        route: "/api/scrape",
      });

      expect(axiomLogging.error).toHaveBeenCalledWith(
        "Clerk read unavailable during scrape authentication",
        {
          type: "provider_unavailable",
          provider: "clerk",
          provider_status: providerStatus,
          failure_class: failureClass,
          method: "POST",
          route: "/api/scrape",
          context: "provider-unavailable-test",
          [EVENT]: {
            source: "api",
            type: "provider_unavailable",
            provider: "clerk",
            provider_status: providerStatus,
            failure_class: failureClass,
            method: "POST",
            route: "/api/scrape",
          },
        },
      );
    },
  );

  it.each([
    ["521", "transient_read_exhausted"],
    [null, "transient_read_exhausted"],
    [521, "transport_read_exhausted"],
    [undefined, "transport_read_exhausted"],
    [404, "transient_read_exhausted"],
  ])(
    "does not lift invalid provider status/class pair %s / %s",
    (providerStatus, failureClass) => {
      const log = logger("malformed-provider-unavailable-test");
      log.error("provider error", {
        type: "provider_unavailable",
        provider: "clerk",
        provider_status: providerStatus,
        failure_class: failureClass,
        method: "POST",
        route: "/api/scrape",
      });

      expect(axiomLogging.error).toHaveBeenCalledWith("provider error", {
        type: "provider_unavailable",
        provider: "clerk",
        provider_status: providerStatus,
        failure_class: failureClass,
        method: "POST",
        route: "/api/scrape",
        context: "malformed-provider-unavailable-test",
        [EVENT]: { source: "api" },
      });
    },
  );

  it("lifts desktop update manifest outcome fields into the Axiom event root", () => {
    const log = logger("desktop-update-manifest-test");
    log.warn("Desktop update manifest upstream unavailable", {
      type: "desktop_update_manifest_upstream",
      outcome: "unavailable",
      provider: "github_release_asset",
      provider_status: 503,
      failure_class: "transient_read_exhausted",
      attempts: 3,
      line: "ai-okou-desktop",
      method: "GET",
      route:
        "/api/desktop/updates/:product/:channel/:platform/:arch/RELEASES.json",
    });

    expect(axiomLogging.warn).toHaveBeenCalledWith(
      "Desktop update manifest upstream unavailable",
      {
        type: "desktop_update_manifest_upstream",
        outcome: "unavailable",
        provider: "github_release_asset",
        provider_status: 503,
        failure_class: "transient_read_exhausted",
        attempts: 3,
        line: "ai-okou-desktop",
        method: "GET",
        route:
          "/api/desktop/updates/:product/:channel/:platform/:arch/RELEASES.json",
        context: "desktop-update-manifest-test",
        [EVENT]: {
          source: "api",
          type: "desktop_update_manifest_upstream",
          outcome: "unavailable",
          provider: "github_release_asset",
          provider_status: 503,
          failure_class: "transient_read_exhausted",
          attempts: 3,
          line: "ai-okou-desktop",
          method: "GET",
          route:
            "/api/desktop/updates/:product/:channel/:platform/:arch/RELEASES.json",
        },
      },
    );
  });

  it("does not lift a desktop update manifest event with an unknown outcome", () => {
    const log = logger("desktop-update-manifest-outcome-test");
    log.warn("manifest event", {
      type: "desktop_update_manifest_upstream",
      outcome: "degraded",
      provider: "github_release_asset",
      failure_class: "transient_read",
      attempts: 1,
      line: "ai-okou-desktop",
    });

    expect(axiomLogging.warn).toHaveBeenCalledWith("manifest event", {
      type: "desktop_update_manifest_upstream",
      outcome: "degraded",
      provider: "github_release_asset",
      failure_class: "transient_read",
      attempts: 1,
      line: "ai-okou-desktop",
      context: "desktop-update-manifest-outcome-test",
      [EVENT]: { source: "api" },
    });
  });

  it("does not lift unknown type fields into the Axiom event root", () => {
    const log = logger("unknown-type-test");
    log.error("custom event", {
      type: "custom_event",
      errorSummary: "summary",
      route: "/api/test/:id",
      method: "GET",
    });

    expect(axiomLogging.error).toHaveBeenCalledWith("custom event", {
      type: "custom_event",
      errorSummary: "summary",
      route: "/api/test/:id",
      method: "GET",
      context: "unknown-type-test",
      [EVENT]: { source: "api" },
    });
  });
});

// ── flushLogs ───────────────────────────────────────────────────────────────

describe("flushLogs", () => {
  it("calls alog.flush()", async () => {
    // Trigger axiom logger creation by logging
    logger("flush-test").info("msg");
    await flushLogs();

    expect(axiomLogging.flush).toHaveBeenCalledOnce();
  });

  it("does not throw when flush fails", async () => {
    axiomLogging.flush.mockRejectedValueOnce(new Error("flush down"));
    logger("fail-flush").info("msg");

    await expect(flushLogs()).resolves.toBeUndefined();
  });

  it("does not throw when axiom is not initialized", async () => {
    // Reset so singleton re-evaluates — but env token is already set
    __resetForTest();
    // flushLogs calls getAxiomLogger()?.flush() — optional chain handles null
    await expect(flushLogs()).resolves.toBeUndefined();
  });

  it("reports Axiom transport timeouts as contextual warnings", async () => {
    const restoreConsole = consoleOutput.capture();
    onTestFinished(restoreConsole);
    await flushLogs();
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";

    expect(() => {
      axiom.clientError(error);
    }).not.toThrow();

    expect(consoleOutput.warn).toHaveBeenCalledWith(
      "Axiom application log delivery timed out",
      {
        client: "telemetry",
        dataset: "vm0-web-logs-dev",
        failureKind: "timeout",
        error,
      },
    );
    expect(consoleOutput.error).not.toHaveBeenCalled();
    expect(axiomLogging.warn).not.toHaveBeenCalled();
    expect(axiomLogging.error).not.toHaveBeenCalled();
  });

  it("reports other Axiom transport failures as contextual errors", async () => {
    const restoreConsole = consoleOutput.capture();
    onTestFinished(restoreConsole);
    await flushLogs();
    const error = new Error("connection refused");

    expect(() => {
      axiom.clientError(error);
    }).not.toThrow();

    expect(consoleOutput.error).toHaveBeenCalledWith(
      "Axiom application log delivery failed",
      {
        client: "telemetry",
        dataset: "vm0-web-logs-dev",
        failureKind: "transport_error",
        error,
      },
    );
    expect(consoleOutput.warn).not.toHaveBeenCalled();
    expect(axiomLogging.warn).not.toHaveBeenCalled();
    expect(axiomLogging.error).not.toHaveBeenCalled();
  });
});

// ── serializeError (via extractFields + Error in log) ───────────────────────

describe("serializeError via logging", () => {
  it("includes non-enumerable Error properties in Axiom fields", () => {
    const log = logger("serialize");
    const err = new Error("test error");
    log.error(err);

    expect(axiomLogging.error).toHaveBeenCalledWith(
      "test error",
      expect.objectContaining({
        error: expect.objectContaining({
          name: "Error",
          message: "test error",
          stack: expect.any(String),
        }),
        [EVENT]: { source: "api" },
      }),
    );
  });

  it("recursively serializes error.cause", () => {
    const log = logger("cause-test");
    const cause = new Error("root cause");
    const err = new Error("wrapped", { cause });
    log.error(err);

    expect(axiomLogging.error).toHaveBeenCalledWith(
      "wrapped",
      expect.objectContaining({
        error: expect.objectContaining({
          message: "wrapped",
          cause: expect.objectContaining({
            name: "Error",
            message: "root cause",
          }),
        }),
      }),
    );
  });

  it("serializes cyclic error causes without throwing", () => {
    const log = logger("cyclic-cause-test");
    const err = new Error("wrapped");
    Object.defineProperty(err, "cause", { value: err });

    log.error(err);

    expect(axiomLogging.error).toHaveBeenCalledWith(
      "wrapped",
      expect.objectContaining({
        error: expect.objectContaining({
          message: "wrapped",
          cause: "[Circular]",
        }),
      }),
    );
  });

  it("truncates deep error cause chains", () => {
    const log = logger("deep-cause-test");
    const err = new Error("depth-0");
    let current = err;
    for (let index = 1; index <= 80; index += 1) {
      const next = new Error(`depth-${index}`);
      Object.defineProperty(current, "cause", { value: next });
      current = next;
    }

    log.error(err);

    const fields = axiomLogging.error.mock.calls[0]?.[1] as
      | Record<string, unknown>
      | undefined;
    const serialized = JSON.stringify(fields?.error);
    expect(serialized).toContain("depth-32");
    expect(serialized).toContain("[Truncated]");
    expect(serialized).not.toContain("depth-80");
  });

  it("serializes cyclic enumerable error fields into JSON-safe values", () => {
    const log = logger("cyclic-enumerable-test");
    const err = new Error("request failed") as Error & Record<string, unknown>;
    const request: Record<string, unknown> = {
      url: "https://example.test/api",
      retryAfter: 1n,
    };
    request.self = request;
    err.request = request;

    log.error(err);

    const fields = axiomLogging.error.mock.calls[0]?.[1] as
      | Record<string, unknown>
      | undefined;
    const serializedError = fields?.error as Record<string, unknown>;
    expect(serializedError).toMatchObject({
      message: "request failed",
      request: {
        url: "https://example.test/api",
        retryAfter: "1",
        self: "[Circular]",
      },
    });
    expect(() => {
      JSON.stringify(serializedError);
    }).not.toThrow();
  });

  it("serializes unreadable error properties without throwing", () => {
    const log = logger("unreadable-error-test");
    const err = new Error("request failed") as Error & Record<string, unknown>;
    Object.defineProperty(err, "cause", {
      get() {
        throw new Error("cause getter failed");
      },
    });
    Object.defineProperty(err, "request", {
      enumerable: true,
      get() {
        throw new Error("request getter failed");
      },
    });

    expect(() => {
      log.error(err);
    }).not.toThrow();

    const fields = axiomLogging.error.mock.calls[0]?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(fields?.error).toMatchObject({
      message: "request failed",
      cause: "[Unreadable]",
      request: "[Unreadable]",
    });
  });

  it("bounds enumerable object fields before reading later properties", () => {
    const log = logger("large-enumerable-test");
    const err = new Error("request failed") as Error & Record<string, unknown>;
    const request: Record<string, unknown> = {};
    for (let index = 0; index < 80; index += 1) {
      Object.defineProperty(request, `field${index}`, {
        enumerable: true,
        get() {
          if (index >= 64) {
            throw new Error("late getter should not be read");
          }
          return index;
        },
      });
    }
    err.request = request;

    expect(() => {
      log.error(err);
    }).not.toThrow();

    const fields = axiomLogging.error.mock.calls[0]?.[1] as
      | Record<string, unknown>
      | undefined;
    const serializedError = fields?.error as Record<string, unknown>;
    const serializedRequest = serializedError.request as Record<
      string,
      unknown
    >;
    expect(serializedRequest.field0).toBe(0);
    expect(serializedRequest.field63).toBe(63);
    expect(serializedRequest.field64).toBeUndefined();
    expect(serializedRequest.__truncated).toBeTruthy();
    expect(() => {
      JSON.stringify(serializedError);
    }).not.toThrow();
  });

  it("serializes non-string error stacks into JSON-safe values", () => {
    const log = logger("non-string-stack-test");
    const err = new Error("request failed");
    Object.defineProperty(err, "stack", {
      get() {
        return 1n;
      },
    });

    expect(() => {
      log.error(err);
    }).not.toThrow();

    const fields = axiomLogging.error.mock.calls[0]?.[1] as
      | Record<string, unknown>
      | undefined;
    const serializedError = fields?.error as Record<string, unknown>;
    expect(serializedError.stack).toBe("1");
    expect(() => {
      JSON.stringify(serializedError);
    }).not.toThrow();
  });

  it("bounds serialized error string fields", () => {
    const log = logger("long-error-string-test");
    const err = new Error("x".repeat(10_000));
    Object.defineProperty(err, "stack", {
      value: "s".repeat(10_000),
    });

    log.error("msg", err);

    const fields = axiomLogging.error.mock.calls[0]?.[1] as
      | Record<string, unknown>
      | undefined;
    const serializedError = fields?.error as Record<string, unknown>;
    expect(serializedError.message).toBe(`${"x".repeat(4093)}...`);
    expect(serializedError.stack).toBe(`${"s".repeat(4093)}...`);
  });

  it("preserves special enumerable keys as data fields", () => {
    const log = logger("special-key-error-test");
    const err = new Error("special") as Error & Record<string, unknown>;
    const payload: Record<string, unknown> = {};
    Object.defineProperty(err, "constructor", {
      enumerable: true,
      value: "error-constructor-field",
    });
    Object.defineProperty(payload, "__proto__", {
      enumerable: true,
      value: { nested: true },
    });
    err.payload = payload;

    log.error(err);

    const fields = axiomLogging.error.mock.calls[0]?.[1] as
      | Record<string, unknown>
      | undefined;
    const serializedError = fields?.error as Record<string, unknown>;
    const serializedPayload = serializedError.payload as Record<
      string,
      unknown
    >;
    expect(Object.getPrototypeOf(serializedError)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(serializedPayload)).toBe(Object.prototype);
    expect(
      Object.prototype.hasOwnProperty.call(serializedError, "constructor"),
    ).toBeTruthy();
    expect(
      Object.prototype.hasOwnProperty.call(serializedPayload, "__proto__"),
    ).toBeTruthy();
    expect(Reflect.get(serializedError, "constructor")).toBe(
      "error-constructor-field",
    );
    expect(Reflect.get(serializedPayload, "__proto__")).toStrictEqual({
      nested: true,
    });
  });

  it("bounds the total serialized error graph", () => {
    const log = logger("wide-error-graph-test");
    const err = new Error("wide") as Error & Record<string, unknown>;
    const payload: Record<string, unknown> = {};
    for (let childIndex = 0; childIndex < 64; childIndex += 1) {
      const child: Record<string, unknown> = {};
      for (let fieldIndex = 0; fieldIndex < 64; fieldIndex += 1) {
        child[`field${fieldIndex}`] = `${childIndex}:${fieldIndex}`;
      }
      payload[`child${childIndex}`] = child;
    }
    err.payload = payload;

    log.error(err);

    const fields = axiomLogging.error.mock.calls[0]?.[1] as
      | Record<string, unknown>
      | undefined;
    const serializedError = fields?.error as Record<string, unknown>;
    const serialized = JSON.stringify(serializedError);
    expect(serialized).toContain("[Truncated]");
    expect(serialized.length).toBeLessThan(100_000);
  });

  it("surfaces custom enumerable properties on Error", () => {
    const log = logger("custom-err");
    const err = new Error("custom") as Error & Record<string, unknown>;
    err.code = "ERR_TEST";
    err.statusCode = 500;
    log.error(err);

    const fields = axiomLogging.error.mock.calls[0]?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(fields?.error).toMatchObject({
      name: "Error",
      message: "custom",
      code: "ERR_TEST",
      statusCode: 500,
    });
  });
});

// ── extractFields via logging ───────────────────────────────────────────────

describe("extractFields via logging", () => {
  it("wraps Error second argument under { error: ... }", () => {
    const log = logger("extract-err");
    const err = new Error("boom");
    log.info("oh no", err);

    expect(axiomLogging.info).toHaveBeenCalledWith(
      "oh no",
      expect.objectContaining({
        error: expect.objectContaining({
          message: "boom",
        }),
      }),
    );
  });

  it("passes plain object second argument directly as fields", () => {
    const log = logger("extract-obj");
    log.info("data", { count: 42 });

    expect(axiomLogging.info).toHaveBeenCalledWith("data", {
      count: 42,
      context: "extract-obj",
      [EVENT]: { source: "api" },
    });
  });

  it("wraps multiple extra args in { args: [...] }", () => {
    const log = logger("extract-multi");
    log.info("msg", 1, "two", { three: 3 });

    expect(axiomLogging.info).toHaveBeenCalledWith(
      "msg",
      expect.objectContaining({
        args: [1, "two", { three: 3 }],
      }),
    );
  });
});

// ── getAxiomLogger returns null when token is unset ────────────────────────

describe("getAxiomLogger with no token", () => {
  it("returns null when AXIOM_TOKEN_TELEMETRY is unset", async () => {
    vi.resetModules();

    // Mock env to return empty string for AXIOM_TOKEN_TELEMETRY so
    // getAxiomLogger returns null. We mock the entire env module
    // because the real module calls createEnv which requires
    // AXIOM_TOKEN_TELEMETRY to be a non-empty string.
    // eslint-disable-next-line api/no-test-vi-mocks
    vi.doMock("../env", () => {
      return {
        env: (name: string) => {
          if (name === "AXIOM_TOKEN_TELEMETRY") {
            return "";
          }
          if (name === "AXIOM_DATASET_SUFFIX") {
            return "dev";
          }
          return "";
        },
        mockEnv: () => {},
        clearMockedEnv: () => {},
      };
    });

    const mod = await import("../log");
    const log = mod.logger("no-token-test");
    log.info("should not reach axiom");

    // Axiom mock methods should not have been called
    // oxlint-disable-next-line vitest/prefer-called-with
    expect(axiomLogging.info).not.toHaveBeenCalled();

    vi.resetModules();
  });
});

// ── Logger caching and basic behavior ───────────────────────────────────────

describe("logger", () => {
  it("caches logger instances by name", () => {
    expect(logger("Cache")).toBe(logger("Cache"));
  });

  it("creates distinct loggers for different names", () => {
    expect(logger("A")).not.toBe(logger("B"));
  });
});
