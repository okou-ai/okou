import { createDefaultMockGithubIntegration } from "../../../mocks/handlers/api-integrations-github.ts";
import {
  integrationsAgentPhoneContract,
  type AgentPhoneLinkStatusResponse,
} from "@okouai/api-contracts/contracts/integrations-agentphone";
import { integrationsSlackContract } from "@okouai/api-contracts/contracts/integrations-slack";
import {
  integrationsTelegramContract,
  type TelegramBotStatus,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findAction,
  getAction,
  getIntegrationCard,
  mockSlack,
  mockTeams,
  queryAction,
  setupIntegrationsPage,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();

function openedTab(): Window {
  const tab = context.mocks.browser.authWindow();
  Object.defineProperty(tab, "location", {
    value: { href: "about:blank" },
    configurable: true,
  });
  context.mocks.browser.open(tab);
  return tab;
}

async function waitForRealtime(topic: string): Promise<void> {
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
  });
}

function mockAgentPhone(
  read: () => AgentPhoneLinkStatusResponse,
  code = "74290618",
): void {
  context.mocks.api(
    integrationsAgentPhoneContract.getLinkStatus,
    ({ respond }) => {
      return respond(200, read());
    },
  );
  context.mocks.api(
    integrationsAgentPhoneContract.createLinkCode,
    ({ respond }) => {
      return respond(200, {
        code,
        expiresAt: "2026-01-01T00:10:00.000Z",
      });
    },
  );
}

test("Integrations show current status and refresh after GitHub connects", async () => {
  mockSlack(context, {
    isConnected: true,
    isInstalled: true,
    isAdmin: true,
    workspaceName: "Okou HQ",
    scopeMismatch: true,
    reinstallUrl: "https://slack.test/reinstall",
  });
  mockAgentPhone(() => {
    return {
      linked: true,
      phoneHandle: "+15555551212",
      agentPhoneNumber: "+19039853128",
      configured: true,
    };
  });
  let github = createDefaultMockGithubIntegration({
    isConnected: false,
    connectedGithubUserId: null,
    connectedGithubUsername: null,
  });
  context.mocks.data.githubIntegration(github);
  const tab = openedTab();
  await setupIntegrationsPage(context);

  const slack = getIntegrationCard("Slack");
  await waitFor(() => {
    expect(slack).toHaveTextContent("Connected (Okou HQ)");
  });
  expect(getAction("button", "Update Permissions", slack)).toBeEnabled();
  await waitFor(() => {
    expect(getIntegrationCard("Phone")).toHaveTextContent("+15555551212");
  });
  expect(
    getAction("button", "Connect", getIntegrationCard("Discord")),
  ).toBeEnabled();
  expect(screen.queryByText("Feishu")).toBeNull();

  const githubCard = getIntegrationCard("GitHub");
  await waitFor(() => {
    expect(getAction("button", "Connect", githubCard)).toBeEnabled();
  });
  await waitForRealtime("github:changed");
  click(getAction("button", "Connect", githubCard));
  expect(tab.location.href).toMatch(
    /^https:\/\/github\.com\/login\/oauth\/authorize\?/u,
  );

  github = createDefaultMockGithubIntegration();
  context.mocks.data.githubIntegration(github);
  context.mocks.ably.trigger("github:changed");
  await waitFor(() => {
    expect(githubCard).toHaveTextContent("Connected (@octocat)");
  });
});

test("Slack keeps account disconnect in its overflow menu (admin: true)", async () => {
  let connected = true;
  context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
    return respond(200, {
      isConnected: connected,
      isInstalled: true,
      isAdmin: true,
      installUrl: "https://slack.test/install",
      connectUrl: "https://slack.test/connect",
      reinstallUrl: null,
      scopeMismatch: false,
      workspaceName: connected ? "Okou HQ" : null,
    });
  });
  context.mocks.api(integrationsSlackContract.disconnect, ({ respond }) => {
    connected = false;
    return respond(200, { ok: true });
  });
  await setupIntegrationsPage(context);
  const slack = getIntegrationCard("Slack");
  await waitFor(() => {
    expect(slack).toHaveTextContent("Connected (Okou HQ)");
  });
  expect(queryAction("button", "Disconnect", slack)).toBeNull();

  click(getAction("button", "More options", slack));
  await expect(findAction("button", "Uninstall")).resolves.toBeVisible();
  click(getAction("button", "Disconnect"));

  await waitFor(() => {
    expect(getAction("button", "Connect", slack)).toBeEnabled();
  });
  expect(slack).not.toHaveTextContent("Connected (Okou HQ)");
  expect(window.location.pathname).toBe("/works");
});

test("Authorize the official Telegram bot directly in a new tab from Integrations", async () => {
  const official: TelegramBotStatus = {
    id: "official",
    kind: "official",
    username: "okou_bot",
    avatarUrl: null,
    agent: null,
    isOwner: false,
    isConnected: false,
    connectedUser: null,
    tokenStatus: "valid",
    official: {
      configured: true,
      usesDefaultAgent: true,
      linkedTelegramUserId: null,
    },
    domainConfigured: true,
    environment: {
      requiredSecrets: [],
      requiredVars: [],
      missingSecrets: [],
      missingVars: [],
    },
  };
  context.mocks.data.telegramIntegration({ statuses: [official] });
  context.mocks.api(
    integrationsTelegramContract.getLinkStatus,
    ({ respond }) => {
      return respond(200, {
        linked: false,
        installation: {
          id: "official",
          botUsername: "okou_bot",
          loginBotId: "987654321",
          domainConfigured: true,
        },
      });
    },
  );
  const tab = openedTab();
  await setupIntegrationsPage(context);
  const telegram = getIntegrationCard("Telegram");
  await waitFor(() => {
    expect(getAction("button", "Connect", telegram)).toBeEnabled();
  });

  click(getAction("button", "Connect", telegram));
  await waitFor(() => {
    expect(tab.location.href).toMatch(/^https:\/\/oauth\.telegram\.org\/auth/u);
  });
  const authUrl = new URL(tab.location.href);
  expect(authUrl.searchParams.get("bot_id")).toBe("987654321");
  const callback = new URL(authUrl.searchParams.get("return_to") ?? "");
  const bridge = {
    protocol: 2,
    operationId: callback.searchParams.get("operationId"),
    bot: "official",
  };
  context.mocks.browser.message(
    { type: "telegram-auth-bridge-ready", ...bridge },
    { origin: callback.origin, source: tab },
  );
  context.mocks.browser.message(
    {
      type: "telegram-auth",
      ...bridge,
      data: {
        id: 4242,
        first_name: "Alice",
        username: "alice",
        auth_date: 1_767_225_600,
        hash: "a".repeat(64),
      },
    },
    { origin: callback.origin, source: tab },
  );

  await waitFor(() => {
    expect(telegram).toHaveTextContent("Connected (@alice)");
  });
  expect(queryAction("button", "Connect", telegram)).toBeNull();
  expect(window.location.pathname).toBe("/works");
  context.mocks.browser.message(
    { type: "telegram-auth-ack", stage: "result", ...bridge },
    { origin: callback.origin, source: tab },
  );
});

test("The phone card describes messaging and the connect dialog displays the destination number", async () => {
  mockAgentPhone(() => {
    return {
      linked: false,
      agentPhoneNumber: "+13144386568",
      configured: true,
    };
  });
  const clipboard = context.mocks.browser.clipboardWriteText();
  await setupIntegrationsPage(context);
  const phone = getIntegrationCard("Phone");
  expect(phone).toHaveTextContent("Text-message access to Okou");
  await waitFor(() => {
    expect(getAction("button", "Connect phone", phone)).toBeEnabled();
  });
  expect(phone).not.toHaveTextContent("+1 (314) 438-6568");

  click(getAction("button", "Connect phone", phone));
  const dialog = await screen.findByRole("dialog", {
    name: "Text Okou from your iPhone",
  });
  const copyNumber = await findAction(
    "button",
    "Copy +1 (314) 438-6568",
    dialog,
  );
  expect(copyNumber).toHaveTextContent("+1 (314) 438-6568");
  click(copyNumber);

  await expect(
    screen.findByText("Phone number copied"),
  ).resolves.toBeInTheDocument();
  expect(clipboard.writes).toStrictEqual(["+13144386568"]);
});

test("A user connects AgentPhone with a prefilled one-time code", async () => {
  let status: AgentPhoneLinkStatusResponse = {
    linked: false,
    agentPhoneNumber: "+19039853128",
    configured: true,
  };
  mockAgentPhone(() => {
    return status;
  }, "74290618");
  const clipboard = context.mocks.browser.clipboardWriteText();
  await setupIntegrationsPage(context);
  const phone = getIntegrationCard("Phone");
  await waitFor(() => {
    expect(getAction("button", "Connect phone", phone)).toBeEnabled();
  });
  await waitForRealtime("agentphone:changed");

  click(getAction("button", "Connect phone", phone));
  const dialog = await screen.findByRole("dialog", {
    name: "Text Okou from your iPhone",
  });
  const copyCode = await findAction(
    "button",
    "Copy connection code 74290618",
    dialog,
  );
  expect(copyCode).toHaveTextContent("74290618");
  expect(dialog).toHaveTextContent(
    "Scan with your camera, then send the prefilled code.",
  );
  expect(dialog).toHaveTextContent(
    "Use iMessage when possible. SMS and MMS replies may not arrive reliably.",
  );
  expect(dialog).toHaveTextContent("Expires in 10 minutes");
  expect(within(dialog).getByTestId("agentphone-link-qr")).toHaveAttribute(
    "data-sms-href",
    "sms:+19039853128?body=74290618",
  );
  expect(getAction("link", "Open Messages", dialog)).toHaveAttribute(
    "href",
    "sms:+19039853128?body=74290618",
  );
  expect(dialog).not.toHaveTextContent("+1,000");

  click(copyCode);
  await expect(
    screen.findByText("Connection code copied"),
  ).resolves.toBeInTheDocument();
  click(getAction("button", "Copy +1 (903) 985-3128", dialog));
  await expect(
    screen.findByText("Phone number copied"),
  ).resolves.toBeInTheDocument();
  expect(clipboard.writes).toStrictEqual(["74290618", "+19039853128"]);

  status = {
    linked: true,
    phoneHandle: "+15555550123",
    agentPhoneNumber: "+19039853128",
    configured: true,
  };
  context.mocks.ably.trigger("agentphone:changed");
  await waitFor(() => {
    expect(phone).toHaveTextContent("+15555550123");
  });
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
});

test("Uninstalling connected Microsoft Teams requires confirmation", async () => {
  mockTeams(context, { isInstalled: true, isConnected: true, isAdmin: true });
  await setupIntegrationsPage(context);
  const teams = getIntegrationCard("Microsoft Teams");
  await waitFor(() => {
    expect(
      getAction("button", "More Microsoft Teams options", teams),
    ).toBeEnabled();
  });

  click(getAction("button", "More Microsoft Teams options", teams));
  click(await findAction("button", "Uninstall Microsoft Teams"));

  await expect(
    screen.findByRole("dialog", {
      name: "Uninstall Microsoft Teams integration?",
    }),
  ).resolves.toBeInTheDocument();
});

test("Slack starts OAuth directly and refreshes the original Works page (installed: false)", async () => {
  let connected = false;
  context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
    return respond(200, {
      isConnected: connected,
      isInstalled: connected,
      isAdmin: true,
      installUrl: "https://slack.test/install",
      connectUrl: "https://slack.test/connect",
      reinstallUrl: null,
      scopeMismatch: false,
      workspaceName: connected ? "Verified workspace" : null,
    });
  });
  const open = context.mocks.browser.open();
  await setupIntegrationsPage(context);
  const slack = getIntegrationCard("Slack");
  await waitFor(() => {
    expect(getAction("button", "Install to Slack", slack)).toBeEnabled();
  });
  await waitForRealtime("slack:changed");

  click(getAction("button", "Install to Slack", slack));
  const opened = new URL(open.calls[0]?.url ?? "");
  expect(`${opened.origin}${opened.pathname}`).toBe(
    "https://slack.test/install",
  );
  expect(open.calls[0]?.target).toBe("_blank");
  expect(window.location.pathname).toBe("/works");

  connected = true;
  context.mocks.ably.trigger("slack:changed");
  await waitFor(() => {
    expect(slack).toHaveTextContent("Connected (Verified workspace)");
  });
  expect(window.location.pathname).toBe("/works");
});
