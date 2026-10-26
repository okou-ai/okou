import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import { testContext } from "../signals/__tests__/test-helpers.ts";
import { SharedDatabaseMessagePortServer } from "../shared-database/message-port-server.ts";
import { setupPage, startPage } from "./page-helper.ts";

const axiomTelemetry = vi.hoisted(() => {
  return {
    flush: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    ingest:
      vi.fn<
        (dataset: string, events: readonly Record<string, unknown>[]) => void
      >(),
  };
});

vi.mock("@axiomhq/js", () => {
  return {
    Axiom: class {
      flush(): Promise<void> {
        return axiomTelemetry.flush();
      }

      ingest(
        dataset: string,
        events: readonly Record<string, unknown>[],
      ): void {
        axiomTelemetry.ingest(dataset, events);
      }
    },
  };
});

const context = testContext();
const pageOptions = {
  context,
  path: "/agents",
  host: "app.okou.ai",
  sharedWorkerTestTransport: "browser",
  env: { VITE_AXIOM_CLIENT_TELEMETRY_TOKEN: "test-shared-worker-telemetry" },
} as const;

function installSharedWorker(options: { readonly failOnStart?: boolean } = {}) {
  const workers: EventTarget[] = [];
  // Replace only the browser API. Requests still cross the real MessagePort
  // protocol and worker signals used by the production page.
  class SharedWorkerMock extends EventTarget {
    readonly port: MessagePort;

    constructor() {
      super();
      const channel = new MessageChannel();
      this.port = channel.port1;
      new SharedDatabaseMessagePortServer(
        context.workerStore,
        channel.port2,
        context.signal,
      );
      workers.push(this);
      if (options.failOnStart) {
        queueMicrotask(() => {
          this.dispatchEvent(new Event("error"));
        });
      }
    }
  }
  vi.stubGlobal("SharedWorker", SharedWorkerMock);
  return workers;
}

function failureEvents(): Record<string, unknown>[] {
  return axiomTelemetry.ingest.mock.calls.flatMap(([dataset, events]) => {
    expect(dataset).toBe("vm0-client-telemetry-prod");
    return events.filter((event) => {
      return event.name === "shared_worker.failure";
    });
  });
}

function expectFailureTelemetry(): void {
  const events = failureEvents();
  expect(events).toHaveLength(1);
  expect(axiomTelemetry.flush).toHaveBeenCalledTimes(1);
  expect(events[0]).toMatchObject({
    "attributes.custom": {
      "okou.client.outcome": "error",
      "okou.client.runtime": "window",
      "okou.shared_worker.failure.phase": "error-event",
      "okou.shared_worker.script_path": expect.stringMatching(/^\/[^?#]+$/u),
    },
    "resource.deployment.environment.name": "production",
    "service.version": "0.540.0",
    "status.code": "ERROR",
  });
  const payload = JSON.stringify(events);
  expect(payload).not.toContain("test-user-123");
  expect(payload).not.toContain("org_default");
  expect(payload).not.toContain("userId=");
}

test("Block the page and report a worker failure during startup", async () => {
  installSharedWorker({ failOnStart: true });

  await startPage(pageOptions);

  const dialog = await screen.findByRole("dialog", {
    name: "Connection interrupted",
  });
  expect(dialog).toHaveTextContent(
    "The connection to this app was interrupted.",
  );
  expectFailureTelemetry();

  await userEvent.keyboard("{Escape}");
  expect(dialog).toBeVisible();
});

test("Block the page after a connected worker fails and report it once", async () => {
  const workers = installSharedWorker();
  await setupPage(pageOptions);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  const error = new ErrorEvent("error", {
    cancelable: true,
    error: new Error("Worker execution failed"),
  });
  const repeatedError = new Event("error", { cancelable: true });
  workers[0]!.dispatchEvent(error);
  workers[0]!.dispatchEvent(repeatedError);
  expect(error.defaultPrevented).toBeTruthy();
  expect(repeatedError.defaultPrevented).toBeTruthy();

  await expect(
    screen.findByRole("dialog", { name: "Connection interrupted" }),
  ).resolves.toBeVisible();
  expectFailureTelemetry();
});

test("Ignore worker errors after the page owner has been cancelled", async () => {
  const workers = installSharedWorker();
  await setupPage(pageOptions);

  await window._okou?.switchClerkSession("another-test-session");
  const error = new Event("error", { cancelable: true });
  workers[0]!.dispatchEvent(error);

  expect(error.defaultPrevented).toBeFalsy();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(failureEvents()).toHaveLength(0);
});
