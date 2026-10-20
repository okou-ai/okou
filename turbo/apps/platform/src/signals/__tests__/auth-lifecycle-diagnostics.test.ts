// @vitest-environment-options {"url":"https://app.okou.ai/"}

import { CLIENT_REQUEST_ID_HEADER } from "@okouai/api-contracts/contracts/client-headers";
import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { AUTH_FAILURE_DIAGNOSTICS_EXPIRES_AT } from "@okouai/core/temporary-auth-diagnostics";
import { beforeEach, expect, test, vi } from "vitest";

import { mockedClerk } from "../../__tests__/mock-auth.ts";
import { setupPage } from "../../__tests__/page-helper.ts";
import { mockNow } from "../../lib/time.ts";
import { apiClient$ } from "../api-client.ts";
import { resetSignal } from "../utils.ts";
import { testContext } from "./test-helpers.ts";

const axiom = vi.hoisted(() => {
  return {
    ingest:
      vi.fn<(dataset: string, events: Record<string, unknown>[]) => void>(),
  };
});

vi.mock("@axiomhq/js", () => {
  return {
    Axiom: class {
      ingest(dataset: string, events: Record<string, unknown>[]): void {
        axiom.ingest(dataset, events);
      }
    },
  };
});

// Telemetry is the contract under test here: observe the external Axiom SDK
// boundary while exercising real token reads and the contract client's HTTP.
const context = testContext();
const NOW = Date.parse("2026-09-29T02:30:00Z");
const denied = {
  error: { code: "UNAUTHORIZED", message: "Not authenticated" },
} as const;
const emptyRows = Object.freeze({
  rows: [],
  cursor: { lastEventId: null, lastSeqId: 0 } as const,
  hasMore: false,
});

beforeEach(() => {
  mockNow(NOW, context.signal);
  vi.stubEnv("VITE_AXIOM_CLIENT_TELEMETRY_TOKEN", "xaat-test-ingest-token");
  axiom.ingest.mockReset();
  context.signal.addEventListener(
    "abort",
    () => {
      return vi.unstubAllEnvs();
    },
    {
      once: true,
    },
  );
});

function token(expiresAt = NOW / 1000 + 60): string {
  const claims = {
    exp: expiresAt,
    sub: "private-user",
    org_id: "private-org",
    sid: "private-session",
    email: "private-email@example.com",
  };
  return `header.${btoa(JSON.stringify(claims)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}.private-signature`;
}

async function client(
  sdkGetToken: (options?: {
    readonly skipCache?: boolean;
  }) => Promise<string | null>,
) {
  // There is no page-visible surface for the external telemetry contract.
  // Enter real Platform bootstrap on a route with no authenticated page data.
  // The Clerk SDK mock belongs to context.mocks, not a fabricated token source.
  context.mocks.clerk();
  await setupPage({
    context,
    path: "/auth-diagnostics-no-page",
    host: "app.okou.ai",
    appVersion: "0.984.1",
  });
  mockedClerk.sessionGetToken.mockImplementation(sdkGetToken);
  // Startup itself reads tokens and emits telemetry. Observe only subsequent
  // caller-owned requests, after finite production startup has completed.
  axiom.ingest.mockClear();
  return context.store.get(apiClient$)(chatThreadEventsContract);
}

function request(threadId = crypto.randomUUID(), signal = context.signal) {
  return {
    params: { threadId },
    query: { limit: 50, sinceSeqId: 0 },
    fetchOptions: { signal },
  };
}

function lifecycle() {
  return axiom.ingest.mock.calls.flatMap(([dataset, events]) => {
    expect(dataset).toBe("vm0-client-telemetry-prod");
    return events.filter((event) => {
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

function stage(name: string, operationId?: unknown) {
  const matches = lifecycle().filter((event) => {
    const fields = attributes(event);
    return (
      fields["okou.auth.stage"] === name &&
      (operationId === undefined ||
        fields["okou.auth.operation_id"] === operationId)
    );
  });
  expect(matches).toHaveLength(1);
  const event = matches[0];
  if (!event) {
    throw new Error(`Missing auth lifecycle stage: ${name}`);
  }
  return event;
}

test("An SDK completion after a clock jump reports completion-time TTL for both normal-provider 401 attempts", async () => {
  const sdkStarted = context.mocks.deferred<void>();
  const sdkResult = context.mocks.deferred<string | null>();
  const credential = token(NOW / 1000 + 5);
  const sdkGetToken = vi.fn<
    (options?: { readonly skipCache?: boolean }) => Promise<string | null>
  >((options) => {
    expect(options?.skipCache).toBeFalsy();
    if (!sdkStarted.settled()) {
      sdkStarted.resolve();
    }
    return sdkResult.promise;
  });
  const observed: Headers[] = [];
  context.mocks.api(chatThreadEventsContract.rows, ({ request, respond }) => {
    observed.push(request.headers);
    return respond(401, denied);
  });
  const api = await client(sdkGetToken);
  const response = api.rows(request());
  await sdkStarted.promise;
  const started = stage("clerk_sdk_started");
  expect(started._time).toBe(new Date(NOW).toISOString());

  const completedAt = NOW + 20_000;
  mockNow(completedAt, context.signal);
  sdkResult.resolve(credential);
  await expect(response).resolves.toMatchObject({ status: 401, body: denied });

  expect(sdkGetToken.mock.calls).toStrictEqual([[undefined], [undefined]]);
  expect(observed).toHaveLength(2);
  const starts = lifecycle().filter((event) => {
    return attributes(event)["okou.auth.stage"] === "token_read_started";
  });
  expect(starts).toHaveLength(2);
  const operationIds = starts.map((event) => {
    return attributes(event)["okou.auth.operation_id"];
  });
  expect(new Set(operationIds).size).toBe(2);
  expect(
    new Set(
      observed.map((headers) => {
        return headers.get(CLIENT_REQUEST_ID_HEADER);
      }),
    ).size,
  ).toBe(2);
  expect(lifecycle()).toHaveLength(12);
  for (const [attempt, operationId] of operationIds.entries()) {
    expect(operationId).toStrictEqual(expect.any(String));
    const headers = observed[attempt];
    expect(headers?.get("Authorization")).toBe(`Bearer ${credential}`);
    const requestId = headers?.get(CLIENT_REQUEST_ID_HEADER);
    expect(requestId).toStrictEqual(expect.any(String));
    for (const name of [
      "token_read_started",
      "clerk_sdk_started",
      "clerk_sdk_finished",
      "token_read_finished",
      "http_send_invoked",
      "http_finished",
    ]) {
      expect(stage(name, operationId)).toBeDefined();
    }
    for (const name of [
      "clerk_sdk_finished",
      "token_read_finished",
      "http_send_invoked",
      "http_finished",
    ]) {
      const event = stage(name, operationId);
      expect(event._time).toBe(new Date(completedAt).toISOString());
      expect(attributes(event)).toMatchObject({
        "okou.auth.event_at_ms": completedAt,
        "okou.auth.token_ttl_seconds": -15,
        "okou.auth.token_present": 1,
        "okou.auth.jwt_decoded": 1,
      });
    }
    expect(attributes(stage("clerk_sdk_finished", operationId))).toMatchObject({
      "okou.auth.started_at_ms": attempt === 0 ? NOW : completedAt,
      "okou.auth.elapsed_wall_ms": attempt === 0 ? 20_000 : 0,
      "okou.auth.owner_aborted": 0,
      "okou.auth.skip_cache": 0,
    });
    for (const name of ["http_send_invoked", "http_finished"]) {
      expect(attributes(stage(name, operationId))).toMatchObject({
        "okou.auth.http_request_id": requestId,
        "okou.auth.method": "GET",
        "okou.auth.route": "/api/chat-threads/:threadId/event-rows",
      });
    }
    expect(
      attributes(stage("http_finished", operationId))["okou.auth.status"],
    ).toBe(401);
  }
  const red = axiom.ingest.mock.calls.flatMap(([, events]) => {
    return events.filter((event) => {
      return event.name === "GET /api/chat-threads/:threadId/event-rows";
    });
  });
  expect(red).toHaveLength(2);
  for (const event of red) {
    expect(event).toMatchObject({
      kind: "client",
      "attributes.http.response.status_code": 401,
    });
  }
  const emitted = JSON.stringify(axiom.ingest.mock.calls);
  for (const secret of [
    credential,
    "private-user",
    "private-org",
    "private-session",
    "private-email@example.com",
    "private-signature",
  ]) {
    expect(emitted).not.toContain(secret);
  }
});

test("Concurrent calls keep separate operation IDs correlated with their actual HTTP request IDs", async () => {
  const firstStarted = context.mocks.deferred<void>();
  const firstToken = context.mocks.deferred<string | null>();
  const firstThread = crypto.randomUUID();
  const secondThread = crypto.randomUUID();
  const headers = new Map<string, Headers>();
  context.mocks.api(
    chatThreadEventsContract.rows,
    ({ params, request, respond }) => {
      headers.set(params.threadId, request.headers);
      return respond(200, emptyRows);
    },
  );
  const sdkGetToken = vi
    .fn<() => Promise<string | null>>()
    .mockImplementationOnce(() => {
      firstStarted.resolve();
      return firstToken.promise;
    })
    .mockResolvedValueOnce(token());
  const api = await client(sdkGetToken);
  const first = api.rows(request(firstThread));
  await firstStarted.promise;
  const firstOperation = attributes(stage("token_read_started"))[
    "okou.auth.operation_id"
  ];
  await expect(api.rows(request(secondThread))).resolves.toMatchObject({
    status: 200,
    body: emptyRows,
  });
  firstToken.resolve(token());
  await expect(first).resolves.toMatchObject({ status: 200, body: emptyRows });

  const sends = lifecycle().filter((event) => {
    return attributes(event)["okou.auth.stage"] === "http_send_invoked";
  });
  expect(sends).toHaveLength(2);
  const firstSend = sends.find((event) => {
    return attributes(event)["okou.auth.operation_id"] === firstOperation;
  });
  const secondSend = sends.find((event) => {
    return attributes(event)["okou.auth.operation_id"] !== firstOperation;
  });
  expect(firstSend && attributes(firstSend)["okou.auth.http_request_id"]).toBe(
    headers.get(firstThread)?.get(CLIENT_REQUEST_ID_HEADER),
  );
  expect(
    secondSend && attributes(secondSend)["okou.auth.http_request_id"],
  ).toBe(headers.get(secondThread)?.get(CLIENT_REQUEST_ID_HEADER));
  expect(
    new Set(
      sends.map((event) => {
        return attributes(event)["okou.auth.operation_id"];
      }),
    ).size,
  ).toBe(2);
  expect(headers.size).toBe(2);
});

test.each([null, "malformed.private-credential"])(
  "Missing or malformed credentials preserve the HTTP response without leaking credential material (%#)",
  async (credential) => {
    const observed: Headers[] = [];
    context.mocks.api(chatThreadEventsContract.rows, ({ request, respond }) => {
      observed.push(request.headers);
      return respond(401, denied);
    });
    const sdkGetToken = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValue(credential);
    const api = await client(sdkGetToken);
    await expect(api.rows(request())).resolves.toMatchObject({
      status: 401,
      body: denied,
    });
    expect(sdkGetToken.mock.calls).toStrictEqual([[undefined], [undefined]]);
    expect(observed).toHaveLength(2);
    for (const headers of observed) {
      expect(headers.get("Authorization")).toBe(
        credential === null ? null : `Bearer ${credential}`,
      );
    }
    for (const name of ["clerk_sdk_finished", "http_send_invoked"]) {
      const events = lifecycle().filter((event) => {
        return attributes(event)["okou.auth.stage"] === name;
      });
      expect(events).toHaveLength(2);
      for (const event of events) {
        const fields = attributes(event);
        expect(fields).toMatchObject({
          "okou.auth.token_present": credential === null ? 0 : 1,
          "okou.auth.jwt_decoded": 0,
        });
        expect(fields).not.toHaveProperty("okou.auth.token_ttl_seconds");
      }
    }
    expect(JSON.stringify(axiom.ingest.mock.calls)).not.toContain(
      "private-credential",
    );
  },
);

test.each([
  new Error("private-sdk-error"),
  new DOMException("private-sdk-abort", "AbortError"),
])(
  "SDK failures retain the original rejection and never send HTTP (%#)",
  async (error) => {
    const observed: Headers[] = [];
    context.mocks.api(chatThreadEventsContract.rows, ({ request, respond }) => {
      observed.push(request.headers);
      return respond(200, emptyRows);
    });
    const sdkGetToken = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValue(error);
    const api = await client(sdkGetToken);
    await expect(api.rows(request())).rejects.toBe(error);
    expect(observed).toHaveLength(0);
    expect(sdkGetToken).toHaveBeenCalledOnce();
    for (const name of ["clerk_sdk_finished", "token_read_finished"]) {
      expect(attributes(stage(name))["okou.client.outcome"]).toBe(
        error.name === "AbortError" ? "aborted" : "error",
      );
    }
    expect(
      lifecycle().some((event) => {
        return attributes(event)["okou.auth.stage"] === "http_send_invoked";
      }),
    ).toBeFalsy();
    expect(JSON.stringify(axiom.ingest.mock.calls)).not.toContain(
      error.message,
    );
  },
);

test.each([
  new Error("Axiom unavailable"),
  new DOMException("Axiom cancelled", "AbortError"),
])(
  "Axiom lifecycle ingestion failures do not change the SDK token or HTTP response (%#)",
  async (error) => {
    const credential = token();
    const observed: Headers[] = [];
    context.mocks.api(chatThreadEventsContract.rows, ({ request, respond }) => {
      observed.push(request.headers);
      return respond(200, emptyRows);
    });
    const sdkGetToken = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValue(credential);
    const api = await client(sdkGetToken);
    axiom.ingest.mockImplementation((_, events) => {
      if (
        events.some((event) => {
          return event.name === "auth.lifecycle";
        })
      ) {
        throw error;
      }
    });
    await expect(api.rows(request())).resolves.toMatchObject({
      status: 200,
      body: emptyRows,
    });
    expect(sdkGetToken).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(observed).toHaveLength(1);
    expect(observed[0]?.get("Authorization")).toBe(`Bearer ${credential}`);
    expect(lifecycle().length).toBeGreaterThan(0);
  },
);

test("The expiry cutoff stops new lifecycle records while token reads and HTTP continue", async () => {
  const observed: Headers[] = [];
  context.mocks.api(chatThreadEventsContract.rows, ({ request, respond }) => {
    observed.push(request.headers);
    return respond(200, emptyRows);
  });
  const sdkGetToken = vi
    .fn<() => Promise<string | null>>()
    .mockResolvedValue(token());
  const api = await client(sdkGetToken);
  mockNow(AUTH_FAILURE_DIAGNOSTICS_EXPIRES_AT - 1, context.signal);
  await expect(api.rows(request())).resolves.toMatchObject({
    status: 200,
    body: emptyRows,
  });
  expect(lifecycle().length).toBeGreaterThan(0);

  axiom.ingest.mockClear();
  mockNow(AUTH_FAILURE_DIAGNOSTICS_EXPIRES_AT, context.signal);
  await expect(api.rows(request())).resolves.toMatchObject({
    status: 200,
    body: emptyRows,
  });
  expect(lifecycle()).toHaveLength(0);
  expect(observed).toHaveLength(2);
  expect(
    axiom.ingest.mock.calls.flatMap(([, events]) => {
      return events;
    }),
  ).toStrictEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "GET /api/chat-threads/:threadId/event-rows",
        "attributes.http.response.status_code": 200,
      }),
    ]),
  );
});

test("A late SDK settlement records an aborted owner at completion time without sending HTTP", async () => {
  const resetOwner$ = resetSignal();
  const owner = context.store.set(resetOwner$, context.signal);
  const sdkStarted = context.mocks.deferred<void>();
  const sdkResult = context.mocks.deferred<string | null>();
  const sdkFinishedRecord = context.mocks.deferred<void>();
  const observed: Headers[] = [];
  context.mocks.api(chatThreadEventsContract.rows, ({ request, respond }) => {
    observed.push(request.headers);
    return respond(200, emptyRows);
  });
  const sdkGetToken = vi.fn<() => Promise<string | null>>(() => {
    sdkStarted.resolve();
    return sdkResult.promise;
  });
  const api = await client(sdkGetToken);
  axiom.ingest.mockImplementation((_, events) => {
    if (
      events.some((event) => {
        return (
          event.name === "auth.lifecycle" &&
          attributes(event)["okou.auth.stage"] === "clerk_sdk_finished"
        );
      })
    ) {
      sdkFinishedRecord.resolve();
    }
  });
  const pending = api.rows(request(crypto.randomUUID(), owner));
  // Attach the rejection observer before cancellation; await that observer
  // below after the SDK has started and the request owner has been aborted.
  const rejected = (async () => {
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  })();
  await sdkStarted.promise;
  context.store.set(resetOwner$, context.signal);
  await rejected;

  const completedAt = NOW + 20_000;
  mockNow(completedAt, context.signal);
  sdkResult.resolve(token(NOW / 1000 + 5));
  await sdkFinishedRecord.promise;
  expect(stage("clerk_sdk_finished")._time).toBe(
    new Date(completedAt).toISOString(),
  );
  expect(attributes(stage("clerk_sdk_finished"))).toMatchObject({
    "okou.auth.owner_aborted": 1,
    "okou.auth.event_at_ms": completedAt,
    "okou.auth.started_at_ms": NOW,
    "okou.auth.token_ttl_seconds": -15,
  });
  expect(attributes(stage("token_read_finished"))).toMatchObject({
    "okou.auth.owner_aborted": 1,
    "okou.client.outcome": "aborted",
  });
  expect(sdkGetToken).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(observed).toHaveLength(0);
  expect(
    lifecycle().some((event) => {
      return attributes(event)["okou.auth.stage"] === "http_send_invoked";
    }),
  ).toBeFalsy();
});
