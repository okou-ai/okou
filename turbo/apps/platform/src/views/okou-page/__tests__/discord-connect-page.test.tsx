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
      current = status({ isConnected: true });
      return respond(200, {
        status: "connected",
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
    click(getAction("button", "Connect"));
    await waitFor(() => {
      expect(popup.location.href).toBe(authorizationUrl);
    });
    expect(getAction("button", "Connecting...")).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Complete authorization in the Discord window",
    );
    expect(queryAction("link", "Open Discord")).not.toBeInTheDocument();
    expect(requestBody).toStrictEqual({ flow: "connect", guildId });
    expect(completionBody).toBeUndefined();
    popup.close();
    await waitFor(() => {
      const completed = screen.getByRole("heading", {
        name: "Connected to Discord",
      });
      expect(completed).toBeInTheDocument();
    });
    expect(completionBody).toStrictEqual({ state, completionToken });
    await waitFor(() => {
      expect(
        Object.fromEntries(new URLSearchParams(window.location.search)),
      ).toStrictEqual({
        status: "connected",
        workspace: "Design team",
        guild_id: guildId,
      });
    });
    expect(
      queryAction("link", "Open Discord")?.getAttribute("href") ?? null,
    ).toBe(`discord://-/channels/${guildId}`);
    expect(
      queryAction("link", "Open in browser")?.getAttribute("href") ?? null,
    ).toBe(`https://discord.com/channels/${guildId}`);
  },
);

test.each([false, true])(
  "The Discord success URL uses verified connection data (connected: %s)",
  async (isConnected) => {
    context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
      return respond(200, status({ isConnected }));
    });
    await setupPage({
      context,
      path: `${path}&status=connected&workspace=Unverified+server`,
      featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
    });
    expect(screen.queryByText(/Unverified server/u)).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: isConnected ? "Connected to Discord" : "Connect to Discord",
      }),
    ).toBeInTheDocument();
    expect(
      queryAction("link", "Open Discord")?.getAttribute("href") ?? null,
    ).toBe(isConnected ? `discord://-/channels/${guildId}` : null);
    const action = isConnected
      ? getAction("link", "Open Discord")
      : getAction("button", "Connect");
    expect(action).not.toBeDisabled();
  },
);

test("A blocked Discord popup shows a retry action on the connection page", async () => {
  context.mocks.browser.open(null);
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, status());
  });
  await setupPage({
    context,
    path,
    featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
  });
  click(getAction("button", "Connect"));
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Allow popups to authorize Discord, then try again.",
  );
  expect(getAction("button", "Retry")).toBeEnabled();
  expect(queryAction("link", "Open Discord")).not.toBeInTheDocument();
});

test("Closing Discord consent without approval keeps the page retryable without a success URL", async () => {
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, status());
  });
  const popup = context.mocks.browser.authWindow();
  Object.defineProperty(popup, "location", {
    configurable: true,
    value: { href: "" },
  });
  context.mocks.browser.open(popup);
  const authorizationUrl = `https://discord.com/oauth2/authorize?state=${"s".repeat(43)}`;
  context.mocks.api(discordOauthContract.start, ({ respond }) => {
    return respond(200, { authorizationUrl, completionToken: "c".repeat(43) });
  });
  context.mocks.api(discordOauthContract.complete, ({ respond }) => {
    return respond(400, {
      error: {
        code: "BAD_REQUEST",
        message: "Discord consent has not been approved",
      },
    });
  });
  await setupPage({
    context,
    path,
    featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
  });
  click(getAction("button", "Connect"));
  await waitFor(() => {
    expect(popup.location.href).toBe(authorizationUrl);
  });
  popup.close();
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Discord authorization could not be completed",
  );
  expect(getAction("button", "Retry")).toBeEnabled();
  expect(queryAction("link", "Open Discord")).not.toBeInTheDocument();
  expect(new URLSearchParams(window.location.search).get("status")).not.toBe(
    "connected",
  );
});

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

test("A server link is independent of the workspace's previous server", async () => {
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(
      200,
      status({ guildId: "987654321098765432", isAdmin: false }),
    );
  });
  await setupPage({
    context,
    path,
    featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
  });
  expect(getAction("button", "Connect")).toBeEnabled();
});

test("A malformed server link cannot start consent", async () => {
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, status());
  });
  await setupPage({
    context,
    path: "/settings/discord?guild_id=invalid",
    featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: true },
  });
  expect(
    screen.getByText(
      "This Discord connection link is invalid. Open a new link from Discord.",
    ),
  ).toBeInTheDocument();
  expect(queryAction("button", "Connect")).not.toBeInTheDocument();
});

test.each([
  path,
  `/settings/discord?status=pending#discord_oauth=approve&state=${"s".repeat(43)}&approval_proof=${"p".repeat(43)}`,
])(
  "A disabled Discord integration at %s offers no authorization action",
  async (disabledPath) => {
    const approvals: unknown[] = [];
    context.mocks.api(discordOauthContract.approve, ({ body, respond }) => {
      approvals.push(body);
      return respond(200, { approved: true });
    });
    await setupPage({
      context,
      path: disabledPath,
      featureSwitches: { [FeatureSwitchKey.DiscordIntegration]: false },
    });
    expect(
      screen.getByText("Discord is not configured for this organization yet."),
    ).toBeInTheDocument();
    expect(queryAction("button", "Connect")).not.toBeInTheDocument();
    expect(queryAction("button", "Install to Discord")).not.toBeInTheDocument();
    expect(approvals).toStrictEqual([]);
    expect(window.location.hash).toBe("");
  },
);

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
