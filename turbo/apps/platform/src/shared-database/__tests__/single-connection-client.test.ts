import { expect, test, vi } from "vitest";

import { testContext } from "../../signals/__tests__/test-helpers.ts";
import { createChildAbortController } from "../../signals/utils.ts";
import type {
  SharedDatabaseBridge,
  SharedDatabaseBridgeEvents,
} from "../bridge.ts";
import type { ComputedKey, ComputedValue } from "../computed-key.ts";
import type {
  SharedDatabaseDataKey,
  SharedDatabaseQuery,
  SharedDatabaseQueryResult,
} from "../data-key.ts";
import type {
  SharedDatabaseRealtimeMessage,
  SharedDatabaseRealtimeScope,
} from "../protocol.ts";
import { SingleConnectionSharedDatabaseBridge } from "../single-connection-client.ts";

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

class FakeBridge implements SharedDatabaseBridge {
  queryCalls = 0;

  registerTab(): Promise<void> {
    return Promise.resolve();
  }

  subscribeRealtime(
    _subscriptionId: string,
    _scope: SharedDatabaseRealtimeScope,
    _topic: string,
    _listener: (message: SharedDatabaseRealtimeMessage) => void,
  ): Promise<void> {
    return Promise.resolve();
  }

  unsubscribeRealtime(_subscriptionId: string): void {}

  getComputed<TKey extends ComputedKey>(
    _computedKey: TKey,
  ): Promise<ComputedValue<TKey>> {
    return Promise.reject(new Error("Computed data is not configured"));
  }

  query<TKey extends SharedDatabaseDataKey>(
    _query: SharedDatabaseQuery<TKey>,
  ): Promise<SharedDatabaseQueryResult<TKey>> {
    this.queryCalls += 1;
    return Promise.resolve([] as SharedDatabaseQueryResult<TKey>);
  }
}

const context = testContext();

function dataKey(): SharedDatabaseDataKey {
  return {
    kind: "chat-event",
    threadId: "single-connection-thread",
  };
}

function createEvents(): SharedDatabaseBridgeEvents {
  return {
    chatThreadReadCursorUpdated: vi.fn<(payload: unknown) => void>(),
    computedReloaded: vi.fn<(computedKey: ComputedKey) => void>(),
    databaseInvalidated: vi.fn<(dataKey: SharedDatabaseDataKey) => void>(),
    workerUnavailable: vi.fn<SharedDatabaseBridgeEvents["workerUnavailable"]>(),
  };
}

function query() {
  return {
    dataKey: dataKey(),
    afterSeqId: null,
    consistency: "cache-only" as const,
  };
}

function configureClientTelemetry(url: string, token: string): void {
  vi.stubEnv("VITE_AXIOM_CLIENT_TELEMETRY_TOKEN", token);
  context.signal.addEventListener(
    "abort",
    () => {
      vi.unstubAllEnvs();
    },
    { once: true },
  );
  context.mocks.browser.url(url);
  axiomTelemetry.ingest.mockClear();
}

async function createRegisteredBridge(): Promise<{
  readonly bridge: SingleConnectionSharedDatabaseBridge;
  readonly bridges: readonly FakeBridge[];
  readonly owner: AbortController;
}> {
  const bridges: FakeBridge[] = [];
  const bridge = new SingleConnectionSharedDatabaseBridge({
    createBridge: () => {
      const created = new FakeBridge();
      bridges.push(created);
      return created;
    },
    events: createEvents(),
  });
  // eslint-disable-next-line ccstate/no-create-child-abort-controller -- migrate this lifetime to the ccstate signal hierarchy
  const owner = createChildAbortController(context.signal);
  await bridge.registerTab(owner.signal);
  return { bridge, bridges, owner };
}

test("Reports production shared worker queries without entity identifiers", async () => {
  configureClientTelemetry("https://app.okou.ai/", "xaat-test-ingest-token");
  const { bridge, bridges, owner } = await createRegisteredBridge();
  const sensitiveThreadId = `private-thread-${crypto.randomUUID()}`;

  await expect(
    bridge.query(
      {
        dataKey: { kind: "chat-event", threadId: sensitiveThreadId },
        afterSeqId: 42,
        consistency: "cache-only",
      },
      owner.signal,
    ),
  ).resolves.toStrictEqual([]);

  expect(bridges[0]?.queryCalls).toBe(1);
  await vi.waitFor(() => {
    expect(axiomTelemetry.ingest).toHaveBeenCalledOnce();
  });
  const [dataset, events] = axiomTelemetry.ingest.mock.calls[0]!;
  expect(dataset).toBe("vm0-client-telemetry-prod");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    "attributes.custom": {
      "okou.client.outcome": "success",
      "okou.client.runtime": "window",
    },
    kind: "client",
    name: "chat-event.cache-only",
    "resource.deployment.environment.name": "production",
    "scope.name": "okou-app/shared-worker-query",
    "service.name": "Okou-app",
    "service.version": "0.540.0",
    "status.code": "OK",
  });
  expect(events[0]?.duration).toStrictEqual(expect.any(Number));
  expect(JSON.stringify(events[0])).not.toContain(sensitiveThreadId);
  expect(events[0]).not.toHaveProperty("after_seq_id");
  expect(events[0]).not.toHaveProperty("resource.custom");
});

test("Does not report preview shared worker queries", async () => {
  configureClientTelemetry(
    "https://pr-123-app.omby.ai/",
    "xaat-test-ingest-token",
  );
  const { bridge, bridges, owner } = await createRegisteredBridge();

  await expect(bridge.query(query(), owner.signal)).resolves.toStrictEqual([]);

  expect(bridges[0]?.queryCalls).toBe(1);
  expect(axiomTelemetry.ingest).not.toHaveBeenCalled();
});

test("Does not report shared worker queries without a token", async () => {
  configureClientTelemetry("https://app.okou.ai/", "");
  const { bridge, bridges, owner } = await createRegisteredBridge();

  await expect(bridge.query(query(), owner.signal)).resolves.toStrictEqual([]);

  expect(bridges[0]?.queryCalls).toBe(1);
  expect(axiomTelemetry.ingest).not.toHaveBeenCalled();
});
