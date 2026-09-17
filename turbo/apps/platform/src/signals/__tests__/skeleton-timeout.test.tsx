import { screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

import { testContext } from "./test-helpers.ts";
import { setupPage, startPage } from "../../__tests__/page-helper.ts";

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
  env: { VITE_AXIOM_CLIENT_TELEMETRY_TOKEN: "test-skeleton-telemetry" },
} as const;

beforeEach(() => {
  window.__appBootstrapStart = performance.now();
  context.signal.addEventListener(
    "abort",
    () => {
      delete window.__appBootstrapStart;
    },
    { once: true },
  );
});

function timeoutEvents(): Record<string, unknown>[] {
  return axiomTelemetry.ingest.mock.calls.flatMap(([dataset, events]) => {
    expect(dataset).toBe("vm0-client-telemetry-prod");
    return events.filter((event) => {
      return event.name === "app.skeleton.timeout";
    });
  });
}

test("Report a long skeleton before pending authentication completes", async () => {
  // The inline HTML mark precedes entry-module loading. Keep real timers and
  // exercise the remaining quarter-second of the ten-second deadline.
  window.__appBootstrapStart = performance.now() - 9750;
  const clerkLoad = context.mocks.clerk().runtimePending();
  const reported = context.mocks.deferred<Record<string, unknown>>();
  vi.spyOn(axiomTelemetry, "ingest").mockImplementation((_dataset, events) => {
    const event = events.find((entry) => {
      return entry.name === "app.skeleton.timeout";
    });
    if (event) {
      reported.resolve(event);
    }
  });

  const page = await startPage(pageOptions);
  const skeleton = await screen.findByTestId("app-skeleton");
  expect(skeleton).toBeVisible();

  const event = await reported.promise;
  expect(skeleton).toBeVisible();
  expect(event).toMatchObject({
    "attributes.custom": {
      "okou.client.outcome": "error",
      "okou.client.runtime": "window",
      "okou.skeleton.threshold_ms": 10_000,
      "okou.document.visibility_state": document.visibilityState,
    },
    "scope.name": "okou-app/startup",
    "resource.deployment.environment.name": "production",
    "status.code": "ERROR",
  });
  expect(event.duration).toBeGreaterThanOrEqual(10_000_000_000);
  expect(axiomTelemetry.flush).toHaveBeenCalledTimes(1);

  clerkLoad.resolve();
  await page.ready;
  expect(skeleton).toHaveAttribute("aria-hidden", "true");
  expect(timeoutEvents()).toHaveLength(1);
});

test("Report immediately when loading the entry module already took ten seconds", async () => {
  window.__appBootstrapStart = performance.now() - 10_001;

  await setupPage(pageOptions);
  await screen.findByRole("heading", { name: "Agents" });

  expect(timeoutEvents()).toHaveLength(1);
  expect(timeoutEvents()[0]?.duration).toBeGreaterThanOrEqual(10_000_000_000);
});

test("Do not report a skeleton that hides before the deadline", async () => {
  await setupPage(pageOptions);
  await screen.findByRole("heading", { name: "Agents" });

  expect(timeoutEvents()).toHaveLength(0);
  expect(axiomTelemetry.flush).not.toHaveBeenCalled();
});
