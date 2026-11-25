import { slackConnectContract } from "@okouai/api-contracts/contracts/slack-connect";
import { test, expect } from "vitest";
import { screen } from "@testing-library/react";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockSlack } from "./connector-integrations-test-helpers.ts";
const context = testContext();
function incomplete() {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
}
test("onboarding-001 entering Home with a presentation task carries its GitHub context to the prompt editor", async () => {
  incomplete();
  const task = "Create a presentation about open GitHub issues";
  const query = new URLSearchParams({
    prompt: task,
    connector: "github",
    vm0_source: "presentation",
  });
  await setupPage({ context, path: "/?" + query });
  await expect(
    screen.findByLabelText("Onboarding prompt"),
  ).resolves.toHaveValue(task);
  const target = new URL(location.href);
  expect(target.pathname).toBe("/onboarding");
  for (const [key, value] of query) {
    expect(target.searchParams.get(key)).toBe(value);
  }
});
test("onboarding-004 the disconnected Slack settings entry remains available to a new non-admin", async () => {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
    isAdmin: false,
  });
  const workspaceId = "T_REVIEW";
  const slackUserId = "U_ANALYST";
  context.mocks.api(
    slackConnectContract.getLinkStatus,
    ({ query, respond }) => {
      expect(query).toMatchObject({ workspaceId, slackUserId });
      return respond(200, {
        isConnected: false,
        isAdmin: false,
        linkStatus: { kind: "connect" },
      });
    },
  );
  await setupPage({
    context,
    path:
      "/settings/slack?" +
      new URLSearchParams({ w: workspaceId, u: slackUserId }),
  });
  await expect(
    screen.findByRole("heading", { name: "Connect to Slack" }),
  ).resolves.toBeVisible();
  expect(location.pathname).toBe("/settings/slack");
});
test("onboarding-005 declining Slack authorization leaves its return notice on Slack settings", async () => {
  incomplete();
  mockSlack(context, { isInstalled: false, isConnected: false });
  await setupPage({ context, path: "/settings/slack?error=access_denied" });
  await expect(
    screen.findByText(/Slack authorization was not completed/),
  ).resolves.toBeVisible();
  expect(location.pathname).toBe("/settings/slack");
});
