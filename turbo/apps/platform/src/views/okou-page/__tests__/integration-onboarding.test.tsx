import { onboardingStatusContract } from "@okouai/api-contracts/contracts/onboarding";
import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage, startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function mockDisconnectedDiscord(): void {
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, {
      isAvailable: true,
      isConnected: false,
      isAdmin: true,
      guildId: null,
      guildName: null,
      discordUserId: null,
      defaultAgentId: null,
      defaultAgentName: null,
      onboarding: "oauth",
      dmSelectionConnectionId: null,
      dmBindings: [],
      contextMode: "mentions_only",
    });
  });
}

test.each(["pending", "error", "connected"])(
  "A legacy Discord %s callback is exempt before onboarding can resolve",
  async (marker) => {
    mockDisconnectedDiscord();
    context.mocks.data.onboardingStatus({
      needsOnboarding: true,
      onboardingComplete: false,
    });
    await setupPage({
      context,
      path: `/works?discord=${marker}#discord_oauth=approve&state=attempt-fixture&approval_proof=private-fixture`,
    });

    await expect(
      screen.findByText("Back to settings"),
    ).resolves.toBeInTheDocument();
    expect(window.location.pathname).toBe("/settings/discord");
    expect(window.location.hash).toBe("");
    expect(
      screen.queryByLabelText("Onboarding prompt"),
    ).not.toBeInTheDocument();
  },
);

test("The legacy callback bridge can finish before a pending onboarding response", async () => {
  mockDisconnectedDiscord();
  const requested = context.mocks.deferred<void>();
  const response = context.mocks.deferred<void>();
  context.mocks.api(onboardingStatusContract.getStatus, async ({ respond }) => {
    requested.resolve();
    await response.promise;
    return respond(200, {
      defaultAgentId: null,
      defaultAgentMetadata: null,
      hasDefaultAgent: true,
      hasOrg: true,
      isAdmin: true,
      needsOnboarding: true,
      onboardingComplete: false,
    });
  });
  const page = await startPage({
    context,
    path: "/works",
  });
  await requested.promise;
  await page.content;
  window.history.pushState(null, "", "/works?discord=pending");
  window.dispatchEvent(new PopStateEvent("popstate"));
  await waitFor(() => {
    expect(window.location.pathname).toBe("/settings/discord");
  });
  response.resolve();
  await page.ready;

  expect(window.location.pathname).toBe("/settings/discord");
  expect(screen.queryByLabelText("Onboarding prompt")).not.toBeInTheDocument();
});

test.each(["/works", "/works?discord=unknown"])(
  "%s still requires onboarding",
  async (path) => {
    context.mocks.data.onboardingStatus({
      needsOnboarding: true,
      onboardingComplete: false,
    });
    await setupPage({
      context,
      path: `${path}${path.includes("?") ? "&" : "?"}prompt=guard-check`,
    });
    await expect(
      screen.findByLabelText("Onboarding prompt"),
    ).resolves.toBeInTheDocument();
    expect(window.location.pathname).toBe("/onboarding");
  },
);

test.each(["/settings/discord", "/settings/discord/install"])(
  "%s retains its canonical onboarding bypass without treating a marker as proof",
  async (path) => {
    mockDisconnectedDiscord();
    context.mocks.data.onboardingStatus({
      needsOnboarding: true,
      onboardingComplete: false,
    });
    await setupPage({
      context,
      path: `${path}?status=pending`,
    });
    expect(window.location.pathname).toBe(path);
    expect(
      screen.queryByLabelText("Onboarding prompt"),
    ).not.toBeInTheDocument();
    await expect(
      screen.findByRole("heading", { name: "Connection failed" }),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByText(/restart the connection|Start again/u),
    ).toBeInTheDocument();
    expect(screen.getByText("Back to settings").closest("a")).toHaveAttribute(
      "href",
      "/works",
    );
  },
);
