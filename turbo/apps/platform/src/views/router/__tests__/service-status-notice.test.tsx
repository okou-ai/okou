import { HttpResponse } from "msw";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const STATUS_ISSUES_URL = "https://api.instatus.com/issues";

function mockDesktopLayout(): void {
  context.mocks.browser.matchMedia((query) => {
    return query === "(min-width: 48rem)";
  });
}

function mockActiveIncident(onRequest?: () => void): void {
  context.mocks.http.get(STATUS_ISSUES_URL, () => {
    onRequest?.();
    return HttpResponse.json({
      activeIncidents: [
        {
          id: "incident-api-latency",
          name: "API requests are delayed",
          status: "INVESTIGATING",
        },
      ],
    });
  });
}

function controlNamed(role: "button" | "link", name: string): HTMLElement {
  const control = queryAllByRoleFast(role).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
  if (!control) {
    throw new Error(`${name} ${role} not found`);
  }
  return control;
}

test("An Okou production user can view and dismiss an active incident", async () => {
  const user = userEvent.setup();
  mockDesktopLayout();
  mockActiveIncident();

  await setupPage({ context, host: "app.okou.ai", path: "/agents" });

  const statusRegion = await screen.findByRole("region", {
    name: "Service status updates",
  });
  expect(
    screen.getByRole("status", {
      name: "Investigating: API requests are delayed",
    }),
  ).toBeVisible();
  expect(controlNamed("link", "View latest updates")).toHaveAttribute(
    "href",
    "https://status.okou.ai/incident-api-latency",
  );

  await user.click(controlNamed("button", "Dismiss service update"));

  expect(statusRegion).not.toBeInTheDocument();
});

test("A lookalike production hostname does not request service status", async () => {
  let statusRequested = false;
  mockDesktopLayout();
  mockActiveIncident(() => {
    statusRequested = true;
  });

  await setupPage({
    context,
    host: "app.okou.ai.evil.example",
    path: "/agents",
  });

  await screen.findByRole("heading", { name: "Agents" });
  expect(statusRequested).toBeFalsy();
  expect(
    screen.queryByRole("region", { name: "Service status updates" }),
  ).not.toBeInTheDocument();
});
