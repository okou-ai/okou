// @vitest-environment-options {"url":"https://app.okou.ai/"}

import { openDB, type DBSchema } from "idb";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { beforeEach, expect, test, vi } from "vitest";

import { CHAT_EVENT_SCHEMA_VERSION_HEADERS } from "../../../shared-database/chat-event-schema-version.ts";
import {
  chatEventRowsResponse,
  testContext,
} from "../../__tests__/test-helpers.ts";
import { createAuthedContractClient } from "../../api-client-base.ts";
import { createChatIdbOpener } from "../chat-idb-opener.ts";
import {
  deleteIntroVideoDraft,
  readIntroVideoDraft,
  saveIntroVideoDraft,
} from "../intro-video-draft-store.ts";
import { runIndexedDbTransaction } from "../indexeddb-client.ts";

const axiomTelemetry = vi.hoisted(() => {
  return {
    ingest:
      vi.fn<
        (dataset: string, events: readonly Record<string, unknown>[]) => void
      >(),
  };
});

vi.mock("@axiomhq/js", () => {
  return {
    Axiom: class {
      ingest(
        dataset: string,
        events: readonly Record<string, unknown>[],
      ): void {
        axiomTelemetry.ingest(dataset, events);
      }
    },
  };
});

interface TelemetryTestDatabase extends DBSchema {
  readonly records: {
    readonly key: string;
    readonly value: { readonly secret: string };
  };
}

// Client telemetry has no page-visible surface, so these integration tests use
// real IndexedDB behavior and observe the external Axiom payload boundary.
const context = testContext();

beforeEach(() => {
  vi.stubEnv("VITE_AXIOM_CLIENT_TELEMETRY_TOKEN", "xaat-test-ingest-token");
  context.signal.addEventListener(
    "abort",
    () => {
      vi.unstubAllEnvs();
    },
    { once: true },
  );
  axiomTelemetry.ingest.mockClear();
});

async function openTelemetryTestDatabase() {
  return await openDB<TelemetryTestDatabase>(crypto.randomUUID(), 1, {
    upgrade(database) {
      database.createObjectStore("records");
    },
  });
}

async function capturedEvents(
  expectedCount: number,
): Promise<readonly Record<string, unknown>[]> {
  await vi.waitFor(() => {
    expect(axiomTelemetry.ingest).toHaveBeenCalledTimes(expectedCount);
  });
  return axiomTelemetry.ingest.mock.calls.map(([dataset, events]) => {
    expect(dataset).toBe("vm0-client-telemetry-prod");
    expect(events).toHaveLength(1);
    return events[0]!;
  });
}

async function capturedEvent(): Promise<Record<string, unknown>> {
  const events = await capturedEvents(1);
  return events[0]!;
}

test("Reports a physical chat database open without credential identifiers", async () => {
  const sensitiveUserId = `private-user-${crypto.randomUUID()}`;
  const sensitiveOrgId = `private-org-${crypto.randomUUID()}`;
  const database = await createChatIdbOpener({
    onVersionChange: vi.fn<() => void>(),
  }).openChatIdb(sensitiveUserId, sensitiveOrgId);
  database.close();

  const event = await capturedEvent();
  expect(event).toMatchObject({
    "attributes.custom": {
      "db.namespace": "chat",
      "db.system": "indexeddb",
      "okou.client.outcome": "success",
      "okou.client.runtime": "window",
    },
    kind: "client",
    name: "chat.open",
    "resource.deployment.environment.name": "production",
    "scope.name": "okou-app/indexeddb",
    "service.name": "Okou-app",
    "service.version": "0.540.0",
    "status.code": "OK",
  });
  expect(event.duration).toStrictEqual(expect.any(Number));
  expect(event).not.toHaveProperty("attributes.custom.okou.db.request.count");
  expect(event).not.toHaveProperty(
    "attributes.custom.okou.db.transaction.mode",
  );
  expect(JSON.stringify(event)).not.toContain(sensitiveUserId);
  expect(JSON.stringify(event)).not.toContain(sensitiveOrgId);
});

test("Reports a failed chat database open without hiding its error", async () => {
  const openError = new DOMException(
    "private open failure",
    "InvalidStateError",
  );
  const opener = createChatIdbOpener({
    openDatabase: () => {
      return Promise.reject(openError);
    },
    onVersionChange: vi.fn<() => void>(),
  });

  await expect(opener.openChatIdb("private-user", "private-org")).rejects.toBe(
    openError,
  );

  const event = await capturedEvent();
  expect(event).toMatchObject({
    "attributes.custom": {
      "db.namespace": "chat",
      "db.system": "indexeddb",
      "okou.client.outcome": "error",
    },
    name: "chat.open",
    "scope.name": "okou-app/indexeddb",
    "status.code": "ERROR",
  });
  expect(event.duration).toStrictEqual(expect.any(Number));
  expect(JSON.stringify(event)).not.toContain(openError.message);
  expect(JSON.stringify(event)).not.toContain("private-user");
  expect(JSON.stringify(event)).not.toContain("private-org");
});

test("Reports separate creation and execution events for an IndexedDB transaction", async () => {
  const database = await openTelemetryTestDatabase();
  const sensitiveKey = `private-key-${crypto.randomUUID()}`;
  const sensitiveValue = `private-value-${crypto.randomUUID()}`;

  try {
    vi.stubGlobal("window", undefined);
    await expect(
      runIndexedDbTransaction(
        {
          database: "chat",
          template: "records.put+get",
          transaction_mode: "readwrite",
        },
        () => {
          return database.transaction("records", "readwrite");
        },
        async (transaction, trackRequest) => {
          await trackRequest(
            transaction.store.put({ secret: sensitiveValue }, sensitiveKey),
          );
          return await trackRequest(transaction.store.get(sensitiveKey));
        },
      ),
    ).resolves.toStrictEqual({ secret: sensitiveValue });
  } finally {
    database.close();
  }

  const events = await capturedEvents(2);
  const creationEvent = events[0]!;
  const event = events[1]!;
  expect(creationEvent).toMatchObject({
    "attributes.custom": {
      "db.namespace": "chat",
      "db.system": "indexeddb",
      "okou.client.outcome": "success",
      "okou.client.runtime": "shared_worker",
      "okou.db.transaction.mode": "readwrite",
    },
    kind: "client",
    name: "records.put+get.transaction.create",
    "resource.deployment.environment.name": "production",
    "scope.name": "okou-app/indexeddb",
    "service.name": "Okou-app",
    "service.version": "0.540.0",
    "status.code": "OK",
  });
  expect(creationEvent.duration).toStrictEqual(expect.any(Number));
  expect(creationEvent).not.toHaveProperty(
    "attributes.custom.okou.db.request.count",
  );
  expect(event).toMatchObject({
    "attributes.custom": {
      "db.namespace": "chat",
      "db.system": "indexeddb",
      "okou.client.outcome": "success",
      "okou.client.runtime": "shared_worker",
      "okou.db.request.count": 2,
      "okou.db.transaction.mode": "readwrite",
    },
    kind: "client",
    name: "records.put+get",
    "resource.deployment.environment.name": "production",
    "scope.name": "okou-app/indexeddb",
    "service.name": "Okou-app",
    "service.version": "0.540.0",
    "status.code": "OK",
  });
  expect(event.duration).toStrictEqual(expect.any(Number));
  expect(event).not.toHaveProperty("duration_ms");
  expect(event).not.toHaveProperty("event_name");
  expect(event).not.toHaveProperty("resource.custom");
  expect(event).not.toHaveProperty("template");
  expect(JSON.stringify(event)).not.toContain(sensitiveKey);
  expect(JSON.stringify(event)).not.toContain(sensitiveValue);
});

test("Reports an aborted IndexedDB transaction without hiding its error", async () => {
  const database = await openTelemetryTestDatabase();

  try {
    await expect(
      runIndexedDbTransaction(
        {
          database: "intro_video_drafts",
          template: "records.put",
          transaction_mode: "readwrite",
        },
        () => {
          return database.transaction("records", "readwrite");
        },
        async (transaction, trackRequest) => {
          const request = trackRequest(
            transaction.store.put({ secret: "draft" }, "latest"),
          );
          transaction.abort();
          await request;
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  } finally {
    database.close();
  }

  const events = await capturedEvents(2);
  const creationEvent = events[0]!;
  const event = events[1]!;
  expect(creationEvent).toMatchObject({
    "attributes.custom": {
      "db.namespace": "intro_video_drafts",
      "okou.client.outcome": "success",
      "okou.db.transaction.mode": "readwrite",
    },
    name: "records.put.transaction.create",
    "status.code": "OK",
  });
  expect(event).toMatchObject({
    "attributes.custom": {
      "db.namespace": "intro_video_drafts",
      "okou.client.outcome": "aborted",
      "okou.db.request.count": 1,
      "okou.db.transaction.mode": "readwrite",
    },
    name: "records.put",
  });
  expect(event).not.toHaveProperty("status.code");
});

test("Reports a synchronous IndexedDB transaction creation failure", async () => {
  const creationError = new DOMException(
    "private creation failure",
    "InvalidStateError",
  );

  await expect(
    runIndexedDbTransaction(
      {
        database: "chat",
        template: "records.get",
        transaction_mode: "readonly",
      },
      () => {
        throw creationError;
      },
      () => {
        return Promise.reject(
          new Error("Transaction execution must not start"),
        );
      },
    ),
  ).rejects.toBe(creationError);

  const event = await capturedEvent();
  expect(event).toMatchObject({
    "attributes.custom": {
      "db.namespace": "chat",
      "db.system": "indexeddb",
      "okou.client.outcome": "error",
      "okou.db.transaction.mode": "readonly",
    },
    name: "records.get.transaction.create",
    "scope.name": "okou-app/indexeddb",
    "status.code": "ERROR",
  });
  expect(event.duration).toStrictEqual(expect.any(Number));
  expect(event).not.toHaveProperty("attributes.custom.okou.db.request.count");
  expect(JSON.stringify(event)).not.toContain(creationError.message);
});

test("Reports all intro video draft IndexedDB lifecycle events", async () => {
  const draft = {
    blob: new Blob(["private draft"]),
    contentType: "video/mp4",
    createdAt: 1_777_777_777_777,
    durationSeconds: 12,
    kind: "video" as const,
    name: "private-draft.mp4",
  };

  await saveIntroVideoDraft(draft);
  const restoredDraft = await readIntroVideoDraft();
  expect(restoredDraft).toMatchObject({
    contentType: draft.contentType,
    createdAt: draft.createdAt,
    durationSeconds: draft.durationSeconds,
    kind: draft.kind,
    name: draft.name,
  });
  expect(restoredDraft?.blob).toBeDefined();
  await deleteIntroVideoDraft();
  await expect(readIntroVideoDraft()).resolves.toBeNull();

  const events = await capturedEvents(12);
  const operations = [
    { mode: "readwrite", template: "intro_video_drafts.put" },
    { mode: "readonly", template: "intro_video_drafts.get" },
    { mode: "readwrite", template: "intro_video_drafts.delete" },
    { mode: "readonly", template: "intro_video_drafts.get" },
  ] as const;
  expect(
    events.map((event) => {
      return event.name;
    }),
  ).toStrictEqual(
    operations.flatMap(({ template }) => {
      return [
        "intro_video_drafts.open",
        `${template}.transaction.create`,
        template,
      ];
    }),
  );
  for (const [index, operation] of operations.entries()) {
    const openEvent = events[index * 3]!;
    const creationEvent = events[index * 3 + 1]!;
    const transactionEvent = events[index * 3 + 2]!;
    expect(openEvent).toMatchObject({
      "attributes.custom": {
        "db.namespace": "intro_video_drafts",
        "okou.client.outcome": "success",
      },
      "status.code": "OK",
    });
    expect(openEvent).not.toHaveProperty(
      "attributes.custom.okou.db.request.count",
    );
    expect(openEvent).not.toHaveProperty(
      "attributes.custom.okou.db.transaction.mode",
    );
    expect(creationEvent).toMatchObject({
      "attributes.custom": {
        "db.namespace": "intro_video_drafts",
        "okou.client.outcome": "success",
        "okou.db.transaction.mode": operation.mode,
      },
      "status.code": "OK",
    });
    expect(creationEvent).not.toHaveProperty(
      "attributes.custom.okou.db.request.count",
    );
    expect(transactionEvent).toMatchObject({
      "attributes.custom": {
        "db.namespace": "intro_video_drafts",
        "okou.client.outcome": "success",
        "okou.db.request.count": 1,
        "okou.db.transaction.mode": operation.mode,
      },
      "status.code": "OK",
    });
  }
});

test("Reports typed API requests with route templates and no parameters", async () => {
  const sensitiveThreadId = crypto.randomUUID();
  const sensitiveToken = `private-token-${crypto.randomUUID()}`;
  context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
    return respond(200, chatEventRowsResponse([], query));
  });
  const client = createAuthedContractClient(chatThreadEventsContract, {
    baseUrl: location.origin,
    clientVersion: "test-version",
    getToken: () => {
      return Promise.resolve(sensitiveToken);
    },
    getVercelProtectionBypass: () => {
      return undefined;
    },
  });

  await expect(
    client.rows({
      headers: CHAT_EVENT_SCHEMA_VERSION_HEADERS,
      params: { threadId: sensitiveThreadId },
      query: { limit: 50, sinceSeqId: 0 },
    }),
  ).resolves.toMatchObject({ status: 200 });

  const event = await capturedEvent();
  expect(event).toMatchObject({
    "attributes.custom": {
      "okou.client.outcome": "success",
      "okou.client.runtime": "window",
    },
    "attributes.http.request.method": "GET",
    "attributes.http.response.status_code": 200,
    "attributes.http.route": "/api/chat-threads/:threadId/event-rows",
    kind: "client",
    name: "GET /api/chat-threads/:threadId/event-rows",
    "resource.deployment.environment.name": "production",
    "scope.name": "okou-app/http",
    "service.name": "Okou-app",
    "service.version": "0.540.0",
    "status.code": "OK",
  });
  expect(JSON.stringify(event)).not.toContain(sensitiveThreadId);
  expect(JSON.stringify(event)).not.toContain(sensitiveToken);
  expect(JSON.stringify(event)).not.toContain("sinceSeqId");
});

test("Reports API server failures as RED errors", async () => {
  context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
    return respond(500, {
      error: { code: "internal_error", message: "Internal server error" },
    });
  });
  const client = createAuthedContractClient(featureSwitchesContract, {
    baseUrl: location.origin,
    clientVersion: "test-version",
    getToken: () => {
      return Promise.resolve("test-token");
    },
    getVercelProtectionBypass: () => {
      return undefined;
    },
  });

  await expect(client.get()).resolves.toMatchObject({ status: 500 });

  await expect(capturedEvent()).resolves.toMatchObject({
    "attributes.custom": {
      "okou.client.outcome": "error",
    },
    "attributes.http.response.status_code": 500,
    name: "GET /api/feature-switches",
    "scope.name": "okou-app/http",
    "status.code": "ERROR",
  });
});
