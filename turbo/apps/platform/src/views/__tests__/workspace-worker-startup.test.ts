import { screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import asset from "virtual:shared-database-worker";
import { mockedClerk } from "../../__tests__/mock-auth.ts";
import { startPage } from "../../__tests__/page-helper.ts";
import { testContext } from "../../signals/__tests__/test-helpers.ts";

const telemetry = vi.hoisted(() => {
  return {
    ingest: vi.fn<(_dataset: string, events: { name: string }[]) => void>(),
    flush: vi.fn<() => Promise<void>>(() => {
      return Promise.resolve();
    }),
  };
});
vi.mock("@axiomhq/js", () => {
  return {
    Axiom: class {
      ingest = telemetry.ingest;
      flush = telemetry.flush;
    },
  };
});
const context = testContext();
const page = {
  context,
  path: "/_/error",
  host: "app.okou.ai",
  sharedWorkerTestTransport: "browser",
  env: { VITE_AXIOM_CLIENT_TELEMETRY_TOKEN: "fixture-worker" },
} as const;

function browserWorkers() {
  const connections: {
    target: EventTarget;
    url: URL;
    options: WorkerOptions;
    remote: MessagePort;
  }[] = [];
  const registered = context.mocks.deferred<void>();
  vi.stubGlobal(
    "SharedWorker",
    class extends EventTarget {
      readonly port: MessagePort;
      constructor(url: URL, options: WorkerOptions) {
        super();
        const channel = new MessageChannel();
        this.port = channel.port1;
        connections.push({ target: this, url, options, remote: channel.port2 });
        context.signal.addEventListener(
          "abort",
          () => {
            channel.port1.close();
            channel.port2.close();
          },
          { once: true },
        );
        channel.port2.addEventListener(
          "message",
          ({ data }: MessageEvent<{ type: string }>) => {
            if (data.type === "register-tab") {
              registered.resolve();
            }
          },
          { signal: context.signal },
        );
        channel.port2.start();
      }
    },
  );
  return { connections, registered };
}
function preload(workspace: string) {
  context.mocks.browser.url("https://app.okou.ai/_/error");
  const meta = document.createElement("meta");
  meta.name = "okou-shared-database-worker";
  meta.content = asset;
  document.head.append(meta);
  context.signal.addEventListener(
    "abort",
    () => {
      return meta.remove();
    },
    { once: true },
  );
  window.__okouSharedDatabaseWorkerBootstrap?.start("test-user-123", workspace);
}

test("shared-worker-preload-003 A worker preloaded for another workspace stays separate", async () => {
  const { connections, registered } = browserWorkers();
  preload("org_other");
  const opened = await startPage(page);
  await opened.content;
  await registered.promise;
  await expect(screen.findByRole("alert")).resolves.toBeVisible();
  expect(
    connections.map((c) => {
      return c.options.name;
    }),
  ).toStrictEqual([
    "okou_test-user-123_org_other",
    "okou_test-user-123_org_default",
  ]);
  expect(
    screen.queryByRole("dialog", { name: "Connection interrupted" }),
  ).toBeNull();
});

test("shared-worker-preload-002 An early failure on the matching preload reaches the interruption dialog", async () => {
  const { connections } = browserWorkers();
  preload("org_default");
  const problem = new ErrorEvent("error", {
    cancelable: true,
    message: "Worker asset failed",
  });
  connections[0]?.target.dispatchEvent(problem);
  const opening = await startPage(page);
  await opening.content;
  await expect(
    screen.findByRole("dialog", { name: "Connection interrupted" }),
  ).resolves.toBeVisible();
  expect(problem.defaultPrevented).toBeTruthy();
  expect(connections).toHaveLength(1);
});

test("shared-worker-failure-002 Two native worker failures interrupt the open page and flush a single report", async () => {
  const { connections, registered } = browserWorkers();
  const opened = await startPage(page);
  await opened.content;
  await registered.promise;
  await expect(screen.findByRole("alert")).resolves.toBeVisible();
  expect(
    screen.queryByRole("dialog", { name: "Connection interrupted" }),
  ).toBeNull();
  const worker = connections[0]!.target;
  telemetry.flush.mockClear();
  telemetry.ingest.mockClear();
  for (const message of ["connection interrupted", "worker stopped"]) {
    const incident = new ErrorEvent("error", { message, cancelable: true });
    worker.dispatchEvent(incident);
    expect(incident.defaultPrevented).toBeTruthy();
  }
  await expect(
    screen.findByRole("dialog", { name: "Connection interrupted" }),
  ).resolves.toBeVisible();
  expect(
    telemetry.ingest.mock.calls
      .flatMap(([, batch]) => {
        return batch;
      })
      .filter((event) => {
        return event.name.includes("shared_worker.failure");
      }),
  ).toHaveLength(1);
  expect(telemetry.flush).toHaveBeenCalledTimes(1);
});

test("shared-database-browser-001 Chats starts a module worker bound to its workspace and member", async () => {
  const { connections, registered } = browserWorkers();
  const opening = await startPage({ ...page, path: "/chats" });
  await registered.promise;
  const connection = connections[0]!;
  expect(connection.url.origin).toBe(location.origin);
  expect(connection.url.pathname).toBe(new URL(asset, location.href).pathname);
  expect(connection.url.searchParams.get("userId")).toBe("test-user-123");
  expect(connection.url.searchParams.get("orgId")).toBe("org_default");
  expect(connection.options).toMatchObject({
    name: "okou_test-user-123_org_default",
    type: "module",
  });
  await opening.content;
});

test("shared-database-browser-002 A registered worker receives the cached session token for its own request", async () => {
  const { connections, registered } = browserWorkers();
  const opened = await startPage(page);
  await opened.content;
  await registered.promise;
  const worker = connections[0]!.remote;
  const reply = context.mocks.deferred<unknown>();
  worker.addEventListener(
    "message",
    ({ data }) => {
      if (data.requestId === "local-worker-read") {
        reply.resolve(data);
      }
    },
    { signal: context.signal },
  );
  mockedClerk.sessionGetToken.mockClear();
  worker.postMessage({ type: "get-token", requestId: "local-worker-read" });
  await expect(reply.promise).resolves.toStrictEqual({
    type: "token-result",
    requestId: "local-worker-read",
    token: "test-token",
  });
  expect(mockedClerk.sessionGetToken.mock.calls).toStrictEqual([[undefined]]);
});

test("shared-worker-failure-003 Switching sessions releases the old worker error listener", async () => {
  const { connections, registered } = browserWorkers();
  const opened = await startPage(page);
  await opened.content;
  await registered.promise;
  const former = connections[0]!.target;
  const lifetime = window._okou!;
  await lifetime.switchClerkSession("session_beta");
  expect(lifetime.rootSignal.aborted).toBeTruthy();
  telemetry.ingest.mockClear();
  const late = new ErrorEvent("error", {
    message: "prior workspace",
    cancelable: true,
  });
  former.dispatchEvent(late);
  expect(late.defaultPrevented).toBeFalsy();
  expect(
    screen.queryByRole("dialog", { name: "Connection interrupted" }),
  ).toBeNull();
  expect(
    telemetry.ingest.mock.calls
      .flatMap(([, batch]) => {
        return batch;
      })
      .map((event) => {
        return event.name;
      }),
  ).not.toContain("shared_worker.failure");
});
