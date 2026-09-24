import {
  integrationsDiscordContract,
  type DiscordOrgStatus,
} from "@okouai/api-contracts/contracts/integrations-discord";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getAction,
  getIntegrationCard,
  queryAction,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();

function status(overrides: Partial<DiscordOrgStatus> = {}): DiscordOrgStatus {
  return {
    isAvailable: true,
    isInstalled: true,
    isConnected: true,
    isAdmin: false,
    guildId: "123456789012345678",
    guildName: "Design team",
    discordUserId: "234567890123456789",
    defaultAgentId: null,
    defaultAgentName: null,
    onboarding: "oauth_deferred",
    dmSelectionConnectionId: null,
    dmBindings: [],
    contextMode: "mentions_only",
    ...overrides,
  };
}

function setupDiscordPage(enabled = true) {
  return setupPage({
    context,
    path: "/works",
    featureSwitches: {
      [FeatureSwitchKey.DiscordIntegration]: enabled,
      [FeatureSwitchKey.FeishuIntegration]: false,
      [FeatureSwitchKey.LarkIntegration]: false,
    },
  });
}

test("Discord is hidden while its feature switch is off", async () => {
  await setupDiscordPage(false);
  expect(screen.getByText("Slack")).toBeInTheDocument();
  expect(screen.queryByText("Discord")).not.toBeInTheDocument();
});

test.each([
  {
    name: "unconfigured admin",
    data: {
      isAvailable: false,
      isAdmin: true,
      contextMode: "unavailable" as const,
    },
    message: "Discord is not available yet for this organization.",
  },
  {
    name: "configured admin without a server",
    data: { isAdmin: true },
    message:
      "Server setup is not available yet. Existing verified configurations can continue to use Discord.",
  },
  {
    name: "member without a server",
    data: { isAdmin: false },
    message:
      "Ask an organization admin about Discord access. Server setup is not available yet.",
  },
  {
    name: "member without a verified connection",
    data: {
      isInstalled: true,
      guildId: "123456789012345678",
      guildName: "Design team",
    },
    message:
      "Your account is not connected. Connecting a new Discord account is not available yet.",
  },
])("Discord explains setup to a $name", async ({ data, message }) => {
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(
      200,
      status({
        isInstalled: false,
        isConnected: false,
        guildId: null,
        guildName: null,
        discordUserId: null,
        ...data,
      }),
    );
  });
  await setupDiscordPage();

  await expect(screen.findByText(message)).resolves.toBeInTheDocument();
  const card = getIntegrationCard("Discord");
  expect(queryAction("button", "Connect", card)).toBeNull();
  expect(queryAction("button", "More Discord options", card)).toBeNull();
});

test("A connected member sees server and context limits and can disconnect", async () => {
  let current = status();
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, current);
  });
  context.mocks.api(integrationsDiscordContract.disconnect, ({ respond }) => {
    current = { ...current, isConnected: false, discordUserId: null };
    return respond(200, { ok: true });
  });
  await setupDiscordPage();

  await expect(
    screen.findByText("Server: Design team"),
  ).resolves.toBeInTheDocument();
  const card = getIntegrationCard("Discord");
  expect(within(card).getByText("Connected")).toBeInTheDocument();
  expect(within(card).getByText(/Limited context:/u)).toBeInTheDocument();
  click(getAction("button", "More Discord options", card));
  expect(queryAction("button", "Remove Discord")).toBeNull();
  click(getAction("button", "Disconnect Discord"));

  await expect(
    screen.findByText(
      "Your account is not connected. Connecting a new Discord account is not available yet.",
    ),
  ).resolves.toBeInTheDocument();
  expect(within(card).queryByText("Connected")).not.toBeInTheDocument();
});

test("A failed disconnect preserves the connection and allows retry", async () => {
  let current = status();
  let denied = true;
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, current);
  });
  context.mocks.api(integrationsDiscordContract.disconnect, ({ respond }) => {
    if (denied) {
      return respond(403, {
        error: { code: "FORBIDDEN", message: "Discord disconnect denied" },
      });
    }
    current = { ...current, isConnected: false, discordUserId: null };
    return respond(200, { ok: true });
  });
  await setupDiscordPage();
  await expect(
    screen.findByText("Server: Design team"),
  ).resolves.toBeInTheDocument();
  click(
    getAction("button", "More Discord options", getIntegrationCard("Discord")),
  );
  click(getAction("button", "Disconnect Discord"));

  await expect(
    screen.findByText("Discord disconnect denied"),
  ).resolves.toBeInTheDocument();
  expect(
    within(getIntegrationCard("Discord")).getByText("Connected"),
  ).toBeInTheDocument();
  denied = false;
  await waitFor(() => {
    return expect(getAction("button", "Disconnect Discord")).toBeEnabled();
  });
  click(getAction("button", "Disconnect Discord"));
  await expect(
    screen.findByText(/Your account is not connected/u),
  ).resolves.toBeInTheDocument();
});

test("An admin confirms server removal and can retry a failed removal", async () => {
  let current = status({
    isAdmin: true,
    isConnected: false,
    discordUserId: null,
    contextMode: "full",
  });
  let denied = true;
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, current);
  });
  context.mocks.api(
    integrationsDiscordContract.disconnect,
    ({ query, respond }) => {
      if (query.action !== "uninstall") {
        throw new Error("Server removal must request the admin action");
      }
      if (denied) {
        return respond(403, {
          error: { code: "FORBIDDEN", message: "Discord removal denied" },
        });
      }
      current = {
        ...current,
        isInstalled: false,
        guildId: null,
        guildName: null,
      };
      return respond(200, { ok: true });
    },
  );
  await setupDiscordPage();
  await expect(
    screen.findByText("Server: Design team"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText(/Limited context:/u)).not.toBeInTheDocument();
  click(
    getAction("button", "More Discord options", getIntegrationCard("Discord")),
  );
  click(getAction("button", "Remove Discord"));
  const dialog = await screen.findByRole("dialog", {
    name: "Remove Discord from this organization?",
  });
  expect(dialog).toHaveAccessibleDescription(
    "This disconnects everyone in this organization from Discord. Other organizations keep their connections.",
  );
  click(getAction("button", "Uninstall", dialog));

  await expect(
    screen.findByText("Discord removal denied"),
  ).resolves.toBeInTheDocument();
  expect(dialog).toBeInTheDocument();
  denied = false;
  await waitFor(() => {
    return expect(getAction("button", "Uninstall", dialog)).toBeEnabled();
  });
  click(getAction("button", "Uninstall", dialog));
  await expect(
    screen.findByText(/Server setup is not available yet/u),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("Discord status converges after a connection change from another surface", async () => {
  let current = status({
    isConnected: false,
    discordUserId: null,
    isAdmin: true,
  });
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, current);
  });
  await setupDiscordPage();
  await expect(
    screen.findByText(/Your account is not connected/u),
  ).resolves.toBeInTheDocument();

  current = {
    ...current,
    isConnected: true,
    discordUserId: "234567890123456789",
    guildName: "Updated team",
  };
  context.mocks.ably.trigger("discord:changed");
  await expect(
    screen.findByText("Server: Updated team"),
  ).resolves.toBeInTheDocument();
  expect(
    within(getIntegrationCard("Discord")).getByText("Connected"),
  ).toBeInTheDocument();

  current = {
    ...current,
    isConnected: false,
    isInstalled: false,
    guildId: null,
    guildName: null,
    discordUserId: null,
  };
  context.mocks.ably.trigger("discord:changed");
  await expect(
    screen.findByText(/Server setup is not available yet/u),
  ).resolves.toBeInTheDocument();
  expect(
    queryAction(
      "button",
      "More Discord options",
      getIntegrationCard("Discord"),
    ),
  ).toBeNull();
});

test("A status error is visible and retry recovers the card", async () => {
  let denied = true;
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    if (denied) {
      return respond(403, {
        error: { code: "FORBIDDEN", message: "Discord access denied" },
      });
    }
    return respond(200, status());
  });
  await setupDiscordPage();
  await expect(
    screen.findByText("Unable to load Discord status."),
  ).resolves.toBeInTheDocument();
  const card = getIntegrationCard("Discord");
  expect(queryAction("button", "More Discord options", card)).toBeNull();
  denied = false;
  click(getAction("button", "Retry", card));
  await expect(
    screen.findByText("Server: Design team"),
  ).resolves.toBeInTheDocument();
});

test("Direct messages require an explicit server choice and a failed save keeps the prior choice", async () => {
  const first = "e0000000-0000-4000-a000-000000000001";
  const second = "e0000000-0000-4000-a000-000000000002";
  let current = status({
    dmBindings: [
      {
        connectionId: first,
        guildId: "123456789012345678",
        guildName: "Design team",
      },
      {
        connectionId: second,
        guildId: "345678901234567890",
        guildName: "Operations",
      },
    ],
  });
  let denied = true;
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, current);
  });
  context.mocks.api(
    integrationsDiscordContract.setDmSelection,
    ({ body, respond }) => {
      if (denied) {
        return respond(403, {
          error: { code: "FORBIDDEN", message: "Discord choice denied" },
        });
      }
      current = { ...current, dmSelectionConnectionId: body.connectionId };
      return respond(200, { ok: true });
    },
  );
  await setupDiscordPage();
  const select = await screen.findByRole("combobox", {
    name: "Default server for direct messages",
  });
  expect(select).toHaveTextContent("Choose a server");
  click(select);
  click(await screen.findByRole("option", { name: "Operations" }));

  await expect(
    screen.findByText("Discord choice denied"),
  ).resolves.toBeInTheDocument();
  expect(select).toHaveTextContent("Choose a server");
  denied = false;
  await waitFor(() => {
    expect(select).toBeEnabled();
  });
  click(select);
  click(await screen.findByRole("option", { name: "Operations" }));
  await waitFor(() => {
    expect(
      screen.getByRole("combobox", {
        name: "Default server for direct messages",
      }),
    ).toHaveTextContent("Operations");
  });

  current = { ...current, dmSelectionConnectionId: first };
  context.mocks.ably.trigger("discord:changed");
  await waitFor(() => {
    expect(
      screen.getByRole("combobox", {
        name: "Default server for direct messages",
      }),
    ).toHaveTextContent("Design team");
  });
});

test.each(["successful refresh", "failed refresh and retry"])(
  "A pending DM choice remains disabled through a %s",
  async (refresh) => {
    const first = "e0000000-0000-4000-a000-000000000001";
    const second = "e0000000-0000-4000-a000-000000000002";
    const saveStarted = context.mocks.deferred<void>();
    const saveReady = context.mocks.deferred<void>();
    const refreshStarted = context.mocks.deferred<void>();
    const refreshReady = context.mocks.deferred<void>();
    const submitted: string[] = [];
    let current = status({
      dmSelectionConnectionId: first,
      dmBindings: [
        {
          connectionId: first,
          guildId: "123456789012345678",
          guildName: "Design team",
        },
        {
          connectionId: second,
          guildId: "345678901234567890",
          guildName: "Operations",
        },
      ],
    });
    let denyRefresh = false;
    let refreshing = false;
    context.mocks.api(
      integrationsDiscordContract.getStatus,
      async ({ respond, withSignal }) => {
        if (refreshing) {
          refreshStarted.resolve();
          await withSignal(refreshReady.promise);
        }
        if (denyRefresh) {
          return respond(403, {
            error: { code: "FORBIDDEN", message: "Discord refresh denied" },
          });
        }
        return respond(200, current);
      },
    );
    context.mocks.api(
      integrationsDiscordContract.setDmSelection,
      async ({ body, respond, withSignal }) => {
        submitted.push(body.connectionId);
        saveStarted.resolve();
        await withSignal(saveReady.promise);
        current = { ...current, dmSelectionConnectionId: body.connectionId };
        return respond(200, { ok: true });
      },
    );
    await setupDiscordPage();
    click(
      await screen.findByRole("combobox", {
        name: "Default server for direct messages",
      }),
    );
    click(await screen.findByRole("option", { name: "Operations" }));
    await saveStarted.promise;

    current = { ...current, guildName: "Updated team" };
    refreshing = true;
    denyRefresh = refresh === "failed refresh and retry";
    context.mocks.ably.trigger("discord:changed");
    await refreshStarted.promise;
    expect(
      screen.getByRole("combobox", {
        name: "Default server for direct messages",
      }),
    ).toBeDisabled();
    refreshReady.resolve();
    if (denyRefresh) {
      await expect(
        screen.findByText("Unable to load Discord status."),
      ).resolves.toBeInTheDocument();
      denyRefresh = false;
      click(getAction("button", "Retry", getIntegrationCard("Discord")));
    }
    await expect(
      screen.findByText("Server: Updated team"),
    ).resolves.toBeInTheDocument();
    const select = screen.getByRole("combobox", {
      name: "Default server for direct messages",
    });
    expect(select).toBeDisabled();
    expect(select).toHaveTextContent("Design team");
    click(select);
    expect(screen.queryByRole("option", { name: "Design team" })).toBeNull();
    expect(submitted).toStrictEqual([second]);

    saveReady.resolve();
    await waitFor(() => {
      const saved = screen.getByRole("combobox", {
        name: "Default server for direct messages",
      });
      expect(saved).toBeEnabled();
      expect(saved).toHaveTextContent("Operations");
    });
  },
);
