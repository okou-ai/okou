import {
  integrationsDiscordContract,
  type DiscordOrgStatus,
} from "@okouai/api-contracts/contracts/integrations-discord";
import { discordOauthContract } from "@okouai/api-contracts/contracts/discord-oauth";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage, startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

import {
  getAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
const guildId = "123456789012345678";
const path = `/settings/discord?guild_id=${guildId}`;

function status(overrides: Partial<DiscordOrgStatus> = {}): DiscordOrgStatus {
  return {
    isAvailable: true,
    isInstalled: true,
    isConnected: false,
    isAdmin: true,
    guildId,
    guildName: "Design team",
    discordUserId: null,
    defaultAgentId: null,
    defaultAgentName: null,
    onboarding: "oauth",
    dmSelectionConnectionId: null,
    dmBindings: [],
    contextMode: "mentions_only",
    ...overrides,
  };
}

test.each(["install", "connect"] as const)(
  "The Discord bot link offers %s directly and retains the target server",
  async (flow) => {
    let current = status({
      isInstalled: flow === "connect",
      guildId: flow === "connect" ? guildId : null,
      guildName: flow === "connect" ? "Design team" : null,
    });
    context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
      return respond(200, current);
    });
    const popup = context.mocks.browser.authWindow();
    Object.defineProperty(popup, "location", {
      configurable: true,
      value: { href: "" },
    });
    context.mocks.browser.open(popup);
    const state = "s".repeat(43);
    const completionToken = "c".repeat(43);
    const authorizationUrl = `https://discord.com/oauth2/authorize?state=${state}`;
    let requestBody: unknown;
    let completionBody: unknown;
    context.mocks.api(discordOauthContract.start, ({ body, respond }) => {
      requestBody = body;
      return respond(200, { authorizationUrl, completionToken });
    });
    context.mocks.api(discordOauthContract.complete, ({ body, respond }) => {
      completionBody = body;
      current = status({ isConnected: flow === "connect" });
      return respond(200, {
        status: flow === "install" ? "installed" : "connected",
      });
    });
    await setupPage({
      context,
      path,
      featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
    });
    expect(
      screen.getByRole("heading", { name: "Connect to Discord" }),
    ).toBeInTheDocument();
    click(
      getAction(
        "button",
        flow === "install" ? "Install to Discord" : "Connect",
      ),
    );
    await waitFor(() => {
      expect(popup.location.href).toBe(authorizationUrl);
    });
    expect(requestBody).toStrictEqual({ flow, guildId });
    expect(completionBody).toBeUndefined();
    popup.close();
    await waitFor(() => {
      const completed =
        flow === "connect"
          ? screen.getByRole("heading", { name: "Connected to Discord" })
          : getAction("button", "Connect");
      expect(completed).toBeInTheDocument();
    });
    expect(completionBody).toStrictEqual({ state, completionToken });
  },
);

test("A Discord DM link can connect without a server hint", async () => {
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, status());
  });
  await setupPage({
    context,
    path: "/settings/discord",
    featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
  });
  expect(getAction("button", "Connect")).toBeEnabled();
});

test("A failed Discord status request exposes the error page and its back link", async () => {
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(403, {
      error: { code: "FORBIDDEN", message: "Discord access denied" },
    });
  });
  await setupPage({
    context,
    path,
    featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
  });
  expect(
    screen.getByRole("heading", { name: "Connection failed" }),
  ).toBeInTheDocument();
  expect(getAction("link", "Back to settings")).toHaveAttribute(
    "href",
    "/works",
  );
  expect(queryAction("button", "Connect")).not.toBeInTheDocument();
});

test("A link for another server does not connect the wrong workspace", async () => {
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, status({ guildId: "987654321098765432" }));
  });
  await setupPage({
    context,
    path,
    featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
  });
  expect(
    screen.getByText(
      "This link is for a different Discord server. Switch to its Okou workspace and open the link again.",
    ),
  ).toBeInTheDocument();
  expect(queryAction("button", "Connect")).not.toBeInTheDocument();
});

test("A disabled Discord integration offers no authorization action", async () => {
  await setupPage({
    context,
    path,
    featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: false },
  });
  expect(
    screen.getByText("Discord is not configured for this organization yet."),
  ).toBeInTheDocument();
  expect(queryAction("button", "Connect")).not.toBeInTheDocument();
  expect(queryAction("button", "Install to Discord")).not.toBeInTheDocument();
});

test("A Discord connection link requires sign-in and preserves its server", async () => {
  await startPage({ context, path, host: "app.okou.ai", auth: null });
  await waitFor(() => {
    expect(window.location.pathname).toBe("/sign-in");
  });
  const redirect = new URLSearchParams(window.location.hash.split("?")[1]).get(
    "redirect_url",
  );
  expect(redirect).toContain(path);
});
