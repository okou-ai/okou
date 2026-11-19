import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { feishuOauthContract } from "@okouai/api-contracts/contracts/feishu-oauth";
import { integrationsSlackContract } from "@okouai/api-contracts/contracts/integrations-slack";
import {
  integrationsTelegramContract,
  type TelegramLinkStatusResponse,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import {
  type SlackConnectLinkStatus,
  slackConnectContract,
} from "@okouai/api-contracts/contracts/slack-connect";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getConnectorAction,
  publicStatusItem,
  queryConnectorAction,
} from "./connector-page-test-helpers.ts";

const context = testContext();

function slackLink(): Record<string, string> {
  return { w: "T_WORKSPACE", u: "U_MEMBER", c: "C_ORIGIN", t: "42.0" };
}

const AUTHORIZATION_URL =
  "https://slack.com/oauth/v2/authorize?client_id=okou&state=slack-user-oauth";

function slackConnectPath(params: Record<string, string>): string {
  return `/settings/slack?${new URLSearchParams(params).toString()}`;
}

function mockSlackLinkStatus(linkStatus: SlackConnectLinkStatus): void {
  context.mocks.api(slackConnectContract.getLinkStatus, ({ respond }) => {
    return respond(200, {
      isConnected: linkStatus.kind === "connected",
      isAdmin: false,
      linkStatus,
    });
  });
}

async function findAction(
  role: "button" | "link",
  name: string,
): Promise<HTMLElement> {
  return await waitFor(() => {
    return getConnectorAction(role, name);
  });
}

test("A connected Slack workspace shows success and next actions", async () => {
  context.mocks.browser.locationAssign();
  context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
    return respond(200, {
      isConnected: true,
      isInstalled: true,
      workspaceName: "Acme Workspace",
      isAdmin: true,
    });
  });

  await setupPage({ context, path: "/settings/slack" });

  await expect(
    screen.findByRole("heading", { name: "Slack is connected" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText(
      "You're connected to Acme Workspace. Mention the installed bot in any channel or send a DM to start chatting.",
    ),
  ).toBeInTheDocument();
  expect(getConnectorAction("link", "Open Slack")).toHaveAttribute(
    "href",
    "slack://open",
  );
  expect(getConnectorAction("link", "Back to settings")).toHaveAttribute(
    "href",
    "/works",
  );
});

test("Slack Connect continues to user OAuth before opening Slack", async () => {
  mockSlackLinkStatus({ kind: "connect" });
  const starts: unknown[] = [];
  context.mocks.api(slackConnectContract.connect, ({ body, respond }) => {
    starts.push(body);
    return respond(202, { authorizationUrl: AUTHORIZATION_URL });
  });

  await setupPage({ context, path: slackConnectPath(slackLink()) });
  click(await findAction("button", "Connect"));

  await waitFor(() => {
    expect(window.location.href).toBe(AUTHORIZATION_URL);
  });
  expect(starts).toStrictEqual([
    {
      workspaceId: "T_WORKSPACE",
      slackUserId: "U_MEMBER",
      channelId: "C_ORIGIN",
      threadTs: "42.0",
      requestUserScopes: true,
    },
  ]);
});

test("Slack Connect fails closed when link status cannot be checked", async () => {
  context.mocks.api(slackConnectContract.getLinkStatus, ({ respond }) => {
    return respond(401, {
      error: {
        code: "UNAUTHORIZED",
        message: "Slack link status is unavailable.",
      },
    });
  });

  await setupPage({ context, path: slackConnectPath(slackLink()) });

  await expect(
    screen.findByText("Slack link status is unavailable."),
  ).resolves.toBeInTheDocument();
  expect(queryConnectorAction("button", "Connect")).not.toBeInTheDocument();
});

test("Slack Connect renders an API error when OAuth cannot start", async () => {
  mockSlackLinkStatus({ kind: "connect" });
  context.mocks.api(slackConnectContract.connect, ({ respond }) => {
    return respond(403, {
      error: {
        code: "FORBIDDEN",
        message: "Only admins can connect this Slack workspace.",
      },
    });
  });

  await setupPage({ context, path: slackConnectPath(slackLink()) });
  click(await findAction("button", "Connect"));

  await expect(
    screen.findByText("Only admins can connect this Slack workspace."),
  ).resolves.toBeInTheDocument();
});

test("Slack Connect offers an OAuth-verified account switch", async () => {
  mockSlackLinkStatus({
    kind: "slack_account_mismatch",
    currentSlackUserId: "U_CURRENT_ACCOUNT",
    requestedSlackUserId: "U_NEW_ACCOUNT",
  });
  const switches: unknown[] = [];
  context.mocks.api(slackConnectContract.switchAccount, ({ body, respond }) => {
    switches.push(body);
    return respond(202, { authorizationUrl: AUTHORIZATION_URL });
  });

  await setupPage({
    context,
    path: slackConnectPath({ w: "T_WORKSPACE", u: "U_NEW_ACCOUNT" }),
  });
  const switchAccount = await findAction("button", "Switch to U_NEW_ACCOUNT");
  expect(getConnectorAction("link", "Keep U_CURRENT_ACCOUNT")).toHaveAttribute(
    "href",
    "/works",
  );
  click(switchAccount);

  await waitFor(() => {
    expect(window.location.href).toBe(AUTHORIZATION_URL);
  });
  expect(switches).toStrictEqual([
    {
      workspaceId: "T_WORKSPACE",
      slackUserId: "U_NEW_ACCOUNT",
      requestUserScopes: true,
    },
  ]);
});

test("A user links their account to the official Telegram bot at /telegram/connect", async () => {
  let linkStatus: TelegramLinkStatusResponse = {
    linked: false,
    installation: { id: "telegram-official", botUsername: "agent_bot" },
  };
  const links: unknown[] = [];
  context.mocks.api(integrationsTelegramContract.list, ({ respond }) => {
    return respond(200, { bots: [] });
  });
  context.mocks.api(
    integrationsTelegramContract.getLinkStatus,
    ({ respond }) => {
      return respond(200, linkStatus);
    },
  );
  context.mocks.api(integrationsTelegramContract.link, ({ body, respond }) => {
    links.push(body);
    linkStatus = {
      linked: true,
      telegramUserId: "42",
      botUsername: "agent_bot",
    };
    return respond(200, { telegramUserId: "42", botUsername: "agent_bot" });
  });
  const signature = "a".repeat(64);

  await setupPage({
    context,
    path: `/telegram/connect?${new URLSearchParams({
      bot: "official",
      tgUser: "42",
      ts: "1784880000",
      sig: signature,
    }).toString()}`,
  });
  click(await findAction("button", "Connect"));

  await expect(
    screen.findByRole("heading", { name: "Connected to Telegram!" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText("Send the bot a message in Telegram to start chatting."),
  ).toBeInTheDocument();
  const openTelegram = getConnectorAction("link", "Open Telegram");
  expect(openTelegram).toHaveAttribute("href", "https://t.me/agent_bot");
  expect(openTelegram).toHaveAttribute("target", "_blank");
  expect(getConnectorAction("link", "Back to settings")).toHaveAttribute(
    "href",
    "/works",
  );
  const search = new URLSearchParams(window.location.search);
  expect(search.get("sig")).toBeNull();
  expect(search.get("tgUser")).toBeNull();
  expect(search.get("ts")).toBeNull();
  expect(links).toStrictEqual([
    {
      telegramBotId: "official",
      connectSignature: {
        telegramUserId: "42",
        timestamp: 1_784_880_000,
        signature,
      },
    },
  ]);
});

test("A successful Feishu callback opens the connected bot", async () => {
  const navigation = context.mocks.browser.locationAssign();
  const catalogReads: string[] = [];
  let catalogStatusReads = 0;
  context.mocks.api(connectorCatalogContract.get, ({ params, respond }) => {
    catalogReads.push(params.connectorSlug);
    return respond(200, {
      connector: publicStatusItem({
        connectorSlug: "lark",
        label: "Feishu",
        icon: {
          url: "https://icons.example.test/feishu.svg",
          invertInDarkMode: false,
        },
      }),
    });
  });
  context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
    catalogStatusReads += 1;
    return respond(200, { connectors: [] });
  });
  const callbacks: unknown[] = [];
  const botUrl = "https://applink.feishu.cn/client/bot/open?appId=cli_okou";
  context.mocks.api(feishuOauthContract.callback, ({ query, respond }) => {
    callbacks.push(query);
    return respond(200, { redirectUrl: botUrl });
  });

  await setupPage({
    context,
    path: "/connectors/feishu/callback?code=oauth-code&state=oauth-state",
    auth: null,
  });

  await expect(
    screen.findByRole("heading", { name: "Connecting Feishu…" }),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(navigation.calls).toStrictEqual([botUrl]);
  });
  await waitFor(() => {
    expect(
      document.querySelector(
        'img[src="https://icons.example.test/feishu.svg"]',
      ),
    ).toBeInTheDocument();
  });
  expect(callbacks).toStrictEqual([
    { code: "oauth-code", state: "oauth-state", responseMode: "json" },
  ]);
  expect(catalogReads).toStrictEqual(["lark"]);
  expect(catalogStatusReads).toBe(0);
});
