import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";
import { integrationsTelegramContract } from "@okouai/api-contracts/contracts/integrations-telegram";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
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

test("An admin can set up a new Telegram bot", async () => {
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
    setupStatus: {
      id: "bot_registered",
      username: "registered_bot",
      domainConfigured: false,
      privacyDisabled: false,
    },
  });
  context.mocks.api(
    integrationsTelegramContract.register,
    ({ body, respond }) => {
      expect(body).toStrictEqual({
        botToken: "123:token",
        defaultAgentId: PRIMARY_AGENT_ID,
      });
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

  await expect(
    screen.findByText("Connect to Telegram"),
  ).resolves.toBeInTheDocument();
  expect(getAction("link", "Back to Telegram settings")).toBeInTheDocument();
});
