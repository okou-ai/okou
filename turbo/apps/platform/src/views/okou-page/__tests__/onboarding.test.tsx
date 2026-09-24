import { slackConnectContract } from "@okouai/api-contracts/contracts/slack-connect";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { pathname, search } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function mockOnboardingNeeded(): void {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
}

test("A new user keeps prompt and connector context through onboarding", async () => {
  mockOnboardingNeeded();

  await setupPage({
    context,
    path: "/?prompt=hello%20world&connector=github&vm0_source=presentation",
  });

  await expect(
    screen.findByRole("heading", { name: "Try this prompt" }),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe("/onboarding");
  const onboardingContext = new URLSearchParams(search());
  expect(onboardingContext.get("prompt")).toBe("hello world");
  expect(onboardingContext.get("connector")).toBe("github");
  expect(onboardingContext.get("vm0_source")).toBe("presentation");
  expect(screen.getByLabelText("Onboarding prompt")).toHaveValue("hello world");
});

test("A Slack success return remains visible before onboarding", async () => {
  mockOnboardingNeeded();
  context.mocks.browser.open();

  await setupPage({
    context,
    path: "/settings/slack?status=connected&workspace=Acme+Workspace",
  });

  await expect(
    screen.findByRole("heading", { name: "Connected to Slack!" }),
  ).resolves.toBeInTheDocument();
  expect(pathname()).not.toBe("/onboarding");
});

test("A Slack connection page remains visible before onboarding", async () => {
  mockOnboardingNeeded();
  context.mocks.api(slackConnectContract.getLinkStatus, ({ respond }) => {
    return respond(200, {
      isConnected: false,
      isAdmin: false,
      linkStatus: { kind: "connect" },
    });
  });

  await setupPage({
    context,
    path: "/settings/slack?w=T_WORKSPACE&u=U_MEMBER",
  });

  await expect(
    screen.findByRole("heading", { name: "Connect to Slack" }),
  ).resolves.toBeInTheDocument();
  expect(pathname()).not.toBe("/onboarding");
});

test("An unsuccessful Slack return remains visible before onboarding", async () => {
  mockOnboardingNeeded();

  await setupPage({ context, path: "/settings/slack?error=access_denied" });

  await expect(
    screen.findByRole("heading", { name: "Connection failed" }),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe("/settings/slack");
});
