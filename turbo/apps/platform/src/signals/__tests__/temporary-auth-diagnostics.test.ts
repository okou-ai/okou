// @vitest-environment-options {"url":"https://app.okou.ai/"}

import {
  CLIENT_REQUEST_ID_HEADER,
  CLIENT_SESSION_ID_HEADER,
} from "@okouai/api-contracts/contracts/client-headers";
import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { AUTH_FAILURE_DIAGNOSTICS_EXPIRES_AT } from "@okouai/core/temporary-auth-diagnostics";
import { beforeEach, expect, test, vi } from "vitest";

import { mockNow } from "../../lib/time.ts";
import { createAuthedContractClient } from "../api-client-base.ts";
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

// The diagnostic's external contract is the Axiom payload, exercised through
// a real contract client and HTTP responses rather than the logging helper.
const context = testContext();
const NOW = Date.parse("2026-09-29T02:30:00Z");
const denied = {
  error: { code: "UNAUTHORIZED", message: "Not authenticated" },
} as const;

beforeEach(() => {
  mockNow(NOW, context.signal);
  vi.stubEnv("VITE_AXIOM_CLIENT_TELEMETRY_TOKEN", "xaat-test-ingest-token");
  axiom.ingest.mockReset();
  context.signal.addEventListener(
    "abort",
    () => {
      vi.unstubAllEnvs();
    },
    { once: true },
  );
});

function token(claims: Record<string, unknown>): string {
  return `header.${btoa(JSON.stringify(claims)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}.private-signature`;
}

function client(getToken: () => Promise<string | null>) {
  return createAuthedContractClient(chatThreadEventsContract, {
    baseUrl: "https://api.okou.ai",
    clientVersion: "0.984.1",
    getToken,
    getVercelProtectionBypass: () => {
      return undefined;
    },
  });
}

function diagnostics() {
  return axiom.ingest.mock.calls.flatMap(([dataset, events]) => {
    expect(dataset).toBe("vm0-client-telemetry-prod");
    return events.filter((event) => {
      return event.source === "client";
    });
  });
}

test("Correlates concurrent Worker 401s with each request's credential without leaking it", async () => {
  const slowThread = crypto.randomUUID();
  const fastThread = crypto.randomUUID();
  const releaseSlow = context.mocks.deferred<void>();
  const observedRequests = new Map<string, Headers[]>();
  context.mocks.api(
    chatThreadEventsContract.rows,
    async ({ request, params, respond }) => {
      const attempts = observedRequests.get(params.threadId) ?? [];
      attempts.push(request.headers);
      observedRequests.set(params.threadId, attempts);
      if (params.threadId === slowThread) {
        await releaseSlow.promise;
      }
      return respond(401, denied);
    },
  );
  const slowToken = token({
    exp: NOW / 1000 - 5,
    sub: "private-user",
    org_id: "private-org",
  });
  const fastToken = token({
    exp: NOW / 1000 + 60,
    sub: "private-user",
    o: { id: "private-org" },
  });
  const fastRetryToken = token({
    exp: NOW / 1000 + 120,
    sub: "private-user",
    o: { id: "private-org" },
  });
  const slowRetryToken = token({
    exp: NOW / 1000 + 30,
    sub: "private-user",
    org_id: "private-org",
  });
  const getToken = vi
    .fn<() => Promise<string | null>>()
    .mockResolvedValueOnce(slowToken)
    .mockResolvedValueOnce(fastToken)
    .mockResolvedValueOnce(fastRetryToken)
    .mockResolvedValueOnce(slowRetryToken);
  const api = client(getToken);
  vi.stubGlobal("window", undefined);

  const slowResponse = api.rows({
    params: { threadId: slowThread },
    query: { limit: 50, sinceSeqId: 0 },
  });
  const fastResponse = await api.rows({
    params: { threadId: fastThread },
    query: { limit: 50, sinceSeqId: 0 },
  });
  expect(fastResponse).toMatchObject({ status: 401, body: denied });
  releaseSlow.resolve();
  await expect(slowResponse).resolves.toMatchObject({
    status: 401,
    body: denied,
  });

  const events = diagnostics();
  expect(getToken).toHaveBeenCalledTimes(4);
  expect(events).toHaveLength(4);
  expect(observedRequests.get(fastThread)).toHaveLength(2);
  expect(observedRequests.get(slowThread)).toHaveLength(2);
  const requests = [...observedRequests.values()].flat();
  expect(
    new Set(
      requests.map((headers) => {
        return headers.get(CLIENT_REQUEST_ID_HEADER);
      }),
    ).size,
  ).toBe(4);
  for (const [index, thread, attempt, ttl, credential] of [
    [0, fastThread, 0, 60, fastToken],
    [1, fastThread, 1, 120, fastRetryToken],
    [2, slowThread, 0, -5, slowToken],
    [3, slowThread, 1, 30, slowRetryToken],
  ] as const) {
    const headers = observedRequests.get(thread)?.[attempt];
    expect(headers?.get("Authorization")).toBe(`Bearer ${credential}`);
    expect(headers?.get(CLIENT_REQUEST_ID_HEADER)).toStrictEqual(
      expect.any(String),
    );
    expect(events[index]).toMatchObject({
      level: "info",
      fields: {
        type: "temporary_auth_failure",
        runtime: "shared_worker",
        requestId: headers?.get(CLIENT_REQUEST_ID_HEADER),
        clientSessionId: headers?.get(CLIENT_SESSION_ID_HEADER),
        clientVersion: "0.984.1",
        method: "GET",
        route: "/api/chat-threads/:threadId/event-rows",
        status: 401,
        has_bearer_token: true,
        jwt_decoded: true,
        token_has_org: true,
        token_ttl_at_request_seconds: ttl,
        token_ttl_at_response_seconds: ttl,
      },
    });
  }
  const emitted = JSON.stringify(axiom.ingest.mock.calls);
  for (const secret of [
    slowToken,
    fastToken,
    slowRetryToken,
    fastRetryToken,
    "private-user",
    "private-org",
    "private-signature",
    slowThread,
    fastThread,
  ]) {
    expect(emitted).not.toContain(secret);
  }
});

test.each([
  null,
  "malformed.private-credential",
  token({ exp: NOW / 1000 + 60 }),
])(
  "Preserves 401 responses for missing, malformed, or org-less credentials (%#)",
  async (credential) => {
    context.mocks.api(chatThreadEventsContract.rows, ({ respond }) => {
      return respond(401, denied);
    });
    const api = client(() => {
      return Promise.resolve(credential);
    });
    await expect(
      api.rows({
        params: { threadId: crypto.randomUUID() },
        query: { limit: 50, sinceSeqId: 0 },
      }),
    ).resolves.toMatchObject({ status: 401, body: denied });
    const events = diagnostics();
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event).toMatchObject({
        fields: {
          has_bearer_token: credential !== null,
          jwt_decoded: credential?.endsWith("private-signature") ?? false,
          token_has_org: credential?.endsWith("private-signature")
            ? false
            : null,
        },
      });
    }
    const emitted = JSON.stringify(axiom.ingest.mock.calls);
    expect(emitted).not.toContain(credential ?? "private-signature");
    expect(emitted).not.toContain("private-signature");
  },
);

test("Stops temporary diagnostics at the deadline while preserving request RED", async () => {
  context.mocks.api(chatThreadEventsContract.rows, ({ respond }) => {
    return respond(401, denied);
  });
  const api = client(() => {
    return Promise.resolve(null);
  });
  const request = {
    params: { threadId: crypto.randomUUID() },
    query: { limit: 50, sinceSeqId: 0 },
  };
  mockNow(AUTH_FAILURE_DIAGNOSTICS_EXPIRES_AT - 1, context.signal);
  await api.rows(request);
  expect(diagnostics()).toHaveLength(2);

  axiom.ingest.mockClear();
  mockNow(AUTH_FAILURE_DIAGNOSTICS_EXPIRES_AT, context.signal);
  await expect(api.rows(request)).resolves.toMatchObject({
    status: 401,
    body: denied,
  });
  expect(diagnostics()).toHaveLength(0);
  expect(
    axiom.ingest.mock.calls.flatMap(([, events]) => {
      return events;
    }),
  ).toMatchObject([
    {
      kind: "client",
      "attributes.http.response.status_code": 401,
    },
    {
      kind: "client",
      "attributes.http.response.status_code": 401,
    },
  ]);
});

test("A diagnostic ingestion failure does not replace the HTTP response", async () => {
  context.mocks.api(chatThreadEventsContract.rows, ({ respond }) => {
    return respond(401, denied);
  });
  axiom.ingest.mockImplementation((_, events) => {
    if (
      events.some((event) => {
        return event.source === "client";
      })
    ) {
      throw new Error("Axiom unavailable");
    }
  });
  const api = client(() => {
    return Promise.resolve(null);
  });
  await expect(
    api.rows({
      params: { threadId: crypto.randomUUID() },
      query: { limit: 50, sinceSeqId: 0 },
    }),
  ).resolves.toMatchObject({ status: 401, body: denied });
});
