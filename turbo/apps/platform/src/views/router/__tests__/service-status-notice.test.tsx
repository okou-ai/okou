import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function reportDelay(id: string, title: string) {
  context.mocks.http.get("https://api.instatus.com/issues", () => {
    return HttpResponse.json({
      activeIncidents: [{ id, name: title, status: "INVESTIGATING" }],
    });
  });
}

test("service-status-notice-001 the investigating incident links to its update and can be dismissed", async () => {
  const title = "Delayed API requests in the billing region";
  reportDelay("api-billing-delay", title);
  context.mocks.browser.matchMedia((query) => {
    return query === "(min-width: 48rem)";
  });
  await setupPage({ context, path: "/", host: "app.okou.ai" });
  const region = await screen.findByRole("region", {
    name: "Service status updates",
  });
  const incident = within(region).getByRole("status", {
    name: "Investigating: " + title,
  });
  expect(within(incident).getByText("Investigating")).toBeInTheDocument();
  expect(
    queryAllByRoleFast("link", incident).find((link) => {
      return link.textContent?.trim() === "View latest updates";
    }),
  ).toHaveAttribute("href", "https://status.okou.ai/api-billing-delay");
  const dismiss = queryAllByRoleFast("button", incident).find((button) => {
    return button.getAttribute("aria-label") === "Dismiss service update";
  });
  if (!dismiss) {
    throw new Error("Missing dismiss control for the billing incident");
  }
  click(dismiss);
  await waitFor(() => {
    expect(
      screen.queryByRole("region", { name: "Service status updates" }),
    ).not.toBeInTheDocument();
  });
});

test("service-status-notice-003 mobile home displays its navigation and the current API incident", async () => {
  context.mocks.browser.matchMedia(false);
  reportDelay("mobile-api-delay", "Delayed API requests on the public gateway");
  await setupPage({ context, path: "/connectors", host: "app.okou.ai" });
  const nav = await screen.findByRole("navigation", {
    name: "Main navigation",
  });
  const home = queryAllByRoleFast("link", nav).find((link) => {
    return link.textContent?.trim() === "Chats";
  });
  if (!home) {
    throw new Error("Missing Chats tab in mobile navigation");
  }
  click(home);
  const incident = await screen.findByRole("status", {
    name: "Investigating: Delayed API requests on the public gateway",
  });
  await waitFor(() => {
    expect(window.location.pathname).toBe("/");
    expect(incident).toBeVisible();
    expect(
      screen.getByRole("navigation", { name: "Main navigation" }),
    ).toBeVisible();
  });
});
