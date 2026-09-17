import {
  connectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import { feishuOauthContract } from "@okouai/api-contracts/contracts/feishu-oauth";
import { integrationsGithubContract } from "@okouai/api-contracts/contracts/integrations-github";
import {
  integrationsTelegramContract,
  type TelegramBotStatus,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import { slackConnectContract } from "@okouai/api-contracts/contracts/slack-connect";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const TELEGRAM_BOT_ID = "bot_connect_test";
const FEISHU_ICON_URL = "https://icons.example.test/lark.svg";

function getAction(role: "button" | "link", name: string): HTMLElement {
  const action = queryAllByRoleFast(role).find((candidate) => {
    return (
      candidate.textContent?.replace(/\s+/gu, " ").trim() === name ||
      candidate.getAttribute("aria-label") === name
    );
  });
  if (!action) {
    throw new Error(`Expected ${role} named "${name}"`);
  }
  return action;
}

function githubConnectPath(): string {
  const params = new URLSearchParams({
    installation: "123456",
    ghUser: "24680",
    ghLogin: "octo-dev",
    ts: "1700000000",
    sig: "a".repeat(64),
  });
  return `/github/connect?${params.toString()}`;
}

function telegramStatus(): TelegramBotStatus {
  return {
    id: TELEGRAM_BOT_ID,
    username: "agent_bot",
    avatarUrl: null,
    agent: { id: "c0000000-0000-4000-a000-000000000001", name: "zero" },
    isOwner: true,
    isConnected: false,
    connectedUser: null,
    tokenStatus: "valid",
    domainConfigured: true,
    environment: {
      requiredSecrets: [],
      requiredVars: [],
      missingSecrets: [],
      missingVars: [],
    },
  };
}

function telegramConnectPath(signature = "b".repeat(64)): string {
  const params = new URLSearchParams({
    bot: TELEGRAM_BOT_ID,
    tgUser: "99001",
    tgUserName: "alice",
    tgDisplayName: "Alice Tester",
    ts: "1700000000",
    sig: signature,
  });
  return `/telegram/connect?${params.toString()}`;
}

function telegramLoginConnectPath(): string {
  const params = new URLSearchParams({ bot: TELEGRAM_BOT_ID });
  return `/telegram/connect?${params.toString()}`;
}

function feishuConnectorStatus(): PublicConnectorCatalogStatusItem {
  return {
    slug: "lark",
    label: "Feishu",
    description: "Connect Feishu to Okou.",
    icon: { url: FEISHU_ICON_URL, invertInDarkMode: false },
    category: "communication",
    generation: [],
    tags: [],
    authMethods: [],
    permissionSummary: {
      hasPermissions: false,
      permissionCount: 0,
      hasCategories: false,
      hasDefaultPolicyOverrides: false,
    },
    connection: null,
    connected: false,
    connectionStatus: "not-connected",
    scopeMismatch: false,
    authMethodSupportsRefresh: false,
    tokenExpiresAt: null,
    singleAuthCodeAuthMethodId: null,
    connectNotice: null,
  };
}

test("A user links GitHub for agent mentions", async () => {
  let linkBody: unknown;
  context.mocks.data.githubIntegration(
    context.mocks.data.defaultGithubIntegration({
      isConnected: false,
      connectedGithubUserId: null,
      connectedGithubUsername: null,
    }),
  );
  context.mocks.api(
    integrationsGithubContract.connectUser,
    ({ body, respond }) => {
      linkBody = body;
      return respond(200, { ok: true });
    },
  );

  await setupPage({ context, path: githubConnectPath() });

  await expect(
    screen.findByText("Connect to GitHub"),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText(
      "Link your Okou account to @octo-dev so GitHub mentions can run your agents from issues and pull requests.",
    ),
  ).toBeInTheDocument();

  click(getAction("button", "Connect"));

  await expect(
    screen.findByText("Connected to GitHub!"),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText(
      "You're connected as @octo-dev. Mention your agent in GitHub issues or pull requests to start chatting.",
    ),
  ).toBeInTheDocument();
  expect(getAction("link", "Back to workflows")).toBeInTheDocument();
  expect(linkBody).toStrictEqual({
    connectSignature: {
      installationId: "123456",
      githubUserId: "24680",
      githubUsername: "octo-dev",
      timestamp: 1_700_000_000,
      signature: "a".repeat(64),
    },
  });
});

test("A connected Slack workspace shows success and next actions", async () => {
  context.mocks.api(slackConnectContract.getStatus, ({ respond }) => {
    return respond(200, {
      isConnected: true,
      isAdmin: false,
      workspaceName: "Acme Workspace",
    });
  });
  const params = new URLSearchParams({
    w: "T123456",
    u: "U987654",
    workspace: "Acme Workspace",
  });

  await setupPage({ context, path: `/settings/slack?${params.toString()}` });

  await expect(
    screen.findByText("Connected to Slack!"),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText(/You're connected to Acme Workspace/u),
  ).toBeInTheDocument();
  expect(getAction("button", "Open Slack")).toBeInTheDocument();
  expect(getAction("link", "Back to settings")).toBeInTheDocument();
});

test("Slack Connect continues to user OAuth before opening Slack", async () => {
  const authorizationUrl =
    "https://api.okou.ai/api/slack/oauth/connect?connectorState=signed-entry";
  let submitted: unknown;
  context.mocks.api(slackConnectContract.getStatus, ({ respond }) => {
    return respond(200, { isConnected: false, isAdmin: false });
  });
  context.mocks.api(slackConnectContract.connect, ({ body, respond }) => {
    submitted = body;
    return respond(202, { authorizationUrl });
  });
  await setupPage({
    context,
    path: "/settings/slack?w=T_WORKSPACE&u=U_MEMBER&c=C_ORIGIN&t=42.0",
  });
  await expect(screen.findByText("Connect to Slack")).resolves.toBeVisible();
  const connect = getAction("button", "Connect");
  expect(connect).toBeEnabled();
  click(connect);
  await waitFor(() => {
    expect(window.location.href).toBe(authorizationUrl);
  });
  expect(submitted).toStrictEqual({
    workspaceId: "T_WORKSPACE",
    slackUserId: "U_MEMBER",
    channelId: "C_ORIGIN",
    threadTs: "42.0",
    requestUserScopes: true,
  });
});

test("An invalid Telegram connection link is rejected", async () => {
  await setupPage({ context, path: telegramConnectPath("invalid") });

  await expect(
    screen.findByRole("heading", { name: "Connect link is invalid" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText("The signature on this link is not valid."),
  ).toBeInTheDocument();
  expect(
    queryAllByRoleFast("button").some((candidate) => {
      return candidate.textContent?.trim() === "Connect";
    }),
  ).toBeFalsy();
});

test("Telegram login continues after bot domain configuration", async () => {
  let domainConfigured = false;
  context.mocks.api(
    integrationsTelegramContract.getLinkStatus,
    ({ respond }) => {
      return respond(200, {
        linked: false,
        installation: {
          id: TELEGRAM_BOT_ID,
          botUsername: "agent_bot",
          domainConfigured,
        },
      });
    },
  );

  await setupPage({ context, path: telegramLoginConnectPath() });

  await expect(
    screen.findByRole("heading", { name: "Set Telegram login domain" }),
  ).resolves.toBeInTheDocument();

  domainConfigured = true;

  await expect(
    screen.findByRole("heading", { name: "Connect to Telegram" }),
  ).resolves.toBeInTheDocument();
});

test("A user links their account to a Telegram bot", async () => {
  let linkedBody: unknown;
  context.mocks.data.telegramIntegration({ statuses: [telegramStatus()] });
  context.mocks.api(integrationsTelegramContract.link, ({ body, respond }) => {
    linkedBody = body;
    return respond(200, {
      botUsername: "agent_bot",
      telegramUserId: "99001",
    });
  });
  const locationAssign = context.mocks.browser.locationAssign();

  await setupPage({ context, path: telegramConnectPath() });

  await expect(
    screen.findByText("Connect to Telegram"),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText(
      "Link your account to this Telegram bot so you can interact with your agent directly from Telegram.",
    ),
  ).toBeInTheDocument();

  click(getAction("button", "Connect"));

  await expect(
    screen.findByText("Connected to Telegram!"),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText(
      "You're connected to @agent_bot. Send a message in Telegram to start chatting.",
    ),
  ).toBeInTheDocument();
  expect(getAction("button", "Open Telegram")).toBeInTheDocument();
  expect(getAction("link", "Back to Telegram settings")).toBeInTheDocument();
  expect(locationAssign.calls).toStrictEqual(["tg://resolve?domain=agent_bot"]);
  expect(linkedBody).toStrictEqual({
    telegramBotId: TELEGRAM_BOT_ID,
    connectSignature: {
      telegramUserId: "99001",
      telegramUsername: "alice",
      telegramDisplayName: "Alice Tester",
      timestamp: 1_700_000_000,
      signature: "b".repeat(64),
    },
  });
});

test("A successful Feishu callback opens the connected bot", async () => {
  const redirectUrl =
    "https://applink.feishu.cn/client/bot/open?appId=cli_test";
  const locationAssign = context.mocks.browser.locationAssign();
  let callbackQuery: unknown;
  context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
    return respond(200, { connectors: [feishuConnectorStatus()] });
  });
  context.mocks.api(feishuOauthContract.callback, ({ query, respond }) => {
    callbackQuery = query;
    return respond(200, { redirectUrl });
  });

  await setupPage({
    context,
    path: "/connectors/feishu/callback?code=oauth-code&state=oauth-state",
    auth: null,
  });

  const heading = await screen.findByRole("heading", {
    name: "Connecting Feishu…",
  });
  expect(heading).toBeInTheDocument();
  const image = document.querySelector<HTMLImageElement>(
    `img[src="${FEISHU_ICON_URL}"]`,
  );
  expect(image).toHaveAttribute("src", FEISHU_ICON_URL);
  await waitFor(() => {
    expect(locationAssign.calls).toStrictEqual([redirectUrl]);
  });
  expect(callbackQuery).toStrictEqual({
    code: "oauth-code",
    responseMode: "json",
    state: "oauth-state",
  });
});
