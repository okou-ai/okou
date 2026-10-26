import { onboardingStatusContract } from "@okouai/api-contracts/contracts/onboarding";
import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
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
    context.mocks.data.onboardingStatus({
      needsOnboarding: true,
      onboardingComplete: false,
    });
    await setupPage({
      context,
      path: `/works?discord=${marker}#discord_oauth=approve&state=attempt-fixture&approval_proof=private-fixture`,
      // The public callback remains exempt even before the provider is enabled.
      featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: false },
    });

    await expect(
      screen.findByRole("heading", { name: /Where .+ works/u }),
    ).resolves.toBeInTheDocument();
    expect(window.location.pathname).toBe("/works");
    expect(window.location.hash).toBe("");
    expect(
      screen.queryByLabelText("Onboarding prompt"),
    ).not.toBeInTheDocument();
  },
);

test("A callback arriving while the onboarding read is pending keeps its public route", async () => {
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
    path: "/works?context=original",
    featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: false },
  });
  await requested.promise;
  await page.content;
  await screen.findByRole("heading", { name: /Where .+ works/u });

  // Browser navigation races the startup guard's already in-flight read.
  window.history.pushState(null, "", "/works?discord=pending&context=callback");
  window.dispatchEvent(new PopStateEvent("popstate"));
  response.resolve();
  await page.ready;

  expect(window.location.pathname).toBe("/works");
  expect(new URLSearchParams(window.location.search).get("context")).toBe(
    "callback",
  );
  expect(
    screen.getByRole("heading", { name: /Where .+ works/u }),
  ).toBeInTheDocument();
  expect(screen.queryByLabelText("Onboarding prompt")).not.toBeInTheDocument();
});

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
    featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
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
      featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
    });
    expect(window.location.pathname).toBe(path);
    expect(
      screen.queryByLabelText("Onboarding prompt"),
    ).not.toBeInTheDocument();
    await expect(
      screen.findByRole("heading", { name: "Connection failed" }),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByText("This authorization was interrupted or refreshed."),
    ).toBeInTheDocument();
    expect(screen.getByText("Back to settings").closest("a")).toHaveAttribute(
      "href",
      "/works",
    );
  },
);
