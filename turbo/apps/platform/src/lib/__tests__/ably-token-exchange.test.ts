// @vitest-environment-options {"url":"https://app.okou.ai/"}

import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { platformRealtimeTokenContract } from "@okouai/api-contracts/contracts/realtime";
import { testContext } from "../../signals/__tests__/test-helpers.ts";
import { mockNow, now } from "../time.ts";
import { createAblyAuthCallback } from "../ably-auth.ts";
import { createAblyRealtime } from "../ably-realtime.ts";

// Exercise public requestToken on the real SDK.
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

test("Ably exchanges the signed platform token request", async () => {
  prepare();
  const request = tokenRequest();
  context.mocks.http.post("https://auth.example.com/api/realtime/token", () => {
    return HttpResponse.json(request);
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

  await expect(client().auth.requestToken()).resolves.toMatchObject({
    token: "secret-response-token",
  });
});
