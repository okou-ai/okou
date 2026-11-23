import {
  setupAddAccountPage,
  openAccountMenu,
} from "./sidebar-account-test-helpers.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { DetachedBrowserContext } from "happy-dom";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect, vi } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
const context = testContext();
test("sidebar-account-menu-006 Help offers the public documentation in a separate tab and opens the keyboard reference", async () => {
  context.mocks.http.get("https://www.okou.ai/en/docs", () => {
    return new Response("<title>Docs</title>", {
      headers: { "Content-Type": "text/html" },
    });
  });
  await setupPage({
    context,
    path: "/",
    host: "app.okou.ai",
    auth: { user: { id: "alex", fullName: "Alex Rivera" } },
    sharedWorkerTestTransport: "message-port",
  });
  const rail = await screen.findByTestId("labeled-nav-rail");
  const account = await within(rail).findByLabelText("Alex Rivera");
  const help = async () => {
    click(account);
    const root = await screen.findByRole("menu");
    await userEvent.click(within(root).getByText("Help"));
    return screen.findByText("Docs");
  };
  const docs = await help();
  const tabs = vi.spyOn(DetachedBrowserContext.prototype, "newPage");
  await userEvent.click(docs);
  await waitFor(() => {
    expect(
      tabs.mock.results.map(({ value }) => {
        return value.url;
      }),
    ).toContain("https://www.okou.ai/en/docs");
  });
  for (const { value: tab } of tabs.mock.results) {
    await tab.close();
  }
  await help();
  click(screen.getByText("Shortcuts"));
  const reference = await screen.findByRole("dialog", {
    name: "Keyboard Shortcuts",
  });
  expect(within(reference).getByText("Show shortcuts")).toBeInTheDocument();
});

test("sidebar-account-menu-004 adding another account uses a dark-theme hosted sign-in with a return to home", async () => {
  context.mocks.data.userPreferences({
    theme: "dark",
    colorTheme: "blue-horizon",
  });
  const sdk = context.mocks.clerk();
  await setupAddAccountPage(context);
  await openAccountMenu();
  click(await screen.findByText("Add account"));
  await waitFor(() => {
    return expect(mockedClerk.openSignIn.mock.lastCall?.[0]).toMatchObject({
      fallbackRedirectUrl: "/",
      forceRedirectUrl: "/",
      appearance: {
        theme: "simple",
        options: {
          logoImageUrl: expect.stringMatching(/okou-logo-wordmark-light.*svg$/),
          logoLinkUrl: "/",
        },
        elements: {
          formButtonPrimary: expect.stringContaining("bg-primary"),
          formFieldInput: expect.stringContaining("bg-input"),
        },
      },
    });
  });
  expect(sdk.uiRequests).toContain(
    "https://app.example.test/assets/clerk-ui-test.js",
  );
});
