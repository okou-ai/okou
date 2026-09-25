import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";
import { integrationsTelegramContract } from "@okouai/api-contracts/contracts/integrations-telegram";
import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";
import { getAction } from "./connector-integrations-test-helpers.ts";

const context = testContext();
const PRIMARY_AGENT_ID = "c0000000-0000-4000-a000-000000000001";

function agent(agentId: string, displayName: string | null): AgentResponse {
  return {
    isDefaultAgent: false,
    agentId,
    ownerId: "user_mock",
    displayName,
    description: null,
    sound: null,
    avatarUrl: null,
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
    visibility: "private",
  };
}

test("An admin can retry failed registration and connect a new Telegram bot", async () => {
  const authTab = context.mocks.browser.authWindow();
  Object.defineProperty(authTab, "location", {
    configurable: true,
    value: { href: "" },
  });
  const opened = context.mocks.browser.open(authTab);
  const auth = { id: 99_002, auth_date: 1_700_000_000, hash: "signed-auth" };
  let linkedBody: unknown;
  context.mocks.api(integrationsTelegramContract.link, ({ body, respond }) => {
    linkedBody = body;
    return respond(200, {
      botUsername: "registered_bot",
      telegramUserId: "99002",
    });
  });
  const activatePrimary = (name: string, container: HTMLElement) => {
    const button = getAction("button", name, container);
    expect(button).toHaveAttribute("type", "submit");
    click(button);
  };
  const clipboard = context.mocks.browser.clipboardWriteText();
  context.mocks.data.agents([
    agent(PRIMARY_AGENT_ID, null),
    agent("c0000000-0000-4000-a000-000000000002", "Support"),
  ]);
  context.mocks.data.telegramIntegration({
    statuses: [],
    linkStatus: {
      linked: false,
      installation: {
        id: "bot_registered",
        botUsername: "registered_bot",
        loginBotId: "123456789",
        domainConfigured: true,
      },
    },
    setupStatus: {
      id: "bot_registered",
      username: "registered_bot",
      domainConfigured: false,
      privacyDisabled: false,
    },
  });
  let rejectRegistration = true;
  context.mocks.api(
    integrationsTelegramContract.register,
    ({ body, respond }) => {
      expect(body).toStrictEqual({
        botToken: "123:token",
        defaultAgentId: PRIMARY_AGENT_ID,
      });
      if (rejectRegistration) {
        return respond(500, {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Telegram registration is temporarily unavailable.",
          },
        });
      }
      return respond(201, {
        id: "bot_registered",
        username: "registered_bot",
        avatarUrl: null,
        agent: { id: PRIMARY_AGENT_ID, name: "Nova" },
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
      });
    },
  );
  await setupPage({ context, path: "/settings/telegram" });

  await expect(
    screen.findByText("No Telegram bots yet"),
  ).resolves.toBeInTheDocument();
  const addBot = await waitFor(() => {
    return getAction("button", "Add bot");
  });
  click(addBot);
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("@BotFather")).toHaveAttribute(
    "href",
    "https://t.me/BotFather",
  );

  click(getAction("button", "Copy /newbot", dialog));

  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual(["/newbot"]);
    const copyCommand = getAction("button", "Copy /newbot", dialog);
    expect(copyCommand).toHaveTextContent("copied!");
  });
  const tokenInput = screen.getByLabelText("Bot token");
  expect(getAction("button", "Next", dialog)).toBeDisabled();
  expect(tokenInput).toHaveValue("");
  await fill(tokenInput, "123:token");
  activatePrimary("Next", dialog);
  await expect(
    within(dialog).findByText("/setdomain"),
  ).resolves.toBeInTheDocument();

  context.mocks.data.telegramIntegration({
    setupStatus: {
      id: "bot_registered",
      username: "registered_bot",
      domainConfigured: true,
      privacyDisabled: false,
    },
  });
  activatePrimary("Next", dialog);
  await expect(
    within(dialog).findByText("/setprivacy"),
  ).resolves.toBeInTheDocument();

  context.mocks.data.telegramIntegration({
    setupStatus: {
      id: "bot_registered",
      username: "registered_bot",
      domainConfigured: true,
      privacyDisabled: true,
    },
  });
  activatePrimary("Next", dialog);
  await waitFor(() => {
    expect(screen.getByLabelText("Default agent")).toHaveTextContent("Okou");
  });
  expect(
    within(dialog).getByText("Ready to create the integration"),
  ).toBeVisible();

  activatePrimary("Add bot", dialog);

  expect(opened.calls).toStrictEqual([
    { url: "about:blank", target: "_blank", features: null },
  ]);
  await expect(
    screen.findByText("Telegram registration is temporarily unavailable."),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(getAction("button", "Add bot", dialog)).toBeEnabled();
  });
  expect(authTab.closed).toBeTruthy();
  expect(
    within(dialog).getByText("Ready to create the integration"),
  ).toBeVisible();
  expect(screen.queryByText("Connected to Telegram!")).not.toBeInTheDocument();

  rejectRegistration = false;
  authTab.closed = false;
  activatePrimary("Add bot", dialog);

  expect(opened.calls).toStrictEqual([
    { url: "about:blank", target: "_blank", features: null },
    { url: "about:blank", target: "_blank", features: null },
  ]);
  await waitFor(() => {
    const authorization = new URL(authTab.location.href);
    expect(authorization.origin + authorization.pathname).toBe(
      "https://oauth.telegram.org/auth",
    );
    expect(authorization.searchParams.get("bot_id")).toBe("123456789");
  });
  expect(pathname()).toBe("/settings/telegram");
  expect(screen.queryByText("Connect to Telegram")).not.toBeInTheDocument();

  act(() => {
    context.mocks.browser.message(
      { event: "auth_result", result: auth },
      { origin: "https://oauth.telegram.org", source: authTab },
    );
  });
  await expect(
    screen.findByText("Connected to Telegram!"),
  ).resolves.toBeInTheDocument();
  expect(linkedBody).toStrictEqual({
    telegramBotId: "bot_registered",
    telegramAuth: auth,
  });
  expect(authTab.closed).toBeTruthy();
  expect(pathname()).toBe("/settings/telegram");
});
