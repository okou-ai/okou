import {
  integrationsTelegramContract,
  type TelegramBotStatus,
  type TelegramLinkStatusResponse,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import { act, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
const BOT_ID = "8123456789";
const AUTH = Object.freeze({
  id: 99_003,
  first_name: "Ada",
  username: "ada_telegram",
  auth_date: 1_700_000_000,
  hash: "a".repeat(64),
});
const OAUTH_ORIGIN = "https://oauth.telegram.org";

function botStatus(connected = false): TelegramBotStatus {
  return {
    id: BOT_ID,
    kind: "custom",
    username: "support_bot",
    avatarUrl: null,
    agent: { id: "compose_1", name: "Support" },
    isOwner: true,
    isConnected: connected,
    connectedUser: connected
      ? {
          telegramUserId: String(AUTH.id),
          telegramUsername: AUTH.username,
          telegramDisplayName: AUTH.first_name,
        }
      : null,
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

function readyLinkStatus(): TelegramLinkStatusResponse {
  return {
    linked: false,
    installation: {
      id: BOT_ID,
      botUsername: "support_bot",
      loginBotId: BOT_ID,
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

async function openSettings(): Promise<HTMLElement> {
  await setupPage({
    context,
    locale: "en-US",
    path: "/settings/telegram",
  });
  return await waitFor(() => {
    const connect = getAction("button", "Connect");
    expect(connect).toBeEnabled();
    return connect;
  });
}

async function expectAuthorization(popup: Window): Promise<URL> {
  return await waitFor(() => {
    const url = new URL(popup.location.href);
    expect(url.origin + url.pathname).toBe(`${OAUTH_ORIGIN}/auth`);
    expect(url.searchParams.get("bot_id")).toBe(BOT_ID);
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

test("A custom bot connects from its new OAuth tab and ignores other windows and origins", async () => {
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
  const connect = await openSettings();

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
  expect(queryAction("button", "Connect")).toBeNull();
  expect(pathname()).toBe("/settings/telegram");
});

test("A blocked authorization tab shows an error and leaves Connect available", async () => {
  mockBot();
  context.mocks.browser.open(null);
  const connect = await openSettings();

  click(connect);

  await expect(
    screen.findByText("Failed to open authorization window"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(getAction("button", "Connect")).toBeEnabled();
  });
  expect(pathname()).toBe("/settings/telegram");
});

test.each([
  {
    name: "a bot whose Telegram domain is not configured",
    status: {
      linked: false,
      installation: {
        id: BOT_ID,
        botUsername: "support_bot",
        loginBotId: BOT_ID,
        domainConfigured: false,
      },
    },
    message:
      "Domain is not visible to Telegram yet. Check BotFather and try again.",
  },
  {
    name: "a bot whose installation is no longer available",
    status: { linked: false },
    message: "We couldn't connect Telegram. Try again from Telegram.",
  },
] satisfies {
  name: string;
  status: TelegramLinkStatusResponse;
  message: string;
}[])("Connect explains $name without opening a middle page", async (input) => {
  mockBot(input.status);
  const { popup } = authorizationWindow();
  const connect = await openSettings();

  click(connect);

  await expect(screen.findByText(input.message)).resolves.toBeInTheDocument();
  expect(popup.closed).toBeTruthy();
  await waitFor(() => {
    expect(getAction("button", "Connect")).toBeEnabled();
  });
  expect(pathname()).toBe("/settings/telegram");
});

test("Closing the OAuth tab cancels the attempt and restores Connect", async () => {
  mockBot();
  const { popup } = authorizationWindow();
  const connect = await openSettings();

  click(connect);
  await expectAuthorization(popup);
  expect(connect).toBeDisabled();

  popup.close();

  await waitFor(() => {
    expect(getAction("button", "Connect")).toBeEnabled();
  });
  expect(screen.queryByText("Connected to Telegram!")).not.toBeInTheDocument();
  expect(pathname()).toBe("/settings/telegram");
});

test("A failed account link can be retried from settings", async () => {
  mockBot();
  let shouldReject = true;
  context.mocks.api(integrationsTelegramContract.link, ({ respond }) => {
    if (shouldReject) {
      return respond(409, {
        error: {
          code: "CONFLICT",
          message: "This Telegram account is already connected elsewhere.",
        },
      });
    }
    context.mocks.data.telegramIntegration({ statuses: [botStatus(true)] });
    return respond(200, {
      botUsername: "support_bot",
      telegramUserId: String(AUTH.id),
    });
  });
  const { popup } = authorizationWindow();
  const connect = await openSettings();

  click(connect);
  await expectAuthorization(popup);
  authorize(popup);

  await expect(
    screen.findByText("This Telegram account is already connected elsewhere."),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(getAction("button", "Connect")).toBeEnabled();
  });

  shouldReject = false;
  popup.closed = false;
  popup.location.href = "";
  click(getAction("button", "Connect"));
  await expectAuthorization(popup);
  authorize(popup);

  await expect(
    screen.findByText("Connected (@ada_telegram)"),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe("/settings/telegram");
});

test("Leaving settings cancels authorization and ignores a later tab result", async () => {
  mockBot();
  const { popup } = authorizationWindow();
  const connect = await openSettings();

  click(connect);
  await expectAuthorization(popup);
  click(getAction("link", "Back to integrations"));

  await waitFor(() => {
    expect(getAction("link", "Open Telegram settings")).toBeInTheDocument();
  });
  expect(pathname()).toBe("/works");
  expect(popup.closed).toBeTruthy();
  authorize(popup);
  click(getAction("link", "Open Telegram settings"));

  await waitFor(() => {
    expect(getAction("button", "Connect")).toBeEnabled();
  });
  expect(pathname()).toBe("/settings/telegram");
  expect(
    screen.queryByText("Connected (@ada_telegram)"),
  ).not.toBeInTheDocument();
});
