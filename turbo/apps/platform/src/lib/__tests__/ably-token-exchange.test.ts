// @vitest-environment-options {"url":"https://app.okou.ai/"}

import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { platformRealtimeTokenContract } from "@okouai/api-contracts/contracts/realtime";
import { AUTH_FAILURE_DIAGNOSTICS_EXPIRES_AT } from "@okouai/core/temporary-auth-diagnostics";
import { testContext } from "../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise, settle } from "../../signals/utils.ts";
import { createAuthedContractClient } from "../../signals/api-client-base.ts";
import { mockNow, now } from "../time.ts";
import { createAblyAuthCallback } from "../ably-auth.ts";
import { initSharedDatabaseWorkerSentry } from "../../shared-database/worker-sentry.ts";
import { createAblyRealtime } from "../ably-realtime.ts";
import {
  createAblyAuthDiagnosticScope,
  observeAblyFetchRequest,
} from "../ably-auth-diagnostics.ts";
import type { AuthTokenProvider } from "../auth-diagnostics.ts";

// Protocol diagnostics have no page surface. Exercise public requestToken on
// the real locked SDK, not the page-test Ably alias (whose plugin is a Symbol).
vi.mock("ably/modular", async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import("../../mocks/ably.ts")>()),
    ...(await import(import.meta.resolve("ably/modular"))),
  };
});
const telemetry = vi.hoisted(() => {
  return {
    ingest:
      vi.fn<(dataset: string, events: Record<string, unknown>[]) => void>(),
  };
});
vi.mock("@axiomhq/js", () => {
  return {
    Axiom: class {
      ingest(dataset: string, events: Record<string, unknown>[]): void {
        telemetry.ingest(dataset, events);
      }
    },
  };
});
const context = testContext();

function lifecycle() {
  return telemetry.ingest.mock.calls.flatMap(([, entries]) => {
    return entries
      .filter((entry) => {
        return entry.name === "auth.lifecycle";
      })
      .map((entry) => {
        const attrs = entry["attributes.custom"];
        if (typeof attrs !== "object" || attrs === null) {
          throw new Error("Missing attributes");
        }
        return Object.fromEntries(Object.entries(attrs));
      });
  });
}

function prepare() {
  mockNow(new Date("2026-10-14T02:00:00Z"), context.signal);
  vi.stubEnv("VITE_AXIOM_CLIENT_TELEMETRY_TOKEN", "test-auth-telemetry");
  telemetry.ingest.mockReset();
}

function tokenRequest(clientId = "secret-client-id") {
  return {
    keyName: "secret-key.name",
    clientId,
    timestamp: now(),
    ttl: 3_600_000,
    capability: '{"secret-channel":["subscribe"]}',
    nonce: crypto.randomUUID(),
    mac: "secret-signature",
  };
}

function client(instance: string, getToken?: AuthTokenProvider) {
  const scope = createAblyAuthDiagnosticScope({ realtimeInstanceId: instance });
  const authClient = getToken
    ? createAuthedContractClient(platformRealtimeTokenContract, {
        baseUrl: "https://auth.example.com",
        clientVersion: "test",
        getToken,
        getVercelProtectionBypass: () => {
          return undefined;
        },
      })
    : initClient(platformRealtimeTokenContract, {
        baseUrl: "https://auth.example.com",
      });
  const ably = createAblyRealtime(
    {
      autoConnect: false,
      endpoint: "exchange.example.com",
      logLevel: 0,
      fallbackHosts: ["fallback.example.com"],
      authCallback: createAblyAuthCallback(
        () => {
          return authClient;
        },
        scope,
        context.signal,
      ),
    },
    scope,
    context.signal,
  );
  context.signal.addEventListener(
    "abort",
    () => {
      return ably.close();
    },
    { once: true },
  );
  return ably;
}

function controlledDeadline() {
  let expire: (() => void) | undefined;
  const originalSetTimeout = globalThis.setTimeout;
  const setTimeoutSpy = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation((callback, ms, ...args) => {
      if (ms === 5000) {
        expire = () => {
          if (typeof callback !== "function") {
            throw new Error("Auth deadline callback must be callable");
          }
          callback(...args);
        };
        return 1 as unknown as ReturnType<typeof globalThis.setTimeout>;
      }
      return originalSetTimeout(callback, ms, ...args);
    });
  return () => {
    const callback = expire;
    if (!callback) {
      throw new Error("Auth deadline was not scheduled");
    }
    setTimeoutSpy.mockRestore();
    callback();
  };
}

test("Auth deadline rejects a pending page token and permits a fresh renewal", async () => {
  prepare();
  const sentry = context.mocks.sentry();
  initSharedDatabaseWorkerSentry();
  const expire = controlledDeadline();
  const tokenStarted = createDeferredPromise<AbortSignal>(context.signal);
  let tokenReads = 0;
  let apiRequests = 0;
  context.mocks.http.post("https://auth.example.com/api/realtime/token", () => {
    apiRequests++;
    return HttpResponse.json(tokenRequest());
  });
  context.mocks.http.post(
    "https://exchange.example.com/keys/secret-key.name/requestToken",
    () => {
      return HttpResponse.json({
        token: "secret-response-token",
        issued: now(),
        expires: now() + 3_600_000,
      });
    },
  );
  const ably = client("deadline-token", (_diagnostic, signal) => {
    tokenReads++;
    if (tokenReads > 1) {
      return Promise.resolve("fresh-clerk-token");
    }
    if (!signal) {
      throw new Error("Token acquisition requires the auth signal");
    }
    const token = createDeferredPromise<string | null>(signal);
    tokenStarted.resolve(signal);
    return token.promise;
  });
  const result = settle(ably.auth.requestToken());
  const signal = await tokenStarted.promise;
  await expire();
  await expect(result).resolves.toMatchObject({
    ok: false,
    error: { code: 40_170 },
  });
  expect(signal.aborted).toBeTruthy();
  expect(signal.reason).toBeInstanceOf(DOMException);
  expect(signal.reason).toMatchObject({ name: "AbortError" });
  expect(context.signal.aborted).toBeFalsy();
  expect(apiRequests).toBe(0);

  await expect(ably.auth.requestToken()).resolves.toMatchObject({
    token: "secret-response-token",
  });
  expect(apiRequests).toBe(1);
  expect(sentry.reports).toStrictEqual([]);
});

test("Auth deadline aborts an in-flight platform token HTTP request without exchanging its late response", async () => {
  prepare();
  const sentry = context.mocks.sentry();
  initSharedDatabaseWorkerSentry();
  const expire = controlledDeadline();
  const started = createDeferredPromise<AbortSignal>(context.signal);
  const aborted = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  const finished = createDeferredPromise<void>(context.signal);
  let exchanges = 0;
  context.mocks.http.post(
    "https://auth.example.com/api/realtime/token",
    async ({ request }) => {
      request.signal.addEventListener(
        "abort",
        () => {
          aborted.resolve();
        },
        { once: true },
      );
      started.resolve(request.signal);
      await release.promise;
      finished.resolve();
      return HttpResponse.json(tokenRequest());
    },
  );
  context.mocks.http.post(
    "https://exchange.example.com/keys/secret-key.name/requestToken",
    () => {
      exchanges++;
      return HttpResponse.json({
        token: "secret-response-token",
        issued: now(),
        expires: now() + 3_600_000,
      });
    },
  );
  const ably = client("deadline-http");
  const result = settle(ably.auth.requestToken());
  const signal = await started.promise;
  await expire();
  await expect(result).resolves.toMatchObject({
    ok: false,
    error: { code: 40_170 },
  });
  await aborted.promise;
  expect(signal.aborted).toBeTruthy();
  expect(signal.reason).toMatchObject({ name: "AbortError" });
  expect(context.signal.aborted).toBeFalsy();
  release.resolve();
  await finished.promise;
  expect(exchanges).toBe(0);
  expect(sentry.reports).toStrictEqual([]);
});

function expectPrivate() {
  const payload = JSON.stringify(lifecycle());
  for (const secret of [
    "secret-key",
    "secret-client-id",
    "secret-channel",
    "secret-signature",
    "secret-response-token",
    "secret-error-message",
    "exchange.example.com",
    "fallback.example.com",
  ]) {
    expect(payload).not.toContain(secret);
  }
}

test("Real SDK exchange, overlapping invocations, and fallback keep original attribution", async () => {
  prepare();
  context.mocks.http.post("https://auth.example.com/api/realtime/token", () => {
    return HttpResponse.json(tokenRequest());
  });
  const firstSeen = createDeferredPromise<void>(context.signal);
  const releaseFirst = createDeferredPromise<void>(context.signal);
  let attempts = 0;
  context.mocks.http.post(
    "https://exchange.example.com/keys/secret-key.name/requestToken",
    async () => {
      attempts++;
      if (attempts === 1) {
        firstSeen.resolve();
        await releaseFirst.promise;
        return HttpResponse.json(
          {
            error: {
              code: 50_000,
              statusCode: 500,
              message: "secret-error-message",
            },
          },
          {
            status: 500,
            headers: {
              "X-Ably-ErrorCode": "50000",
              "X-Ably-ErrorMessage": "secret-error-message",
            },
          },
        );
      }
      return HttpResponse.json({
        token: "secret-response-token",
        issued: now(),
        expires: now() + 3_600_000,
      });
    },
  );
  context.mocks.http.post(
    "https://fallback.example.com/keys/secret-key.name/requestToken",
    () => {
      attempts++;
      return HttpResponse.json({
        token: "secret-response-token",
        issued: now(),
        expires: now() + 3_600_000,
      });
    },
  );
  const a = client("instance-a");
  const b = client("instance-b");
  const first = a.auth.requestToken();
  await firstSeen.promise;
  await expect(a.auth.requestToken()).resolves.toMatchObject({
    token: "secret-response-token",
  });
  await expect(b.auth.requestToken()).resolves.toMatchObject({
    token: "secret-response-token",
  });
  releaseFirst.resolve();
  await expect(first).resolves.toMatchObject({
    token: "secret-response-token",
  });
  expect(attempts).toBe(4);
  const events = lifecycle();
  const auth = events.filter((e) => {
    return e["okou.auth.stage"] === "ably_auth_started";
  });
  expect(auth).toHaveLength(3);
  expect(
    new Set(
      auth.map((e) => {
        return e["okou.auth.ably_auth_id"];
      }),
    ).size,
  ).toBe(3);
  const firstId = auth[0]?.["okou.auth.ably_auth_id"];
  const firstFinishes = events.filter((e) => {
    return (
      e["okou.auth.stage"] === "ably_token_exchange_finished" &&
      e["okou.auth.ably_auth_id"] === firstId
    );
  });
  expect(
    firstFinishes.map((e) => {
      return e["okou.auth.status"];
    }),
  ).toStrictEqual([500, 200]);
  expect(firstFinishes[0]).toMatchObject({
    "okou.auth.reason_code": 50_000,
    "okou.auth.reason_type": "http_5xx",
    "okou.auth.realtime_instance_id": "instance-a",
  });
  const starts = events.filter((e) => {
    return e["okou.auth.stage"] === "ably_token_exchange_started";
  });
  expect(starts).toHaveLength(4);
  expect(
    new Set(
      starts.map((e) => {
        return e["okou.auth.exchange_attempt_id"];
      }),
    ).size,
  ).toBe(4);
  for (const invocation of auth) {
    const finishes = events.filter((e) => {
      return (
        e["okou.auth.stage"] === "ably_token_exchange_finished" &&
        e["okou.auth.ably_auth_id"] === invocation["okou.auth.ably_auth_id"]
      );
    });
    expect(finishes.length).toBeGreaterThan(0);
    expect(
      finishes.every((e) => {
        return (
          e["okou.auth.realtime_instance_id"] ===
          invocation["okou.auth.realtime_instance_id"]
        );
      }),
    ).toBeTruthy();
  }
  expectPrivate();
});

test("Real SDK rejection remains rejection and emits sanitized attempt status", async () => {
  prepare();
  context.mocks.http.post("https://auth.example.com/api/realtime/token", () => {
    return HttpResponse.json(tokenRequest());
  });
  let exchanges = 0;
  context.mocks.http.post(
    "https://exchange.example.com/keys/secret-key.name/requestToken",
    () => {
      exchanges++;
      return HttpResponse.json(
        {
          error: {
            code: 40_101,
            statusCode: 401,
            message: "secret-error-message",
          },
        },
        {
          status: 401,
          headers: {
            "X-Ably-ErrorCode": "40101",
            "X-Ably-ErrorMessage": "secret-error-message",
          },
        },
      );
    },
  );
  const ably = client("rejected-instance");
  await expect(ably.auth.requestToken()).rejects.toMatchObject({
    code: 40_101,
    statusCode: 401,
  });
  expect(exchanges).toBe(1);
  expect(lifecycle()).toContainEqual(
    expect.objectContaining({
      "okou.auth.stage": "ably_token_exchange_finished",
      "okou.auth.status": 401,
      "okou.auth.reason_code": 40_101,
      "okou.auth.reason_type": "http_4xx",
    }),
  );
  expectPrivate();
});

test.each(["ingest", "none"])(
  "Observer is transparent when diagnostics are unavailable: %s",
  async (failure) => {
    prepare();
    if (failure === "ingest") {
      telemetry.ingest.mockImplementation(() => {
        throw new Error("telemetry unavailable");
      });
    }
    const result = {
      error: null,
      statusCode: 200,
      body: { token: "secret-response-token" },
    };
    const promise = Promise.resolve(result);
    const plugin = vi.fn<() => Promise<typeof result>>(() => {
      return promise;
    });
    const scope = createAblyAuthDiagnosticScope({ ablyAuthId: "transparent" });
    const observed = observeAblyFetchRequest(plugin, scope, context.signal);
    if (typeof observed !== "function") {
      throw new Error("Expected plugin");
    }
    const args = [
      "POST",
      {},
      "https://exchange.example.com/keys/secret-key.name/requestToken",
      {},
      {},
      "secret-signature",
    ];
    const returned = observed(...args);
    expect(returned).toBe(promise);
    await expect(promise).resolves.toBe(result);
    expect(plugin).toHaveBeenCalledExactlyOnceWith(...args);
    const error = new Error("secret-error-message");
    const rejected = Promise.reject(error);
    const rejectObserver = observeAblyFetchRequest(
      () => {
        return rejected;
      },
      scope,
      context.signal,
    );
    if (typeof rejectObserver !== "function") {
      throw new Error("Expected plugin");
    }
    expect(rejectObserver(...args)).toBe(rejected);
    await expect(rejected).rejects.toBe(error);
    const syncObserver = observeAblyFetchRequest(
      () => {
        throw error;
      },
      scope,
      context.signal,
    );
    if (typeof syncObserver !== "function") {
      throw new Error("Expected plugin");
    }
    expect(() => {
      return syncObserver(...args);
    }).toThrow(error);
    expectPrivate();
  },
);

test("Nonexchange traffic remains untouched", async () => {
  prepare();
  const scope = createAblyAuthDiagnosticScope({});
  const promise = Promise.resolve({ statusCode: 200 });
  const plugin = vi.fn<() => Promise<{ statusCode: number }>>(() => {
    return promise;
  });
  const observed = observeAblyFetchRequest(plugin, scope, context.signal);
  if (typeof observed !== "function") {
    throw new Error("Expected plugin");
  }
  expect(
    observed("POST", {}, "https://exchange.example.com/time", {}, null, null),
  ).toBe(promise);
  await promise;
  expect(plugin).toHaveBeenCalledOnce();
  expect(lifecycle()).toHaveLength(0);
});

test("Late settlement observes owner abort but does not cancel or emit past expiry", async () => {
  prepare();
  const scope = createAblyAuthDiagnosticScope({});
  const signal = AbortSignal.abort();
  const gate = createDeferredPromise<{ statusCode: number }>(context.signal);
  const observed = observeAblyFetchRequest(
    () => {
      return gate.promise;
    },
    scope,
    signal,
  );
  if (typeof observed !== "function") {
    throw new Error("Expected plugin");
  }
  expect(
    observed(
      "POST",
      {},
      "https://exchange.example.com/keys/secret-key.name/requestToken",
      {},
      null,
      null,
    ),
  ).toBe(gate.promise);
  gate.resolve({ statusCode: 200 });
  await gate.promise;
  expect(lifecycle()).toContainEqual(
    expect.objectContaining({
      "okou.auth.stage": "ably_token_exchange_finished",
      "okou.auth.owner_aborted": 1,
    }),
  );
  const late = createDeferredPromise<{ statusCode: number }>(context.signal);
  const lateObserver = observeAblyFetchRequest(
    () => {
      return late.promise;
    },
    scope,
    signal,
  );
  if (typeof lateObserver !== "function") {
    throw new Error("Expected plugin");
  }
  lateObserver(
    "POST",
    {},
    "https://exchange.example.com/keys/secret-key.name/requestToken",
    {},
    null,
    null,
  );
  const count = lifecycle().length;
  mockNow(new Date(AUTH_FAILURE_DIAGNOSTICS_EXPIRES_AT), context.signal);
  late.resolve({ statusCode: 200 });
  await expect(late.promise).resolves.toMatchObject({ statusCode: 200 });
  expect(lifecycle()).toHaveLength(count);
  const expiredPromise = Promise.resolve({ statusCode: 200 });
  const expiredObserver = observeAblyFetchRequest(
    () => {
      return expiredPromise;
    },
    scope,
    signal,
  );
  if (typeof expiredObserver !== "function") {
    throw new Error("Expected plugin");
  }
  expect(
    expiredObserver(
      "POST",
      {},
      "https://exchange.example.com/keys/secret-key.name/requestToken",
      {},
      null,
      null,
    ),
  ).toBe(expiredPromise);
  await expiredPromise;
  expect(lifecycle()).toHaveLength(count);
});

test("Real SDK fallback observes timeout-like status before error normalization", async () => {
  prepare();
  context.mocks.http.post("https://auth.example.com/api/realtime/token", () => {
    return HttpResponse.json(tokenRequest());
  });
  let exchanges = 0;
  context.mocks.http.post(
    "https://exchange.example.com/keys/secret-key.name/requestToken",
    () => {
      exchanges++;
      return new HttpResponse(null, { status: 408 });
    },
  );
  context.mocks.http.post(
    "https://fallback.example.com/keys/secret-key.name/requestToken",
    () => {
      exchanges++;
      return HttpResponse.json({
        token: "secret-response-token",
        issued: now(),
        expires: now() + 3_600_000,
      });
    },
  );
  const ably = client("timeout-instance");
  await expect(ably.auth.requestToken()).resolves.toMatchObject({
    token: "secret-response-token",
  });
  expect(exchanges).toBe(2);
  const finishes = lifecycle().filter((e) => {
    return e["okou.auth.stage"] === "ably_token_exchange_finished";
  });
  expect(
    finishes.map((e) => {
      return e["okou.auth.status"];
    }),
  ).toStrictEqual([408, 200]);
  expect(finishes[0]).toMatchObject({
    "okou.auth.reason_status_code": 408,
    "okou.auth.reason_type": "http_408",
  });
  expect(finishes[0]?.["okou.auth.ably_auth_id"]).toBe(
    finishes[1]?.["okou.auth.ably_auth_id"],
  );
  expectPrivate();
});
