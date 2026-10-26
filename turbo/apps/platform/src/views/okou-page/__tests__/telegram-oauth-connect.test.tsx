import {
  integrationsTelegramContract,
  OFFICIAL_TELEGRAM_BOT_ID,
  type TelegramLinkStatusResponse,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import { act, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { MockTelegramBotStatus } from "../../../mocks/handlers/api-integrations-telegram.ts";
import {
  getAction,
  getIntegrationCard,
  queryAction,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
const BOT_ID = OFFICIAL_TELEGRAM_BOT_ID;
const LOGIN_BOT_ID = "123456789";
const AUTH = Object.freeze({
  id: 99_003,
  first_name: "Ada",
  username: "ada_telegram",
  auth_date: 1_700_000_000,
  hash: "a".repeat(64),
});
const OAUTH_ORIGIN = "https://oauth.telegram.org";

function botStatus(connected = false): MockTelegramBotStatus {
  return {
    id: BOT_ID,
    kind: "official",
    username: "support_bot",
    avatarUrl: null,
    agent: { id: "compose_1", name: "Support" },
    isOwner: false,
    isConnected: connected,
    connectedUser: connected
      ? {
          telegramUserId: String(AUTH.id),
          telegramUsername: AUTH.username,
          telegramDisplayName: AUTH.first_name,
        }
      : null,
    tokenStatus: "valid",
    official: {
      configured: true,
      usesDefaultAgent: true,
      linkedTelegramUserId: connected ? String(AUTH.id) : null,
    },
    domainConfigured: true,
    environment: {
      requiredSecrets: [],
      requiredVars: [],
      missingSecrets: [],
      missingVars: [],
    },
  };
}

function readyLinkStatus(): TelegramLinkStatusResponse {
  return {
    linked: false,
    installation: {
      id: BOT_ID,
      botUsername: "support_bot",
      loginBotId: LOGIN_BOT_ID,
      domainConfigured: true,
    },
  };
}

function mockBot(status: TelegramLinkStatusResponse = readyLinkStatus()): void {
  context.mocks.data.telegramIntegration({ statuses: [botStatus()] });
  context.mocks.api(
    integrationsTelegramContract.getLinkStatus,
    ({ respond }) => {
      return respond(200, status);
    },
  );
}

function authorizationWindow() {
  const popup = context.mocks.browser.authWindow();
  Object.defineProperty(popup, "location", {
    configurable: true,
    value: { href: "" },
  });
  const opened = context.mocks.browser.open(popup);
  return { popup, opened };
}

async function openWorks(): Promise<HTMLElement> {
  await setupPage({
    context,
    locale: "en-US",
    path: "/works",
  });
  return await waitFor(() => {
    const connect = getAction(
      "button",
      "Connect",
      getIntegrationCard("Telegram"),
    );
    expect(connect).toBeEnabled();
    return connect;
  });
}

async function expectAuthorization(popup: Window): Promise<URL> {
  return await waitFor(() => {
    const url = new URL(popup.location.href);
    expect(url.origin + url.pathname).toBe(`${OAUTH_ORIGIN}/auth`);
    expect(url.searchParams.get("bot_id")).toBe(LOGIN_BOT_ID);
    return url;
  });
}

function authorize(popup: Window): void {
  act(() => {
    context.mocks.browser.message(
      { event: "auth_result", result: AUTH },
      { source: popup, origin: OAUTH_ORIGIN },
    );
  });
}

test("Works refreshes Telegram connections in realtime and disconnects the displayed account", async () => {
  mockBot();
  await openWorks();

  context.mocks.data.telegramIntegration({ statuses: [botStatus(true)] });
  context.mocks.ably.trigger("telegram:changed");

  await expect(
    screen.findByText("Connected (@ada_telegram)"),
  ).resolves.toBeInTheDocument();
  const card = getIntegrationCard("Telegram");
  expect(queryAction("button", "Connect", card)).toBeNull();
  click(getAction("button", "More options", card));
  const disconnect = await waitFor(() => {
    return getAction("button", "Disconnect");
  });
  click(disconnect);

  await expect(
    screen.findByText("Telegram account disconnected"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(getAction("button", "Connect", card)).toBeEnabled();
  });
  expect(
    screen.queryByText("Connected (@ada_telegram)"),
  ).not.toBeInTheDocument();
  expect(pathname()).toBe("/works");
});

test("Works disables Telegram Connect when the official bot is not configured", async () => {
  context.mocks.data.telegramIntegration({
    statuses: [
      {
        ...botStatus(),
        official: {
          configured: false,
          usesDefaultAgent: true,
          linkedTelegramUserId: null,
        },
      },
    ],
  });

  await setupPage({ context, path: "/works" });

  await expect(
    screen.findByText("Official bot configuration is missing."),
  ).resolves.toBeInTheDocument();
  expect(
    getAction("button", "Connect", getIntegrationCard("Telegram")),
  ).toBeDisabled();
  expect(getIntegrationCard("Slack")).toBeInTheDocument();
});

test("The official bot connects from its new OAuth tab and ignores other windows and origins", async () => {
  mockBot();
  context.mocks.api(integrationsTelegramContract.link, ({ body, respond }) => {
    expect(body).toStrictEqual({ telegramBotId: BOT_ID, telegramAuth: AUTH });
    context.mocks.data.telegramIntegration({ statuses: [botStatus(true)] });
    return respond(200, {
      botUsername: "support_bot",
      telegramUserId: String(AUTH.id),
    });
  });
  const { popup, opened } = authorizationWindow();
  const unrelatedWindow = context.mocks.browser.authWindow();
  const connect = await openWorks();

  click(connect);

  expect(opened.calls).toStrictEqual([
    { url: "about:blank", target: "_blank", features: null },
  ]);
  const authUrl = await expectAuthorization(popup);
  expect(authUrl.searchParams.get("origin")).toBe(window.location.origin);
  expect(authUrl.searchParams.get("request_access")).toBe("write");
  const callbackUrl = new URL(authUrl.searchParams.get("return_to") ?? "");
  expect(callbackUrl.pathname).toBe("/api/integrations/telegram/auth-callback");
  expect(callbackUrl.searchParams.get("targetOrigin")).toBe(
    window.location.origin,
  );

  act(() => {
    const unsolicited = {
      event: "auth_result",
      result: { ...AUTH, id: 99_004, username: "other_account" },
    };
    context.mocks.browser.message(unsolicited, {
      source: unrelatedWindow,
      origin: OAUTH_ORIGIN,
    });
    context.mocks.browser.message(unsolicited, {
      source: popup,
      origin: "https://untrusted.example",
    });
  });
  authorize(popup);

  await expect(
    screen.findByText("Connected (@ada_telegram)"),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText("Connected to Telegram!")).toBeInTheDocument();
  expect(
    queryAction("button", "Connect", getIntegrationCard("Telegram")),
  ).toBeNull();
  expect(pathname()).toBe("/works");
});

test("A blocked authorization tab shows an error and leaves Connect available", async () => {
  mockBot();
  context.mocks.browser.open(null);
  const connect = await openWorks();

  click(connect);

  await expect(
    screen.findByText("Failed to open authorization window"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(
      getAction("button", "Connect", getIntegrationCard("Telegram")),
    ).toBeEnabled();
  });
  expect(pathname()).toBe("/works");
});

test.each([
  {
    name: "an unverified domain reported by an older API",
    status: {
      linked: false,
      installation: {
        id: BOT_ID,
        botUsername: "support_bot",
        loginBotId: LOGIN_BOT_ID,
        domainConfigured: false,
      },
    },
    message:
      "We couldn't verify Telegram login for this app. Contact support if the problem continues.",
  },
  {
    name: "a bot whose installation is no longer available",
    status: { linked: false },
    message:
      "Telegram connection is not configured yet. Please contact support.",
  },
  {
    name: "a missing bot configuration",
    status: { linked: false, readinessError: "bot_not_configured" },
    message:
      "Telegram connection is not configured yet. Please contact support.",
  },
  {
    name: "an unsuccessful Telegram domain verification",
    status: {
      linked: false,
      readinessError: "domain_not_verified",
      installation: {
        id: BOT_ID,
        botUsername: "support_bot",
        loginBotId: LOGIN_BOT_ID,
        domainConfigured: false,
      },
    },
    message:
      "We couldn't verify Telegram login for this app. Contact support if the problem continues.",
  },
  {
    name: "an unreachable Telegram authorization service",
    status: {
      linked: false,
      readinessError: "domain_check_failed",
      installation: {
        id: BOT_ID,
        botUsername: "support_bot",
        loginBotId: LOGIN_BOT_ID,
        domainConfigured: false,
      },
    },
    message: "We couldn't reach Telegram to check the connection.",
  },
] satisfies {
  name: string;
  status: TelegramLinkStatusResponse;
  message: string;
}[])("Connect explains $name without opening a middle page", async (input) => {
  const sentry = context.mocks.sentry();
  mockBot(input.status);
  const { popup } = authorizationWindow();
  const connect = await openWorks();

  click(connect);

  await expect(screen.findByText(input.message)).resolves.toBeInTheDocument();
  expect(popup.closed).toBeTruthy();
  await waitFor(() => {
    expect(
      getAction("button", "Connect", getIntegrationCard("Telegram")),
    ).toBeEnabled();
  });
  expect(pathname()).toBe("/works");
  expect(sentry.reports).toStrictEqual([]);
});

test.each(["/telegram/connect", "/settings/telegram"])(
  "The official connect page at %s reports unavailable login configuration",
  async (path) => {
    mockBot({
      linked: false,
      installation: {
        id: BOT_ID,
        botUsername: "support_bot",
        loginBotId: LOGIN_BOT_ID,
        domainConfigured: false,
      },
    });

    await setupPage({
      context,
      locale: "en-US",
      path: `${path}?bot=${BOT_ID}`,
    });

    await expect(
      screen.findByRole("heading", { name: "Connection failed" }),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByText(
        "We couldn't verify Telegram login for this app. Contact support if the problem continues.",
      ),
    ).toBeInTheDocument();
    expect(getAction("link", "Back to settings")).toHaveAttribute(
      "href",
      "/works",
    );
    expect(queryAction("button", "Continue with Telegram")).toBeNull();
  },
);

test("Closing the OAuth tab cancels the attempt and restores Connect", async () => {
  mockBot();
  const { popup } = authorizationWindow();
  const connect = await openWorks();

  click(connect);
  await expectAuthorization(popup);
  expect(connect).toBeDisabled();

  popup.close();

  await waitFor(() => {
    expect(
      getAction("button", "Connect", getIntegrationCard("Telegram")),
    ).toBeEnabled();
  });
  expect(screen.queryByText("Connected to Telegram!")).not.toBeInTheDocument();
  expect(pathname()).toBe("/works");
});

test("Leaving Works cancels authorization and ignores a later tab result", async () => {
  mockBot();
  const { popup } = authorizationWindow();
  const connect = await openWorks();

  click(connect);
  await expectAuthorization(popup);
  click(getAction("link", "Agents"));

  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe("/agents");
  expect({ value: popup.closed }).toStrictEqual({ value: false });
  authorize(popup);
  act(() => {
    window.history.back();
  });

  await waitFor(() => {
    expect(
      getAction("button", "Connect", getIntegrationCard("Telegram")),
    ).toBeEnabled();
  });
  expect(pathname()).toBe("/works");
  expect(
    screen.queryByText("Connected (@ada_telegram)"),
  ).not.toBeInTheDocument();
});

test("Works refreshes after the Telegram subscription attaches past its first status read", async () => {
  mockBot();
  const gate = context.mocks.ably.deferSubscribeOnChannel(
    "user:test-user-123",
    "telegram:changed",
  );
  await setupPage({
    context,
    path: "/works",
    sharedWorkerTestTransport: "message-port",
  });
  await gate.started;
  await waitFor(() => {
    expect(
      getAction("button", "Connect", getIntegrationCard("Telegram")),
    ).toBeEnabled();
  });
  context.mocks.data.telegramIntegration({ statuses: [botStatus(true)] });
  gate.attach();
  await expect(
    screen.findByText("Connected (@ada_telegram)"),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe("/works");
});
