import { screen } from "@testing-library/react";
import { CLIENT_FORCE_UPGRADE_STATUS } from "@okouai/api-contracts/contracts/client-headers";
import { expect, vi } from "vitest";

import { setupPage } from "../../__tests__/page-helper.ts";
import { mockedClerk } from "../../__tests__/mock-auth.ts";
import type { SharedDatabasePortLike } from "../../shared-database/bridge.ts";
import { sharedDatabaseClientMessageSchema } from "../../shared-database/protocol.ts";
import { setupSharedDatabaseBridge$ } from "../shared-database-browser.ts";
import {
  bridgeConnected$,
  installedSharedDatabaseBridge$,
} from "../shared-database-bridge-state.ts";
import { setupClerkUser$ } from "../auth.ts";
import { setRootSignal$ } from "../root-signal.ts";
import { detach, Reason } from "../utils.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();

class TestSharedWorkerPort implements SharedDatabasePortLike {
  readonly postedMessages: unknown[] = [];
  private listener: ((event: MessageEvent<unknown>) => void) | null = null;

  postMessage(value: unknown): void {
    this.postedMessages.push(structuredClone(value));
  }

  start(): void {}

  close(): void {
    this.listener = null;
  }

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
    options?: AddEventListenerOptions | boolean,
  ): void {
    this.listener = listener;
    const signal = typeof options === "object" ? options.signal : undefined;
    signal?.addEventListener(
      "abort",
      () => {
        if (this.listener === listener) {
          this.listener = null;
        }
      },
      { once: true },
    );
  }

  removeEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    if (this.listener === listener) {
      this.listener = null;
    }
  }

  receive(value: unknown): void {
    this.listener?.(new MessageEvent("message", { data: value }));
  }
}

interface SharedWorkerConstructorCall {
  readonly options?: string | WorkerOptions;
  readonly scriptURL: string | URL;
}

class TestSharedWorker {
  readonly port = new TestSharedWorkerPort();
  private errorListener: ((event: ErrorEvent) => void) | null = null;
  private readonly scriptURL: string;

  constructor(
    scriptURL: string | URL,
    options: string | WorkerOptions | undefined,
    constructorCalls: SharedWorkerConstructorCall[],
  ) {
    this.scriptURL = String(scriptURL);
    constructorCalls.push({ scriptURL, options });
  }

  addEventListener(
    _type: "error",
    listener: (event: ErrorEvent) => void,
    options?: AddEventListenerOptions | boolean,
  ): void {
    this.errorListener = listener;
    const signal = typeof options === "object" ? options.signal : undefined;
    signal?.addEventListener(
      "abort",
      () => {
        this.errorListener = null;
      },
      { once: true },
    );
  }

  fail(): void {
    this.errorListener?.(
      new ErrorEvent("error", {
        error: new Error("SharedWorker module script failed to load"),
        filename: this.scriptURL,
        message: "SharedWorker module script failed to load",
      }),
    );
  }
}

function installSharedWorkerMock(): {
  readonly constructorCalls: SharedWorkerConstructorCall[];
  readonly workers: TestSharedWorker[];
} {
  const constructorCalls: SharedWorkerConstructorCall[] = [];
  const workers: TestSharedWorker[] = [];
  class SharedWorkerMock extends TestSharedWorker {
    constructor(scriptURL: string | URL, options?: string | WorkerOptions) {
      super(scriptURL, options, constructorCalls);
      workers.push(this);
    }
  }
  vi.stubGlobal("SharedWorker", SharedWorkerMock);
  return { constructorCalls, workers };
}

function setupBridge(): void {
  context.store.set(setRootSignal$, context.signal);
  const clerk = context.mocks.clerk();
  clerk.user(
    {
      id: "shared-worker-user",
      fullName: "Shared Worker User",
      email: "shared-worker@example.com",
    },
    { token: "shared-worker-token" },
  );
  clerk.organization({
    activeOrg: { id: "shared-worker-org", name: "Shared Worker Org" },
    memberships: [{ id: "shared-worker-org" }],
  });
  // Bootstrap owns `clerkUser$` in production; this test drives the bridge
  // directly, so it has to claim the same owner.
  detach(
    context.store.set(setupClerkUser$, context.signal),
    Reason.Daemon,
    "test clerk user owner",
  );
  detach(
    context.store.set(setupSharedDatabaseBridge$, context.signal),
    Reason.Daemon,
    "test shared database bridge",
  );
}

test("Pass the page identity through the Vite shared worker URL", async () => {
  context.mocks.browser.url("https://app.okou.ai/chats");
  const { constructorCalls, workers } = installSharedWorkerMock();
  setupBridge();
  await vi.waitFor(() => {
    expect(workers).toHaveLength(1);
  });

  const workerUrl = new URL(String(constructorCalls[0]!.scriptURL));
  expect(workerUrl.origin).toBe("https://app.okou.ai");
  expect(workerUrl.search).toMatch(/[?&](?:sharedworker|worker_file)(?:&|$)/u);
  expect(workerUrl.searchParams.get("orgId")).toBe("shared-worker-org");
  expect(workerUrl.searchParams.get("userId")).toBe("shared-worker-user");
  expect(constructorCalls[0]!.options).toStrictEqual({
    name: "okou_shared-worker-user_shared-worker-org",
    type: "module",
  });
});

test("Return Clerk's cached token when the shared worker requests it", async () => {
  const { workers } = installSharedWorkerMock();
  setupBridge();
  await vi.waitFor(() => {
    expect(workers).toHaveLength(1);
  });

  workers[0]!.port.receive({
    type: "get-token",
    requestId: "worker-token-request",
  });

  await vi.waitFor(() => {
    expect(workers[0]!.port.postedMessages).toContainEqual({
      type: "token-result",
      requestId: "worker-token-request",
      token: "shared-worker-token",
    });
  });
  expect(mockedClerk.sessionGetToken.mock.calls.at(-1)?.[0]).toBeUndefined();
});

test("Open the force-upgrade dialog when the worker requires an upgrade", async () => {
  context.mocks.http.get("*/api/indicators", () => {
    return Response.json(
      { error: "Client update required" },
      { status: CLIENT_FORCE_UPGRADE_STATUS },
    );
  });
  await setupPage({ context, path: "/" });

  const dialog = await screen.findByRole("dialog", {
    name: "Update required",
  });
  expect(dialog).toBeInTheDocument();
});

// These failures originate at the browser's worker boundary and have no page
// action. Exercise production bridge setup and its request contract directly.
test("Expose worker construction failures to bridge consumers", async () => {
  const error = new Error("SharedWorker construction failed");
  vi.stubGlobal(
    "SharedWorker",
    class {
      constructor() {
        throw error;
      }
    },
  );

  setupBridge();

  await expect(context.store.get(bridgeConnected$)).rejects.toBe(error);
});

test("Return a worker query error to its caller", async () => {
  const { workers } = installSharedWorkerMock();
  setupBridge();
  await context.store.get(bridgeConnected$);
  const bridge = context.store.get(installedSharedDatabaseBridge$);
  const query = bridge.query(
    {
      dataKey: { kind: "chat-event", threadId: "thread-1" },
      afterSeqId: null,
      consistency: "cache-only",
    },
    context.signal,
  );
  const request = workers[0]!.port.postedMessages
    .map((message) => {
      return sharedDatabaseClientMessageSchema.parse(message);
    })
    .find((message) => {
      return message.type === "query";
    });
  if (!request) {
    throw new Error("Expected a worker query request");
  }

  workers[0]!.port.receive({
    type: "error",
    requestId: request.requestId,
    error: {
      name: "Error",
      message: "Shared database tab registration is required before query",
    },
  });

  await expect(query).rejects.toThrow(
    "Shared database tab registration is required before query",
  );
});

test("Reject pending requests when the worker fails", async () => {
  const { constructorCalls, workers } = installSharedWorkerMock();
  setupBridge();
  await context.store.get(bridgeConnected$);
  const bridge = context.store.get(installedSharedDatabaseBridge$);
  const query = bridge.query(
    {
      dataKey: { kind: "chat-event", threadId: "thread-1" },
      afterSeqId: null,
      consistency: "cache-only",
    },
    context.signal,
  );
  const computed = bridge.getComputed("chat-thread-indicators");

  workers[0]!.fail();

  await expect(query).rejects.toThrow("Shared database worker failed to load");
  await expect(computed).rejects.toThrow(
    "Shared database worker failed to load",
  );
  await expect(bridge.getComputed("chat-thread-indicators")).rejects.toThrow(
    "Shared database worker failed to load",
  );
  expect(constructorCalls).toHaveLength(1);
});
