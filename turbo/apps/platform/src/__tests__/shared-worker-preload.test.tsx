import { screen } from "@testing-library/react";
import sharedDatabaseWorkerAssetUrl from "virtual:shared-database-worker";
import { expect, test, vi } from "vitest";

import indexHtml from "../../index.html?raw";
import { testContext } from "../signals/__tests__/test-helpers.ts";
import { SharedDatabaseMessagePortServer } from "../shared-database/message-port-server.ts";
import { setupPage, startPage } from "./page-helper.ts";

const context = testContext();
const pageOptions = {
  context,
  path: "/agents",
  host: "app.okou.ai",
  sharedWorkerTestTransport: "browser",
} as const;

interface ConstructedWorker {
  readonly url: string;
  readonly name: string | undefined;
  readonly worker: EventTarget;
}

function installSharedWorker(): ConstructedWorker[] {
  const workers: ConstructedWorker[] = [];
  // Replace only the browser API. Requests still cross the real MessagePort
  // protocol and worker signals used by the production page.
  class SharedWorkerMock extends EventTarget {
    readonly port: MessagePort;

    constructor(url: string | URL, options?: WorkerOptions) {
      super();
      const channel = new MessageChannel();
      this.port = channel.port1;
      new SharedDatabaseMessagePortServer(
        context.workerStore,
        channel.port2,
        context.signal,
      );
      workers.push({ url: url.toString(), name: options?.name, worker: this });
    }
  }
  vi.stubGlobal("SharedWorker", SharedWorkerMock);
  return workers;
}

/** Runs the deployed shell script, then the call the app worker injects. */
function preloadFromAppShell(userId: string, orgId: string): void {
  context.mocks.browser.url(`https://${pageOptions.host}${pageOptions.path}`);
  const page = new DOMParser().parseFromString(indexHtml, "text/html");
  const source = page.querySelector(
    "[data-okou-shared-database-worker-bootstrap]",
  )?.textContent;
  if (!source) {
    throw new Error("index.html is missing the shared worker bootstrap");
  }
  // The build publishes the emitted worker path; tests use Vite's served URL.
  const meta = document.createElement("meta");
  meta.name = "okou-shared-database-worker";
  meta.content = new URL(sharedDatabaseWorkerAssetUrl, location.href).href;
  document.head.append(meta);
  context.signal.addEventListener(
    "abort",
    () => {
      meta.remove();
      delete window.__okouSharedDatabaseWorkerBootstrap;
    },
    { once: true },
  );
  new Function(source)();
  window.__okouSharedDatabaseWorkerBootstrap?.start(userId, orgId);
}

test("Reuse the Worker the app shell preloaded for the signed-in identity", async () => {
  const workers = installSharedWorker();
  preloadFromAppShell("test-user-123", "org_default");
  expect(workers).toHaveLength(1);

  await setupPage(pageOptions);

  expect(workers).toHaveLength(1);
  expect(workers[0]?.name).toBe("okou_test-user-123_org_default");
  expect(window.__okouSharedDatabaseWorkerBootstrap?.preloaded).toBeUndefined();
});

test("Report a preloaded Worker failure that happened before the app started", async () => {
  const workers = installSharedWorker();
  preloadFromAppShell("test-user-123", "org_default");
  const error = new Event("error", { cancelable: true });
  workers[0]!.worker.dispatchEvent(error);
  expect(error.defaultPrevented).toBeTruthy();

  await startPage(pageOptions);

  await expect(
    screen.findByRole("dialog", { name: "Refresh to continue" }),
  ).resolves.toBeVisible();
  expect(workers).toHaveLength(1);
});

test("Start the page's own Worker when the preloaded URL differs", async () => {
  const workers = installSharedWorker();
  preloadFromAppShell("test-user-123", "org_other");

  await setupPage(pageOptions);

  expect(workers.map(({ name }) => name)).toStrictEqual([
    "okou_test-user-123_org_other",
    "okou_test-user-123_org_default",
  ]);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
