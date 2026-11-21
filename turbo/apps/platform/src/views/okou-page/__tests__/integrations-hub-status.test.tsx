import { now } from "../../../lib/time.ts";
import { integrationsAgentPhoneContract } from "@okouai/api-contracts/contracts/integrations-agentphone";
import { screen, within, waitFor } from "@testing-library/react";
import { integrationsTelegramContract } from "@okouai/api-contracts/contracts/integrations-telegram";
import { expect, test, vi } from "vitest";
import { integrationsSlackContract } from "@okouai/api-contracts/contracts/integrations-slack";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  mockSlack,
  mockTeams,
  getIntegrationCard,
  setupIntegrationsPage,
} from "./connector-integrations-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
const context = testContext();
test("integrations-hub-status-006 the phone dialog copies its international destination", async () => {
  context.mocks.data.agentPhoneIntegration({
    linked: false,
    configured: true,
    agentPhoneNumber: "+13144386568",
  });
  context.mocks.api(
    integrationsAgentPhoneContract.createLinkCode,
    ({ respond }) => {
      return respond(200, {
        code: "53269531",
        expiresAt: new Date(now() + 600_000).toISOString(),
      });
    },
  );
  const clipboard = context.mocks.browser.clipboardWriteText();
  await setupIntegrationsPage(context);
  await screen.findByText("Phone");
  const card = getIntegrationCard("Phone");
  expect(card).toHaveTextContent("Text-message access to Okou");
  expect(card).not.toHaveTextContent("+1 (314) 438-6568");
  click(await findFastControl("button", /Connect/i, card));
  const dialog = await screen.findByRole("dialog", {
    name: "Text Okou from your iPhone",
  });
  await within(dialog).findByText("+1 (314) 438-6568");
  click(await findFastControl("button", /^Copy .*314/, dialog));
  await screen.findByText("Phone number copied");
  expect(clipboard.writes).toStrictEqual(["+13144386568"]);
});

test("integrations-hub-status-011 uninstalling the installed Teams integration asks for confirmation", async () => {
  mockTeams(context, { isInstalled: true, isConnected: false, isAdmin: true });
  await setupIntegrationsPage(context);
  await screen.findByText("Microsoft Teams");
  click(
    await findFastControl(
      "button",
      /option/i,
      getIntegrationCard("Microsoft Teams"),
    ),
  );
  click(await findFastControl("button", "Uninstall Microsoft Teams"));
  await expect(
    screen.findByRole("dialog", {
      name: "Uninstall Microsoft Teams integration?",
    }),
  ).resolves.toBeInTheDocument();
});

test("integrations-hub-status-002 Slack disconnect is reached from the installed workspace menu", async () => {
  let connected = true;
  context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
    return respond(200, {
      isConnected: connected,
      isInstalled: true,
      isAdmin: true,
      workspaceName: "Okou HQ",
      connectUrl: "https://slack.example.test/connect",
      scopeMismatch: false,
      installUrl: null,
      reinstallUrl: null,
    });
  });
  context.mocks.api(integrationsSlackContract.disconnect, ({ respond }) => {
    connected = false;
    return respond(200, { ok: true });
  });
  await setupIntegrationsPage(context);
  await screen.findByText(/Connected \(Okou HQ\)/);
  const card = getIntegrationCard("Slack");
  expect(within(card).queryByText("Disconnect")).not.toBeInTheDocument();
  click(await findFastControl("button", /option/i, card));
  await findFastControl("button", "Uninstall");
  click(await findFastControl("button", "Disconnect"));
  await findFastControl("button", /Connect/i, card);
  expect(card).not.toHaveTextContent("Connected (Okou HQ)");
  expect(location.pathname).toBe("/works");
});

test("integrations-hub-status-012 installing Slack opens its installation destination and refreshes the original card", async () => {
  const installUrl = "https://slack.example.test/workspace/install";
  const connectUrl = "https://slack.example.test/member/connect";
  mockSlack(context, { isAdmin: true, installUrl, connectUrl });
  const opened = context.mocks.browser.open(null);
  await setupIntegrationsPage(context);
  await screen.findByText("Slack");
  click(
    await findFastControl(
      "button",
      "Install to Slack",
      getIntegrationCard("Slack"),
    ),
  );
  const tab = opened.calls.find((entry) => {
    return entry.target === "_blank";
  });
  expect(tab).toBeDefined();
  const url = new URL(tab!.url!);
  expect(url.origin + url.pathname).toBe(installUrl);
  mockSlack(context, {
    isInstalled: true,
    isConnected: true,
    workspaceName: "Verified workspace",
    isAdmin: true,
    installUrl,
    connectUrl,
  });
  context.mocks.ably.trigger("slack:changed");
  await within(getIntegrationCard("Slack")).findByText(
    "Connected (Verified workspace)",
  );
  expect(location.pathname).toBe("/works");
});

test("integrations-hub-status-001 linked channels and GitHub authorization stay on the Works page", async () => {
  const github = context.mocks.data.defaultGithubIntegration({
    isConnected: false,
    connectedGithubUsername: null,
    connectedGithubUserId: null,
  });
  context.mocks.data.githubIntegration(github);
  mockSlack(context, {
    isAdmin: true,
    isInstalled: true,
    isConnected: true,
    scopeMismatch: true,
    workspaceName: "Okou HQ",
    reinstallUrl: "https://slack.example.test/update",
  });
  context.mocks.data.agentPhoneIntegration({
    linked: true,
    phoneHandle: "+15555551212",
    configured: true,
    agentPhoneNumber: "+19039853128",
  });
  const popup = context.mocks.browser.authWindow();
  Object.defineProperty(popup, "location", { value: { href: "about:blank" } });
  const opened = context.mocks.browser.open(popup);
  await setupIntegrationsPage(context);
  await screen.findByText("Connected (Okou HQ)");
  expect(getIntegrationCard("Slack")).toHaveTextContent(/update permissions/i);
  expect(getIntegrationCard("Phone")).toHaveTextContent("+15555551212");
  await findFastControl("button", "Connect", getIntegrationCard("Discord"));
  expect(screen.queryByText("Feishu")).not.toBeInTheDocument();
  click(
    await findFastControl("button", "Connect", getIntegrationCard("GitHub")),
  );
  const tab = opened.calls.find((call) => {
    return call.target === "_blank";
  });
  expect(tab).toBeDefined();
  const authorization = new URL(popup.location.href);
  expect(authorization.origin + authorization.pathname).toBe(
    "https://github.com/login/oauth/authorize",
  );
  context.mocks.data.githubIntegration(
    context.mocks.data.defaultGithubIntegration(),
  );
  context.mocks.ably.trigger("github:changed");
  await within(getIntegrationCard("GitHub")).findByText("Connected (@octocat)");
});

test("integrations-hub-status-005 Telegram accepts Alice through the official bot authorization tab", async () => {
  const id = "official";
  const username = "office_bot";
  context.mocks.data.telegramIntegration({
    statuses: [
      {
        id,
        username,
        avatarUrl: null,
        agent: null,
        isOwner: true,
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
      },
    ],
    linkStatus: {
      linked: false,
      installation: {
        id,
        botUsername: username,
        loginBotId: "987654321",
        domainConfigured: true,
      },
    },
  });
  context.mocks.api(
    integrationsTelegramContract.getLinkStatus,
    ({ respond }) => {
      return respond(200, {
        linked: false,
        installation: {
          id,
          botUsername: username,
          loginBotId: "987654321",
          domainConfigured: true,
        },
      });
    },
  );
  const popup = context.mocks.browser.authWindow();
  Object.defineProperty(popup, "location", { value: { href: "about:blank" } });
  const delivery = vi.spyOn(popup, "postMessage");
  const opened = context.mocks.browser.open(popup);
  await setupIntegrationsPage(context);
  await screen.findByText("Telegram");
  click(
    await findFastControl("button", "Connect", getIntegrationCard("Telegram")),
  );
  await waitFor(() => {
    return expect(popup.location.href).toContain(
      "https://oauth.telegram.org/auth?",
    );
  });
  expect(new URL(popup.location.href).searchParams.get("bot_id")).toBe(
    "987654321",
  );
  expect(opened.calls[0]?.target).toBe("_blank");
  const callback = new URL(
    new URL(popup.location.href).searchParams.get("return_to")!,
  );
  const envelope = {
    protocol: 2,
    operationId: callback.searchParams.get("operationId"),
    bot: callback.searchParams.get("bot"),
  };
  const source = { origin: callback.origin, source: popup };
  context.mocks.browser.message(
    { ...envelope, type: "telegram-auth-bridge-ready" },
    source,
  );
  context.mocks.browser.message(
    {
      ...envelope,
      type: "telegram-auth",
      data: {
        id: 1234,
        first_name: "Alice",
        username: "alice",
        auth_date: 123_456,
        hash: "c".repeat(64),
      },
    },
    source,
  );
  await waitFor(() => {
    return expect(delivery).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "telegram-auth-result",
        status: "linked",
      }),
      callback.origin,
    );
  });
  context.mocks.browser.message(
    { ...envelope, type: "telegram-auth-ack", stage: "result" },
    source,
  );
  await within(getIntegrationCard("Telegram")).findByText("Connected (@alice)");
  expect(
    within(getIntegrationCard("Telegram")).queryByText("Connect"),
  ).not.toBeInTheDocument();
  expect(location.pathname).toBe("/works");
});

test("integrations-hub-status-007 the prefilled Messages link and QR lead to the phone that becomes linked", async () => {
  const number = "+19039853128";
  const code = "74290618";
  context.mocks.data.agentPhoneIntegration({
    linked: false,
    agentPhoneNumber: number,
    configured: true,
  });
  context.mocks.api(
    integrationsAgentPhoneContract.createLinkCode,
    ({ respond }) => {
      return respond(200, {
        code,
        expiresAt: new Date(now() + 600_000).toISOString(),
      });
    },
  );
  const clipboard = context.mocks.browser.clipboardWriteText();
  await setupIntegrationsPage(context);
  await screen.findByText("Phone");
  click(
    await findFastControl("button", "Connect", getIntegrationCard("Phone")),
  );
  const dialog = await screen.findByRole("dialog");
  const body = within(dialog);
  await body.findByText(code);
  for (const copy of [
    "Scan with your camera, then send the prefilled code.",
    "Use iMessage when possible. SMS and MMS replies may not arrive reliably.",
    "Expires in 10 minutes",
    "+1 (903) 985-3128",
  ]) {
    expect(dialog).toHaveTextContent(copy);
  }
  const href = "sms:" + number + "?body=" + code;
  expect(
    body.getByLabelText("Scan to open Messages with the connection code ready"),
  ).toHaveAttribute("data-sms-href", href);
  expect(body.getByText("Open Messages").closest("a")).toHaveAttribute(
    "href",
    href,
  );
  expect(dialog).not.toHaveTextContent("+1,000");
  click(await findFastControl("button", /Copy connection code/, dialog));
  await screen.findByText("Connection code copied");
  click(await findFastControl("button", /Copy .*903/, dialog));
  await screen.findByText("Phone number copied");
  expect(clipboard.writes).toStrictEqual([code, number]);
  context.mocks.data.agentPhoneIntegration({
    linked: true,
    configured: true,
    phoneHandle: "+15555550123",
    agentPhoneNumber: number,
  });
  context.mocks.ably.trigger("agentphone:changed");
  await within(getIntegrationCard("Phone")).findByText(/15555550123/);
  expect(dialog).not.toBeInTheDocument();
});
