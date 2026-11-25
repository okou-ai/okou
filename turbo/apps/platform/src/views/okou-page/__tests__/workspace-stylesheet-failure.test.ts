// @vitest-environment-options {"url":"https://app.okou.ai/"}
import { screen, waitFor } from "@testing-library/react";
import { test, expect, vi } from "vitest";
import { startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
const received = vi.hoisted(() => {
  return vi.fn<(_dataset: string, events: { name: string }[]) => void>();
});
vi.mock("@axiomhq/js", () => {
  return {
    Axiom: class {
      ingest = received;
      async flush() {}
    },
  };
});
const context = testContext();
test("startup-diagnostics-001 A failed workspace stylesheet leaves the mounted page inert and its loading announcement active", async () => {
  const status = context.mocks.deferred<"loaded" | "failed">();
  const before = Object.getOwnPropertyDescriptor(
    window,
    "__mainStylesheetLoaded",
  );
  Object.defineProperty(window, "__mainStylesheetLoaded", {
    value: status.promise,
    configurable: true,
  });
  context.signal.addEventListener(
    "abort",
    () => {
      if (before) {
        Object.defineProperty(window, "__mainStylesheetLoaded", before);
      } else {
        delete window.__mainStylesheetLoaded;
      }
    },
    { once: true },
  );
  window.__appBootstrapStart = performance.now() - 21;
  window.__appBootstrapModuleReady = performance.now() - 4;
  context.signal.addEventListener(
    "abort",
    () => {
      delete window.__appBootstrapStart;
      delete window.__appBootstrapModuleReady;
    },
    { once: true },
  );
  const analytics = context.mocks.posthog();
  await startPage({
    context,
    path: "/workflows",
    host: "app.okou.ai",
    env: {
      VITE_POSTHOG_KEY: "phc_local",
      VITE_AXIOM_CLIENT_TELEMETRY_TOKEN: "local-stylesheet",
    },
  });
  const page = await screen.findByText("Workflows", { selector: "h1" });
  expect(
    received.mock.calls
      .flatMap(([, events]) => {
        return events;
      })
      .filter((e) => {
        return e.name === "bootstrap.stylesheet";
      }),
  ).toHaveLength(0);
  status.resolve("failed");
  await waitFor(() => {
    return expect(
      received.mock.calls.flatMap(([, events]) => {
        return events;
      }),
    ).toContainEqual(
      expect.objectContaining({
        name: "bootstrap.stylesheet",
        "attributes.custom": expect.objectContaining({
          "okou.client.outcome": "error",
        }),
      }),
    );
  });
  expect(page.closest("[inert]")).toBeInTheDocument();
  await expect(
    screen.findByRole("status", { name: "Loading" }),
  ).resolves.toBeVisible();
  expect(
    analytics.events.map((e) => {
      return e.name;
    }),
  ).not.toContain("app_first_skeleton_hide");
  expect(
    analytics.events.map((e) => {
      return e.name;
    }),
  ).not.toContain("app_bootstrap_phase_timing");
});
