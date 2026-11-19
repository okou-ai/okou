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
const regionName = "Service status updates";

async function openApp(onDesktop: boolean) {
  context.mocks.browser.matchMedia(onDesktop);
  context.mocks.http.get("https://api.instatus.com/issues", () => {
    return HttpResponse.json({
      activeIncidents: [
        {
          id: "api-delays",
          name: "Delayed API requests",
          status: "INVESTIGATING",
        },
      ],
    });
  });
  await setupPage({ context, path: "/", host: "app.okou.ai" });
  return await screen.findByRole("region", { name: regionName });
}

test("A desktop user can open or dismiss an active service incident", async () => {
  const notice = await openApp(true);
  expect(within(notice).getByText("Investigating")).toBeInTheDocument();
  expect(within(notice).getByText("Delayed API requests")).toBeInTheDocument();
  expect(
    within(notice).getByRole("link", { name: "View latest updates" }),
  ).toHaveAttribute("href", "https://status.okou.ai/api-delays");

  const dismiss = queryAllByRoleFast("button", notice).find((button) => {
    return button.getAttribute("aria-label") === "Dismiss service update";
  });
  if (!dismiss) {
    throw new Error("Missing incident dismissal");
  }
  click(dismiss);
  await waitFor(() => {
    expect(
      screen.queryByRole("region", { name: regionName }),
    ).not.toBeInTheDocument();
  });
});

test("A mobile user can see an active incident alongside main navigation", async () => {
  const notice = await openApp(false);
  expect(
    screen.getByRole("navigation", { name: "Main navigation" }),
  ).toBeVisible();
  expect(within(notice).getByText("Investigating")).toBeVisible();
  expect(within(notice).getByText("Delayed API requests")).toBeVisible();
});
