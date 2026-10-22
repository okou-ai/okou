// @vitest-environment-options {"url":"https://app.okou.ai/"}

import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { platformRealtimeTokenContract } from "@okouai/api-contracts/contracts/realtime";
import { testContext } from "../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise, settle } from "../../signals/utils.ts";
import { mockNow, now } from "../time.ts";
import { createAblyAuthCallback } from "../ably-auth.ts";
import { initSharedDatabaseWorkerSentry } from "../../shared-database/worker-sentry.ts";
import { createAblyRealtime } from "../ably-realtime.ts";

// The auth deadline has no page surface. Exercise public requestToken on the
// real locked SDK, not the page-test Ably alias (whose plugin is a Symbol).
vi.mock("ably/modular", async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import("../../mocks/ably.ts")>()),
    ...(await import(import.meta.resolve("ably/modular"))),
  };
});
const context = testContext();

function prepare() {
  mockNow(new Date("2026-10-14T02:00:00Z"), context.signal);
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

function client() {
  const authClient = initClient(platformRealtimeTokenContract, {
    baseUrl: "https://auth.example.com",
  });
  const ably = createAblyRealtime({
    autoConnect: false,
    endpoint: "exchange.example.com",
    logLevel: 0,
    fallbackHosts: ["fallback.example.com"],
    authCallback: createAblyAuthCallback(() => {
      return authClient;
    }, context.signal),
  });
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
  const ably = client();
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
