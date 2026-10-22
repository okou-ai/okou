import { waitFor } from "@testing-library/react";
import { platformRealtimeTokenContract } from "@okouai/api-contracts/contracts/realtime";
import { expect, test, vi } from "vitest";

import { mockedClerk } from "../../__tests__/mock-auth.ts";
import { setupPage } from "../../__tests__/page-helper.ts";
import { mockNow, now } from "../../lib/time.ts";
import { testContext } from "./test-helpers.ts";

const axiomTelemetry = vi.hoisted(() => {
  return {
    ingest:
      vi.fn<(dataset: string, events: Record<string, unknown>[]) => void>(),
  };
});
vi.mock("@axiomhq/js", () => {
  return {
    Axiom: class {
      ingest(dataset: string, events: Record<string, unknown>[]): void {
        axiomTelemetry.ingest(dataset, events);
      }
    },
  };
});

// No page-visible diagnostics surface: use real Platform startup and the
// supported MessagePort transport, then observe the external Ably/Axiom SDKs.
const context = testContext();

function lifecycle() {
  return axiomTelemetry.ingest.mock.calls.flatMap(([, entries]) => {
    return entries.filter((event) => {
      return event.name === "auth.lifecycle";
    });
  });
}

function attributes(event: Record<string, unknown>): Record<string, unknown> {
  const value = event["attributes.custom"];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected auth lifecycle attributes");
  }
  return Object.fromEntries(Object.entries(value));
}

test.each([false, true])(
  "Observe Ably auth and retry state without changing SDK work (telemetry fails: %s)",
  async (telemetryFails) => {
    mockNow(new Date("2026-10-14T02:00:00Z"), context.signal);
    context.mocks.clerk();
    axiomTelemetry.ingest.mockReset();
    axiomTelemetry.ingest.mockImplementation((_dataset, events) => {
      if (
        telemetryFails &&
        events.some((event) => {
          return event.name === "auth.lifecycle";
        })
      ) {
        throw new Error("telemetry unavailable");
      }
    });
    const requests: Headers[] = [];
    context.mocks.api(
      platformRealtimeTokenContract.create,
      ({ request, respond }) => {
        requests.push(request.headers);
        return respond(200, {
          keyName: "mock-ably-key",
          clientId: "test-user-123",
          timestamp: now(),
          ttl: 60 * 60 * 1000,
          capability: '{"*":["*"]}',
          nonce: crypto.randomUUID(),
          mac: "mock-signature",
        });
      },
    );
    await setupPage({
      context,
      path: "/auth-diagnostics-no-page",
      host: "app.okou.ai",
      appVersion: "0.984.1",
      sharedWorkerAppVersion: "0.984.1",
      sharedWorkerTestTransport: "message-port",
      env: { VITE_AXIOM_CLIENT_TELEMETRY_TOKEN: "test-auth-telemetry" },
      auth: {
        user: {
          id: "test-user-123",
          fullName: "Test User",
          email: "test@example.com",
        },
        session: { token: "test-token" },
        organization: {
          activeOrg: { id: "test-org-123", name: "Test Organization" },
          memberships: [{ id: "test-org-123" }],
        },
      },
    });
    // Finite page setup does not await the Worker's background Ably startup.
    // Wait for its real SDK auth callback and observed connection transition,
    // including when Axiom ingest throws after receiving the record.
    await waitFor(() => {
      expect(context.mocks.ably.getAuthTokenHistory()).toHaveLength(1);
      expect(lifecycle()).toContainEqual(
        expect.objectContaining({
          "attributes.custom": expect.objectContaining({
            "okou.auth.stage": "ably_connection",
            "okou.auth.state": "connected",
          }),
        }),
      );
    });
    expect(requests).toHaveLength(1);
    context.mocks.ably.triggerConnectionState("suspended", {
      code: 80_003,
      statusCode: 408,
      retryIn: 30_000,
      cause: {
        code: 50_003,
        statusCode: 408,
        message: "secret-token-exchange-message",
        cause: { code: 40_170, statusCode: 403 },
      },
    });
    context.mocks.ably.triggerConnectionState("connected");
    const renewed = await context.mocks.ably.triggerReauth();
    expect(renewed).toMatchObject({
      clientId: "test-user-123",
      mac: "mock-signature",
    });
    expect(context.mocks.ably.getAuthTokenHistory()).toHaveLength(2);
    expect(requests).toHaveLength(2);
    for (const [options] of mockedClerk.sessionGetToken.mock.calls) {
      expect(options?.skipCache).toBeFalsy();
    }
    const events = lifecycle();
    expect(events).toContainEqual(
      expect.objectContaining({
        "attributes.custom": expect.objectContaining({
          "okou.auth.stage": "ably_connection",
          "okou.auth.state": "suspended",
          "okou.auth.retry_in_ms": 30_000,
          "okou.auth.reason_code": 80_003,
          "okou.auth.reason_status_code": 408,
          "okou.auth.reason_cause_depth": 2,
          "okou.auth.reason_cause_code": 40_170,
          "okou.auth.reason_cause_status_code": 403,
          "okou.auth.reason_cause_type": "http_4xx",
        }),
      }),
    );
    const invocations = events.filter((event) => {
      return attributes(event)["okou.auth.stage"] === "ably_auth_started";
    });
    expect(invocations).toHaveLength(2);
    const ids = invocations.map((event) => {
      return attributes(event)["okou.auth.ably_auth_id"];
    });
    expect(new Set(ids).size).toBe(2);
    const payload = JSON.stringify(events);
    for (const secret of [
      "test-token",
      "test-user-123",
      "test-org-123",
      "test@example.com",
      "user:test-user-123",
      "org:test-org-123",
      "mock-signature",
      "mock-ably-key",
      "secret-token-exchange-message",
    ]) {
      expect(payload).not.toContain(secret);
    }
  },
);
