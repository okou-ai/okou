import { initContract } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  CLIENT_FORCE_UPGRADE_STATUS,
  CHAT_EVENT_SCHEMA_VERSION_HEADER,
  CLIENT_PRODUCT_HEADER,
  CLIENT_TYPE_APP,
  CLIENT_TYPE_CLI,
  CLIENT_TYPE_DESKTOP,
  CLIENT_TYPE_HEADER,
  CLIENT_VERSION_HEADER,
  DESKTOP_PRODUCT_OKOU,
  DESKTOP_PRODUCT_ZERO,
} from "@okouai/api-contracts/contracts/client-headers";
import { EVENT } from "@axiomhq/logging";
import { computed } from "ccstate";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { vi } from "vitest";
import { createApp } from "../app-factory";
import { createAppWithRoutes } from "../app-factory-core";
import { mockEnv } from "../lib/env";
import webClientCompatibility from "../lib/web-client-compatibility.json";
import { flushWaitUntilForTest } from "../signals/context/wait-until";
import { recordWebDownloadFailure$ } from "../signals/context/hono";
import { downloadS3Buffer } from "../signals/external/s3";
import { healthRoutes } from "../signals/routes/health";
import { mailRoutes } from "../signals/routes/mail";
import { accept, testContext } from "./test-context";
import { setupApp } from "./test-helpers";
const TEST_APP_ROUTES = Object.freeze([...healthRoutes, ...mailRoutes]);

const MINIMUM_WEB_CLIENT_VERSION =
  webClientCompatibility.minimumSupportedVersion;
// Derived so that raising the supported floor does not turn this fixture into
// an unsupported version.
const NEWER_WEB_CLIENT_VERSION = MINIMUM_WEB_CLIENT_VERSION.replace(
  /(\d+)$/u,
  (patch) => {
    return (Number(patch) + 1).toString();
  },
);

// eslint-disable-next-line api/no-test-vi-mocks
const { mockFlushLogs } = vi.hoisted(() => {
  return {
    // eslint-disable-next-line api/no-test-vi-mocks
    mockFlushLogs: vi.fn<typeof import("../lib/log").flushLogs>(),
  };
});

mockFlushLogs.mockResolvedValue(undefined);

// eslint-disable-next-line api/no-test-vi-mocks
vi.mock("../lib/log", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/log")>("../lib/log");
  return { ...actual, flushLogs: mockFlushLogs };
});

const c = initContract();

function axiomRequestLogEvents(
  context: ReturnType<typeof testContext>,
): readonly Record<string, unknown>[] {
  return context.mocks.axiom.ingest.mock.calls.flatMap(([dataset, events]) => {
    if (dataset !== "request-log" || !Array.isArray(events)) {
      return [];
    }
    return events.filter((event): event is Record<string, unknown> => {
      return typeof event === "object" && event !== null;
    });
  });
}

const errorTestContract = c.router({
  boom: {
    method: "GET",
    path: "/__test/boom",
    responses: {
      500: z.object({ error: z.string() }),
    },
  },
  boomById: {
    method: "GET",
    path: "/__test/boom/:id",
    pathParams: z.object({ id: z.string() }),
    responses: {
      500: z.object({ error: z.string() }),
    },
  },
  missing: {
    method: "GET",
    path: "/__test/missing",
    responses: {
      404: z.string(),
    },
  },
  unavailable: {
    method: "GET",
    path: "/__test/unavailable",
    responses: {
      503: z.string(),
    },
  },
  aborted: {
    method: "GET",
    path: "/__test/aborted",
    responses: {
      500: z.object({ error: z.string() }),
    },
  },
  storageDownload: {
    method: "GET",
    path: "/__test/storage-download",
    responses: {
      200: z.string(),
      500: z.object({ error: z.string() }),
    },
  },
  pathIdentity: {
    method: "GET",
    path: "/api/test/path-identity",
    responses: {
      200: z.object({ matched: z.literal(true) }),
    },
  },
});

describe("createApp", () => {
  const context = testContext();

  it.each([
    [
      "literal dot segment",
      "http://api.test/api/ordinary/../test/path-identity",
    ],
    [
      "encoded dot segment",
      "http://api.test/api/ordinary/%2e%2e/test/path-identity",
    ],
    ["backslash", String.raw`http://api.test/api\test\path-identity`],
    [
      "query and fragment",
      "http://api.test/api/test/path-identity?visible=1#fragment",
    ],
  ])("normalizes a %s to the registered pathname", async (_case, url) => {
    const handler$ = computed(() => {
      return { status: 200 as const, body: { matched: true as const } };
    });
    const app = createAppWithRoutes({
      routes: [{ route: errorTestContract.pathIdentity, handler: handler$ }],
      signal: context.signal,
    });

    const response = await app.request(url);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ matched: true });
  });

  it("retains a repeated pathname separator", async () => {
    const handler$ = computed(() => {
      return { status: 200 as const, body: { matched: true as const } };
    });
    const app = createAppWithRoutes({
      routes: [{ route: errorTestContract.pathIdentity, handler: handler$ }],
      signal: context.signal,
    });

    const response = await app.request(
      "http://api.test/api//test/path-identity",
    );

    expect(response.status).toBe(404);
  });

  it("captures unhandled errors and returns a sanitized response", async () => {
    const error = new Error("boom");
    const handler$ = computed((): never => {
      throw error;
    });
    const client = setupApp({
      context,
      routes: [
        ...TEST_APP_ROUTES,
        { route: errorTestContract.boom, handler: handler$ },
      ],
    })(errorTestContract);

    const response = await accept(client.boom(), [500]);

    expect(response.body).toStrictEqual({ error: "Internal server error" });
    expect(context.mocks.sentry.captureException).toHaveBeenCalledWith(error);
  });

  it.each(["get_object", "read_body"] as const)(
    "includes %s download progress in the owning error log",
    async (stage) => {
      const error = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
      if (stage === "get_object") {
        context.mocks.s3.send.mockRejectedValue(error);
      } else {
        context.mocks.s3.send.mockResolvedValue({
          Body: (async function* interruptedBody(): AsyncIterable<Uint8Array> {
            yield Buffer.from("data");
            throw error;
          })(),
          ContentLength: 12,
          $metadata: {
            httpStatusCode: 200,
            requestId: "storage-request-id",
            attempts: 2,
            totalRetryDelay: 100,
          },
        });
      }
      const handler$ = computed(async (get) => {
        const recordFailure = get(recordWebDownloadFailure$);
        const buffer = await get(
          downloadS3Buffer("private-bucket", "private/path.zip", {
            onFailure: (diagnostics) => {
              recordFailure({
                ...diagnostics,
                storageScope: "user_artifact",
                objectFingerprint: "opaque-object-fingerprint",
                objectSize: 12,
                requestAborted: false,
              });
            },
          }),
        );
        return { status: 200 as const, body: buffer.toString() };
      });
      const unrelatedError$ = computed((): never => {
        throw new Error("unrelated request failure");
      });
      const client = setupApp({
        context,
        routes: [
          { route: errorTestContract.storageDownload, handler: handler$ },
          { route: errorTestContract.boom, handler: unrelatedError$ },
        ],
      })(errorTestContract);

      const response = await accept(
        client.storageDownload({
          extraHeaders: { "X-Client-Request-Id": "download-request-id" },
        }),
        [500],
      );

      expect(response.body).toStrictEqual({ error: "Internal server error" });
      expect(
        context.mocks.sentry.captureException,
      ).toHaveBeenCalledExactlyOnceWith(error);
      const [message, fields] =
        context.mocks.axiomLogging.error.mock.calls.at(-1) ?? [];
      expect(message).toBe("Unhandled request error: aborted");
      expect(fields).toMatchObject({
        errorCode: "ECONNRESET",
        x_client_request_id: "download-request-id",
        download: {
          stage,
          stageDurationMs: expect.any(Number),
          receivedBytes: stage === "read_body" ? 4 : 0,
          signalAborted: false,
          storageScope: "user_artifact",
          objectFingerprint: "opaque-object-fingerprint",
          objectSize: 12,
          requestAborted: false,
          ...(stage === "read_body"
            ? {
                expectedBytes: 12,
                providerStatus: 200,
                providerRequestId: "storage-request-id",
                providerAttempts: 2,
                providerRetryDelayMs: 100,
              }
            : {}),
        },
      });
      const serialized = JSON.stringify(fields);
      expect(serialized).not.toContain("private-bucket");
      expect(serialized).not.toContain("private/path.zip");

      await accept(client.boom(), [500]);
      const unrelatedFields =
        context.mocks.axiomLogging.error.mock.calls.at(-1)?.[1];
      expect(unrelatedFields).not.toHaveProperty("download");
    },
  );

  it("handles non-Error thrown values while logging unhandled errors", async () => {
    const thrownValue = 1n;
    const handler$ = computed((): never => {
      throw thrownValue;
    });
    const client = setupApp({
      context,
      routes: [
        ...TEST_APP_ROUTES,
        { route: errorTestContract.boom, handler: handler$ },
      ],
    })(errorTestContract);

    const response = await accept(client.boom(), [500]);

    expect(response.body).toStrictEqual({ error: "Internal server error" });
    const capturedError =
      context.mocks.sentry.captureException.mock.calls.at(-1)?.[0];
    expect(capturedError).toBeInstanceOf(Error);
    expect(capturedError).toMatchObject({
      message: "Non-Error thrown: 1",
      cause: thrownValue,
    });

    const [message, fields] =
      context.mocks.axiomLogging.error.mock.calls.at(-1) ?? [];
    expect(message).toBe("Unhandled request error: Non-Error thrown: 1");
    const logFields = fields as Record<PropertyKey, unknown>;
    expect(logFields).toMatchObject({
      type: "unhandled_request_error",
      errorSummary: "Non-Error thrown: 1",
      route: "/__test/boom",
      method: "GET",
      error: {
        message: "Non-Error thrown: 1",
        cause: "1",
      },
    });
    expect(() => {
      JSON.stringify(logFields.error);
    }).not.toThrow();
  });

  it("bounds non-Error thrown value summaries", async () => {
    const thrownValue = "x".repeat(10_000);
    const expectedSummary = `Non-Error thrown: ${"x".repeat(219)}...`;
    const handler$ = computed((): never => {
      throw thrownValue;
    });
    const client = setupApp({
      context,
      routes: [
        ...TEST_APP_ROUTES,
        { route: errorTestContract.boom, handler: handler$ },
      ],
    })(errorTestContract);

    const response = await accept(client.boom(), [500]);

    expect(response.body).toStrictEqual({ error: "Internal server error" });
    const capturedError =
      context.mocks.sentry.captureException.mock.calls.at(-1)?.[0];
    expect(capturedError).toMatchObject({
      message: `Non-Error thrown: ${"x".repeat(4075)}...`,
    });

    const [message, fields] =
      context.mocks.axiomLogging.error.mock.calls.at(-1) ?? [];
    expect(message).toBe(`Unhandled request error: ${expectedSummary}`);
    const logFields = fields as Record<PropertyKey, unknown>;
    expect(logFields).toMatchObject({
      type: "unhandled_request_error",
      errorSummary: expectedSummary,
    });
  });

  it("logs sanitized root-cause fields for unhandled errors", async () => {
    const cause = new Error(
      "column chat_threads.last_read_message_id does not exist for user test@example.com at https://example.test/callback?token=secret Bearer abcdef1234567890 123456789012 01890f9d-7b0d-7ccf-8f02-7d8a0c1b2c3d org_abc123456789 user_def987654321 API key: sk-live-secret client secret=client-secret refresh_token=refresh-secret Authorization: Basic basic-secret",
    );
    const error = Object.assign(
      new Error("wrapped database failure", { cause }),
      {
        code: "42703",
      },
    );
    const handler$ = computed((): never => {
      throw error;
    });
    const client = setupApp({
      context,
      routes: [
        ...TEST_APP_ROUTES,
        { route: errorTestContract.boomById, handler: handler$ },
      ],
    })(errorTestContract);

    const response = await accept(
      client.boomById({
        params: { id: "550e8400-e29b-41d4-a716-446655440000" },
      }),
      [500],
    );

    expect(response.body).toStrictEqual({ error: "Internal server error" });
    expect(context.mocks.sentry.captureException).toHaveBeenCalledWith(error);

    const [message, fields] =
      context.mocks.axiomLogging.error.mock.calls.at(-1) ?? [];
    expect(message).toBe(
      "Unhandled request error: column chat_threads.last_read_message_id does not exist for user [email] at [url] Bearer [redacted] [number] [id] [id] [id] API key=[redacted] client secret=[redacted] refresh_token=[redacted] Authorization=[redacted]",
    );

    const logFields = fields as Record<PropertyKey, unknown>;
    expect(logFields).toMatchObject({
      type: "unhandled_request_error",
      errorSummary:
        "column chat_threads.last_read_message_id does not exist for user [email] at [url] Bearer [redacted] [number] [id] [id] [id] API key=[redacted] client secret=[redacted] refresh_token=[redacted] Authorization=[redacted]",
      route: "/__test/boom/:id",
      method: "GET",
      errorCode: "42703",
      error: expect.objectContaining({
        message: "wrapped database failure",
        code: "42703",
        cause: expect.objectContaining({
          message: cause.message,
        }),
      }),
    });
    expect(logFields[EVENT]).toMatchObject({
      source: "api",
      type: "unhandled_request_error",
      errorSummary:
        "column chat_threads.last_read_message_id does not exist for user [email] at [url] Bearer [redacted] [number] [id] [id] [id] API key=[redacted] client secret=[redacted] refresh_token=[redacted] Authorization=[redacted]",
      route: "/__test/boom/:id",
      method: "GET",
      errorCode: "42703",
    });

    const serialized = JSON.stringify({
      message,
      errorSummary: logFields.errorSummary,
      route: logFields.route,
    });
    expect(serialized).not.toContain("test@example.com");
    expect(serialized).not.toContain("token=secret");
    expect(serialized).not.toContain("abcdef1234567890");
    expect(serialized).not.toContain("123456789012");
    expect(serialized).not.toContain("01890f9d-7b0d-7ccf-8f02-7d8a0c1b2c3d");
    expect(serialized).not.toContain("org_abc123456789");
    expect(serialized).not.toContain("user_def987654321");
    expect(serialized).not.toContain("550e8400-e29b-41d4-a716-446655440000");
    expect(serialized).not.toContain("sk-live-secret");
    expect(serialized).not.toContain("client-secret");
    expect(serialized).not.toContain("refresh-secret");
    expect(serialized).not.toContain("basic-secret");
  });

  it("bounds long unhandled error summaries", async () => {
    const error = new Error("x".repeat(10_000));
    const expectedSummary = `${"x".repeat(237)}...`;
    const handler$ = computed((): never => {
      throw error;
    });
    const client = setupApp({
      context,
      routes: [
        ...TEST_APP_ROUTES,
        { route: errorTestContract.boom, handler: handler$ },
      ],
    })(errorTestContract);

    await accept(client.boom(), [500]);

    const [message, fields] =
      context.mocks.axiomLogging.error.mock.calls.at(-1) ?? [];
    const logFields = fields as Record<PropertyKey, unknown>;
    expect(logFields.errorSummary).toBe(expectedSummary);
    expect(message).toBe(`Unhandled request error: ${expectedSummary}`);
  });

  it("handles cyclic error causes while logging unhandled errors", async () => {
    const error = new Error("cyclic failure");
    Object.defineProperty(error, "cause", { value: error });
    const handler$ = computed((): never => {
      throw error;
    });
    const client = setupApp({
      context,
      routes: [
        ...TEST_APP_ROUTES,
        { route: errorTestContract.boom, handler: handler$ },
      ],
    })(errorTestContract);

    const response = await accept(client.boom(), [500]);

    expect(response.body).toStrictEqual({ error: "Internal server error" });

    const [message, fields] =
      context.mocks.axiomLogging.error.mock.calls.at(-1) ?? [];
    const logFields = fields as Record<PropertyKey, unknown>;
    expect(message).toBe("Unhandled request error: cyclic failure");
    expect(logFields).toMatchObject({
      type: "unhandled_request_error",
      errorSummary: "cyclic failure",
      error: expect.objectContaining({
        message: "cyclic failure",
        cause: "[Circular]",
      }),
    });
  });

  it("bounds deep error cause chains while logging unhandled errors", async () => {
    const error = new Error("depth-0");
    let current = error;
    for (let index = 1; index <= 80; index += 1) {
      const next = new Error(`depth-${index}`);
      Object.defineProperty(current, "cause", { value: next });
      current = next;
    }
    const handler$ = computed((): never => {
      throw error;
    });
    const client = setupApp({
      context,
      routes: [
        ...TEST_APP_ROUTES,
        { route: errorTestContract.boom, handler: handler$ },
      ],
    })(errorTestContract);

    const response = await accept(client.boom(), [500]);

    expect(response.body).toStrictEqual({ error: "Internal server error" });

    const [message, fields] =
      context.mocks.axiomLogging.error.mock.calls.at(-1) ?? [];
    const logFields = fields as Record<PropertyKey, unknown>;
    expect(message).toBe("Unhandled request error: depth-31");
    expect(logFields.errorSummary).toBe("depth-31");
    expect(JSON.stringify(logFields.error)).toContain("[Truncated]");
    expect(JSON.stringify(logFields.error)).not.toContain("depth-80");
  });

  it("handles cyclic enumerable error fields while logging unhandled errors", async () => {
    const error = new Error("request failure") as Error &
      Record<string, unknown>;
    const request: Record<string, unknown> = {
      url: "https://example.test/api",
      retryAfter: 1n,
    };
    request.self = request;
    error.request = request;
    const handler$ = computed((): never => {
      throw error;
    });
    const client = setupApp({
      context,
      routes: [
        ...TEST_APP_ROUTES,
        { route: errorTestContract.boom, handler: handler$ },
      ],
    })(errorTestContract);

    const response = await accept(client.boom(), [500]);

    expect(response.body).toStrictEqual({ error: "Internal server error" });

    const [, fields] = context.mocks.axiomLogging.error.mock.calls.at(-1) ?? [];
    const logFields = fields as Record<PropertyKey, unknown>;
    const serializedError = logFields.error as Record<string, unknown>;
    expect(serializedError).toMatchObject({
      message: "request failure",
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

  it("handles unreadable error properties while logging unhandled errors", async () => {
    const error = new Error("unreadable failure") as Error &
      Record<string, unknown>;
    Object.defineProperty(error, "cause", {
      get() {
        throw new Error("cause getter failed");
      },
    });
    Object.defineProperty(error, "code", {
      get() {
        throw new Error("code getter failed");
      },
    });
    Object.defineProperty(error, "request", {
      enumerable: true,
      get() {
        throw new Error("request getter failed");
      },
    });
    const handler$ = computed((): never => {
      throw error;
    });
    const client = setupApp({
      context,
      routes: [
        ...TEST_APP_ROUTES,
        { route: errorTestContract.boom, handler: handler$ },
      ],
    })(errorTestContract);

    const response = await accept(client.boom(), [500]);

    expect(response.body).toStrictEqual({ error: "Internal server error" });

    const [message, fields] =
      context.mocks.axiomLogging.error.mock.calls.at(-1) ?? [];
    const logFields = fields as Record<PropertyKey, unknown>;
    expect(message).toBe("Unhandled request error: unreadable failure");
    expect(logFields.errorCode).toBeUndefined();
    expect(logFields.error).toMatchObject({
      message: "unreadable failure",
      cause: "[Unreadable]",
      request: "[Unreadable]",
    });
  });

  it("summarizes response validation failures without schema details", async () => {
    const handler$ = computed(() => {
      return { status: 500, body: { error: 123 } };
    });
    const client = setupApp({
      context,
      routes: [
        ...TEST_APP_ROUTES,
        { route: errorTestContract.boom, handler: handler$ },
      ],
    })(errorTestContract);

    const response = await accept(client.boom(), [500]);

    expect(response.body).toStrictEqual({ error: "Internal server error" });
    expect(context.mocks.sentry.captureException).toHaveBeenCalledOnce();

    const [message, fields] =
      context.mocks.axiomLogging.error.mock.calls.at(-1) ?? [];
    expect(message).toBe("Unhandled request error: response validation failed");

    const logFields = fields as Record<PropertyKey, unknown>;
    expect(logFields).toMatchObject({
      type: "unhandled_request_error",
      errorSummary: "response validation failed",
      route: "/__test/boom",
      method: "GET",
    });
    expect(logFields[EVENT]).toMatchObject({
      source: "api",
      type: "unhandled_request_error",
      errorSummary: "response validation failed",
      route: "/__test/boom",
      method: "GET",
    });
  });

  it("summarizes response validation failures with leading whitespace", async () => {
    const error = new Error("  response validation failed: schema details");
    const handler$ = computed((): never => {
      throw error;
    });
    const client = setupApp({
      context,
      routes: [
        ...TEST_APP_ROUTES,
        { route: errorTestContract.boom, handler: handler$ },
      ],
    })(errorTestContract);

    const response = await accept(client.boom(), [500]);

    expect(response.body).toStrictEqual({ error: "Internal server error" });

    const [message, fields] =
      context.mocks.axiomLogging.error.mock.calls.at(-1) ?? [];
    expect(message).toBe("Unhandled request error: response validation failed");
    expect(fields).toMatchObject({
      type: "unhandled_request_error",
      errorSummary: "response validation failed",
    });
  });

  it("passes through expected HTTP client errors without capturing them", async () => {
    const error = new HTTPException(404, { message: "Missing" });
    const handler$ = computed((): never => {
      throw error;
    });
    const client = setupApp({
      context,
      routes: [
        ...TEST_APP_ROUTES,
        { route: errorTestContract.missing, handler: handler$ },
      ],
    })(errorTestContract);

    await accept(client.missing(), [404]);

    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
  });

  it("does not capture AbortError", async () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    const handler$ = computed((): never => {
      throw error;
    });
    const client = setupApp({
      context,
      routes: [
        ...TEST_APP_ROUTES,
        { route: errorTestContract.aborted, handler: handler$ },
      ],
    })(errorTestContract);

    await accept(client.aborted(), [500]);

    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
  });

  it("captures HTTP server errors while preserving their response", async () => {
    const error = new HTTPException(503, { message: "Unavailable" });
    const handler$ = computed((): never => {
      throw error;
    });
    const client = setupApp({
      context,
      routes: [
        ...TEST_APP_ROUTES,
        { route: errorTestContract.unavailable, handler: handler$ },
      ],
    })(errorTestContract);

    await accept(client.unavailable(), [503]);

    expect(context.mocks.sentry.captureException).toHaveBeenCalledWith(error);
  });

  describe("not found", () => {
    it.each([
      [
        "/sign-in?redirect_url=https%3A%2F%2Fwww.okou.ai%2Fconnect",
        "https://pr-123-app.vm6.ai/sign-in?redirect_url=https%3A%2F%2Fwww.okou.ai%2Fconnect",
      ],
      [
        "/sign-up/verify?redirect_url=https%3A%2F%2Fwww.okou.ai%2Fconnect",
        "https://pr-123-app.vm6.ai/sign-up/verify?redirect_url=https%3A%2F%2Fwww.okou.ai%2Fconnect",
      ],
    ])("redirects %s to the configured app origin", async (path, expected) => {
      mockEnv("APP_URL", "https://pr-123-app.vm6.ai");
      mockEnv("OKOU_WEB_URL", "https://pr-123-www.omby.ai");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request(`https://pr-123-api.vm6.ai${path}`);

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(expected);
    });

    it.each([
      [
        "https://api.okou.ai",
        "https://app.okou.ai",
        "/sign-in?redirect_url=%2Fchats",
        "https://app.okou.ai/sign-in?redirect_url=%2Fchats",
      ],
      [
        "https://api.okou.ai",
        "https://app.okou.ai",
        "/sign-up/verify?redirect_url=%2Fonboarding",
        "https://app.okou.ai/sign-up/verify?redirect_url=%2Fonboarding",
      ],
    ])(
      "redirects auth requests on %s to its matching app domain",
      async (apiUrl, configuredAppUrl, path, expected) => {
        mockEnv("APP_URL", configuredAppUrl);
        const app = createApp({
          signal: context.signal,
          routes: TEST_APP_ROUTES,
        });

        const response = await app.request(`${apiUrl}${path}`);

        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe(expected);
      },
    );

    it("returns a 404 JSON response for unmatched routes", async () => {
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/api/legacy/fallthrough?limit=5", {
        method: "GET",
        headers: { authorization: "Bearer legacy" },
      });

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toStrictEqual({
        error: "Not found",
      });
    });

    it("keeps registered routes matched normally", async () => {
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", { method: "GET" });

      expect(response.status).toBe(200);
    });
  });

  describe("preview automation bypass", () => {
    it("rejects preview requests without the Vercel bypass header or cookie", async () => {
      mockEnv("ENV", "preview");
      mockEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });

      const response = await app.request("/health", { method: "GET" });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toStrictEqual({
        error: "Preview automation bypass required",
        debug: {
          expected: "582906dc0bca",
          cookieHeaderPresent: false,
        },
      });
    });

    it("allows preview requests with the matching Vercel bypass header", async () => {
      mockEnv("ENV", "preview");
      mockEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });

      const response = await app.request("/health", {
        method: "GET",
        headers: { "x-vercel-protection-bypass": "preview-secret" },
      });

      expect(response.status).toBe(200);
    });

    it("allows preview requests with a matching Vercel bypass cookie", async () => {
      mockEnv("ENV", "preview");
      mockEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });

      const response = await app.request("/health", {
        method: "GET",
        headers: {
          cookie: "unrelated=1; x-vercel-protection-bypass=preview-secret",
        },
      });

      expect(response.status).toBe(200);
    });

    it("rejects preview requests with the bypass secret in an unrelated cookie", async () => {
      mockEnv("ENV", "preview");
      mockEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });

      const response = await app.request("/health", {
        method: "GET",
        headers: { cookie: "unrelated=preview-secret" },
      });

      expect(response.status).toBe(403);
    });

    it("allows preview requests with the matching Vercel bypass query", async () => {
      mockEnv("ENV", "preview");
      mockEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });

      const response = await app.request(
        "/health?x-vercel-protection-bypass=preview-secret",
        { method: "GET" },
      );

      expect(response.status).toBe(200);
    });

    it("exempts external webhook paths from the guard without the bypass secret", async () => {
      mockEnv("ENV", "preview");
      mockEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });

      // A non-webhook path is still rejected by the guard before route matching.
      const guarded = await app.request("/api/legacy/fallthrough", {
        method: "GET",
      });
      expect(guarded.status).toBe(403);

      // Stripe (and every other) webhook is exempt, so the request reaches
      // routing instead of the guard. GET does not match the POST-only handler,
      // yielding a normal 404 rather than a bypass rejection — proof the
      // server-to-server webhook would have reached its handler.
      const webhook = await app.request("/api/webhooks/stripe", {
        method: "GET",
      });
      expect(webhook.status).toBe(404);
      await expect(webhook.json()).resolves.toStrictEqual({
        error: "Not found",
      });
    });
  });

  describe("cors", () => {
    it("echoes allowed cross-origin on registered route responses", async () => {
      mockEnv("ENV", "production");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", {
        method: "GET",
        headers: { origin: "https://app.okou.ai" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://app.okou.ai",
      );
      expect(response.headers.get("access-control-allow-credentials")).toBe(
        "true",
      );
    });

    it("echoes exact vm7 app origin with port on registered route responses", async () => {
      mockEnv("ENV", "production");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", {
        method: "GET",
        headers: { origin: "https://app.vm7.ai:8443" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://app.vm7.ai:8443",
      );
    });

    it("echoes the exact okou.ai production origin", async () => {
      mockEnv("ENV", "production");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", {
        method: "GET",
        headers: { origin: "https://okou.ai" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://okou.ai",
      );
    });

    it("allows https origins on okou.ai subdomains", async () => {
      mockEnv("ENV", "production");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", {
        method: "GET",
        headers: { origin: "https://console.okou.ai" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://console.okou.ai",
      );
    });

    it("does not allow lookalike okou.ai origins", async () => {
      mockEnv("ENV", "production");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", {
        method: "GET",
        headers: { origin: "https://okou.ai.evil.example" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("answers preflight without invoking the route handler", async () => {
      mockEnv("ENV", "production");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/api/chat-threads", {
        method: "OPTIONS",
        headers: {
          origin: "https://app.okou.ai",
          "access-control-request-method": "GET",
          "access-control-request-headers":
            "authorization,x-client-version,x-client-type,x-client-product,x-client-session-id,x-client-request-id,x-chat-event-schema-version",
        },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://app.okou.ai",
      );
      expect(response.headers.get("access-control-allow-methods")).toContain(
        "GET",
      );
      const allowHeaders =
        response.headers.get("access-control-allow-headers") ?? "";
      expect(allowHeaders).toContain("Authorization");
      expect(allowHeaders).toContain("X-Vercel-Protection-Bypass");
      expect(allowHeaders).toContain("X-Client-Version");
      expect(allowHeaders).toContain("X-Client-Type");
      expect(allowHeaders).toContain("X-Client-Product");
      expect(allowHeaders).toContain("X-Client-Session-Id");
      expect(allowHeaders).toContain("X-Client-Request-Id");
      expect(allowHeaders).toContain(CHAT_EVENT_SCHEMA_VERSION_HEADER);
      expect(
        response.headers.get("access-control-expose-headers") ?? "",
      ).toContain(CHAT_EVENT_SCHEMA_VERSION_HEADER);
    });

    it("answers preview preflight before enforcing the automation bypass", async () => {
      mockEnv("ENV", "preview");
      mockEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/api/chat-threads", {
        method: "OPTIONS",
        headers: {
          origin: "https://pr-20640-app.omby.ai",
          "access-control-request-method": "GET",
          "access-control-request-headers":
            "authorization,x-vercel-protection-bypass,x-client-version",
        },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://pr-20640-app.omby.ai",
      );
      const allowHeaders =
        response.headers.get("access-control-allow-headers") ?? "";
      expect(allowHeaders).toContain("Authorization");
      expect(allowHeaders).toContain("X-Vercel-Protection-Bypass");
      expect(allowHeaders).toContain("X-Client-Version");
    });

    it("allows okou preview app origins", async () => {
      mockEnv("ENV", "preview");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", {
        method: "GET",
        headers: { origin: "https://pr-22085-app.omby.ai" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://pr-22085-app.omby.ai",
      );
    });

    it("allows standalone okou app Worker origins in preview", async () => {
      mockEnv("ENV", "preview");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const origin = "https://pr-22085-app-okou-app-preview.vm0.workers.dev";
      const response = await app.request("/health", {
        method: "GET",
        headers: { origin },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    });

    it("does not allow app Worker lookalike origins in preview", async () => {
      mockEnv("ENV", "preview");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      for (const origin of [
        "https://pr-22085-app-okou-app-preview.vm0.workers.dev.evil.example",
        "https://pr-22085-app-okou-app-preview.attacker.workers.dev",
      ]) {
        const response = await app.request("/health", {
          method: "GET",
          headers: { origin },
        });

        expect(response.status).toBe(200);
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
      }
    });

    it("does not allow lookalike okou preview origins", async () => {
      mockEnv("ENV", "preview");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", {
        method: "GET",
        headers: { origin: "https://pr-22085-app.omby.ai.evil.example" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("rejects disallowed origins by omitting the allow-origin header", async () => {
      mockEnv("ENV", "production");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", {
        method: "GET",
        headers: { origin: "https://evil.example.com" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("allows vm7 origins in development", async () => {
      mockEnv("ENV", "development");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", {
        method: "GET",
        headers: { origin: "https://app.vm7.ai:8443" },
      });

      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://app.vm7.ai:8443",
      );
    });

    it("allows vm7 preview origins on any https port", async () => {
      mockEnv("ENV", "preview");
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", {
        method: "GET",
        headers: { origin: "https://www.vm7.ai:3042" },
      });

      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://www.vm7.ai:3042",
      );
    });
  });

  describe("web client compatibility", () => {
    it.each([
      { method: "POST", path: "/api/connectors/github/oauth/start" },
      { method: "PUT", path: "/api/custom-connectors/example/values" },
      { method: "DELETE", path: "/api/connectors/github" },
    ])(
      "force-upgrades singleton-producing App bundles before $method $path route matching",
      async ({ method, path }) => {
        const app = createApp({
          signal: context.signal,
          routes: TEST_APP_ROUTES,
        });
        const response = await app.request(path, {
          method,
          headers: {
            [CLIENT_TYPE_HEADER]: CLIENT_TYPE_APP,
            [CLIENT_VERSION_HEADER]: "0.843.0",
          },
        });

        expect(response.status).toBe(CLIENT_FORCE_UPGRADE_STATUS);
        await expect(response.json()).resolves.toStrictEqual({
          error: "Client update required",
        });
        expect(response.headers.get("cache-control")).toBe("no-store");
      },
    );

    it("force-upgrades prereleases below the supported App release", async () => {
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", {
        headers: {
          [CLIENT_TYPE_HEADER]: CLIENT_TYPE_APP,
          [CLIENT_VERSION_HEADER]: `${MINIMUM_WEB_CLIENT_VERSION}-rc.1`,
        },
      });

      expect(response.status).toBe(CLIENT_FORCE_UPGRADE_STATUS);
    });

    it("rejects pre-MCP-reader app clients before custom connector route matching", async () => {
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/api/custom-connectors", {
        method: "GET",
        headers: {
          [CLIENT_TYPE_HEADER]: CLIENT_TYPE_APP,
          [CLIENT_VERSION_HEADER]: "0.715.1",
        },
      });

      expect(response.status).toBe(CLIENT_FORCE_UPGRADE_STATUS);
      await expect(response.json()).resolves.toStrictEqual({
        error: "Client update required",
      });
      expect(response.headers.get("cache-control")).toBe("no-store");
    });

    it.each(["0.621.0", "0.843.1", "0.855.1", "0.856.0"])(
      "force-upgrades App %s before current route matching",
      async (version) => {
        const app = createApp({
          signal: context.signal,
          routes: TEST_APP_ROUTES,
        });
        const response = await app.request("/api/chat-threads", {
          method: "GET",
          headers: {
            [CLIENT_TYPE_HEADER]: CLIENT_TYPE_APP,
            [CLIENT_VERSION_HEADER]: version,
          },
        });

        expect(response.status).toBe(CLIENT_FORCE_UPGRADE_STATUS);
        await expect(response.json()).resolves.toStrictEqual({
          error: "Client update required",
        });
        expect(response.headers.get("cache-control")).toBe("no-store");
      },
    );

    it.each([
      MINIMUM_WEB_CLIENT_VERSION,
      `${MINIMUM_WEB_CLIENT_VERSION}+build.1`,
    ])("allows the canonical web client floor %s", async (version) => {
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", {
        method: "GET",
        headers: {
          [CLIENT_TYPE_HEADER]: CLIENT_TYPE_APP,
          [CLIENT_VERSION_HEADER]: version,
        },
      });

      expect(response.status).toBe(200);
    });

    it("allows app clients newer than the canonical floor", async () => {
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", {
        method: "GET",
        headers: {
          [CLIENT_TYPE_HEADER]: CLIENT_TYPE_APP,
          [CLIENT_VERSION_HEADER]: NEWER_WEB_CLIENT_VERSION,
        },
      });

      expect(response.status).toBe(200);
    });

    it.each([CLIENT_TYPE_CLI, CLIENT_TYPE_DESKTOP])(
      "does not force upgrade %s clients",
      async (clientType) => {
        const app = createApp({
          signal: context.signal,
          routes: TEST_APP_ROUTES,
        });
        const response = await app.request("/health", {
          headers: {
            [CLIENT_TYPE_HEADER]: clientType,
            [CLIENT_VERSION_HEADER]: "0.599.18",
          },
        });

        expect(response.status).toBe(200);
      },
    );

    it.each([undefined, "", "development"])(
      "preserves App requests without a parseable version (%s)",
      async (version) => {
        const app = createApp({
          signal: context.signal,
          routes: TEST_APP_ROUTES,
        });
        const headers = new Headers({ [CLIENT_TYPE_HEADER]: CLIENT_TYPE_APP });
        if (version !== undefined) {
          headers.set(CLIENT_VERSION_HEADER, version);
        }
        const response = await app.request("/health", { headers });

        expect(response.status).toBe(200);
      },
    );

    it("preserves requests without a client type", async () => {
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", {
        method: "GET",
        headers: {
          [CLIENT_VERSION_HEADER]: "0.843.0",
        },
      });

      expect(response.status).toBe(200);
    });
  });

  // This suite owns request-log wiring, so log fields are the tested contract.
  describe("axiom request log", () => {
    it.each([DESKTOP_PRODUCT_ZERO, DESKTOP_PRODUCT_OKOU])(
      "records client headers for explicit %s Desktop requests",
      async (product) => {
        context.mocks.axiom.flush.mockResolvedValue(undefined);
        const app = createApp({
          signal: context.signal,
          routes: TEST_APP_ROUTES,
        });
        const response = await app.request("https://api.okou.test/health", {
          method: "GET",
          headers: {
            "user-agent": "okou-test-agent",
            "x-forwarded-for": "203.0.113.10, 198.51.100.5",
            "x-client-version": MINIMUM_WEB_CLIENT_VERSION,
            "x-client-type": CLIENT_TYPE_DESKTOP,
            [CLIENT_PRODUCT_HEADER]: product,
            "x-client-session-id": "session-test",
            "x-client-request-id": "request-test",
          },
        });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({ status: "ok" });
        await flushWaitUntilForTest();

        const [event] = axiomRequestLogEvents(context);
        expect(event).toMatchObject({
          method: "GET",
          status: 200,
          host: "api.okou.test",
          path_template: "/health",
          remote_addr: "203.0.113.10",
          user_agent: "okou-test-agent",
          x_client_version: MINIMUM_WEB_CLIENT_VERSION,
          x_client_type: CLIENT_TYPE_DESKTOP,
          x_client_product: product,
          x_client_session_id: "session-test",
          x_client_request_id: "request-test",
        });
        expect(event?._time).toStrictEqual(expect.any(String));
        expect(event?.request_time_ms).toStrictEqual(expect.any(Number));
        expect(context.mocks.axiom.flush).toHaveBeenCalledWith({
          client: "telemetry",
        });
      },
    );

    it.each([undefined, "", "unknown", "Okou", "zero,okou"])(
      "preserves Desktop requests and metadata with unclassified product %s",
      async (product) => {
        const app = createApp({
          signal: context.signal,
          routes: TEST_APP_ROUTES,
        });
        const headers = new Headers({
          "user-agent": "okou-test-agent",
          "x-forwarded-for": "203.0.113.10, 198.51.100.5",
          [CLIENT_TYPE_HEADER]: CLIENT_TYPE_DESKTOP,
          [CLIENT_VERSION_HEADER]: MINIMUM_WEB_CLIENT_VERSION,
          "x-client-session-id": "session-test",
          "x-client-request-id": "request-test",
        });
        if (product !== undefined) {
          headers.set(CLIENT_PRODUCT_HEADER, product);
        }
        const response = await app.request("https://api.okou.test/health", {
          method: "GET",
          headers,
        });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({ status: "ok" });
        await flushWaitUntilForTest();

        const [event] = axiomRequestLogEvents(context);
        expect(event).toMatchObject({
          method: "GET",
          status: 200,
          host: "api.okou.test",
          path_template: "/health",
          remote_addr: "203.0.113.10",
          user_agent: "okou-test-agent",
          x_client_version: MINIMUM_WEB_CLIENT_VERSION,
          x_client_type: CLIENT_TYPE_DESKTOP,
          x_client_session_id: "session-test",
          x_client_request_id: "request-test",
        });
        expect(event?._time).toStrictEqual(expect.any(String));
        expect(event?.request_time_ms).toStrictEqual(expect.any(Number));
        expect(event).not.toHaveProperty("x_client_product");
      },
    );

    it.each([CLIENT_TYPE_APP, CLIENT_TYPE_CLI, undefined])(
      "preserves non-Desktop client type %s with a product header",
      async (clientType) => {
        const app = createApp({
          signal: context.signal,
          routes: TEST_APP_ROUTES,
        });
        const headers = new Headers({
          [CLIENT_PRODUCT_HEADER]: DESKTOP_PRODUCT_OKOU,
        });
        if (clientType !== undefined) {
          headers.set(CLIENT_TYPE_HEADER, clientType);
        }
        const response = await app.request("/health", { headers });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({ status: "ok" });
        await flushWaitUntilForTest();

        const [event] = axiomRequestLogEvents(context);
        expect(event).toMatchObject({
          method: "GET",
          status: 200,
          path_template: "/health",
        });
        expect(event).not.toHaveProperty("x_client_product");
        if (clientType === undefined) {
          expect(event).not.toHaveProperty("x_client_type");
        } else {
          expect(event).toMatchObject({ x_client_type: clientType });
        }
      },
    );

    it("omits client header fields when they are absent", async () => {
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", { method: "GET" });

      expect(response.status).toBe(200);
      await flushWaitUntilForTest();

      const [event] = axiomRequestLogEvents(context);
      expect(event).toMatchObject({
        method: "GET",
        status: 200,
        path_template: "/health",
      });
      expect(event).not.toHaveProperty("x_client_version");
      expect(event).not.toHaveProperty("x_client_type");
      expect(event).not.toHaveProperty("x_client_product");
      expect(event).not.toHaveProperty("x_client_session_id");
      expect(event).not.toHaveProperty("x_client_request_id");
    });
  });

  describe("flush middleware", () => {
    it("calls flushLogs after a successful response", async () => {
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const response = await app.request("/health", { method: "GET" });

      expect(response.status).toBe(200);
      await flushWaitUntilForTest();
      expect(mockFlushLogs).toHaveBeenCalledWith();
    });
  });
});
