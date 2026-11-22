import { integrationsTelegramContract } from "@okouai/api-contracts/contracts/integrations-telegram";
import { screen, waitFor, within } from "@testing-library/react";
import { test, expect } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  botState,
  openTelegram,
  authorize,
  connectControl,
} from "./telegram-page-fixture.ts";
const context = testContext();
test("telegram-oauth-connect-002 Missing official configuration disables Telegram while Slack remains available", async () => {
  botState(context, undefined, false);
  await openTelegram(context, "/works");
  await expect(
    screen.findByText("Official bot configuration is missing."),
  ).resolves.toBeInTheDocument();
  expect(screen.getByTestId("telegram-connect-button")).toBeDisabled();
  expect(screen.getByText("Slack")).toBeInTheDocument();
});
test("telegram-oauth-connect-004 A denied browser window leaves Works ready to try Connect again", async () => {
  botState(context);
  const browser = context.mocks.browser.open(null);
  await openTelegram(context, "/works");
  click(await connectControl());
  await expect(
    screen.findByText(/authorization window/i),
  ).resolves.toBeInTheDocument();
  expect(browser.calls).toContainEqual(
    expect.objectContaining({ url: "about:blank", target: "_blank" }),
  );
  await connectControl();
  expect(location.pathname).toBe("/works");
});
test("telegram-oauth-connect-012 Closing the provider tab releases the in-progress Works control", async () => {
  botState(context);
  await openTelegram(context, "/works");
  const button = await connectControl();
  const { tab } = await authorize(context, button);
  expect(button).toBeDisabled();
  tab.close();
  await waitFor(() => {
    expect(button).toBeEnabled();
  });
  expect(screen.queryByText("Connected to Telegram!")).toBeNull();
  expect(location.pathname).toBe("/works");
});
test("telegram-oauth-connect-001 A live connection shows the account and can be disconnected from its own menu", async () => {
  botState(context);
  await openTelegram(context, "/works");
  await connectControl();
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription("telegram:changed")).toBeTruthy();
  });
  botState(context, "99002");
  context.mocks.ably.trigger("telegram:changed", {});
  const indicator = await screen.findByTestId("telegram-connected-indicator");
  expect(indicator).toHaveTextContent(/actual_name/);
  expect(screen.queryByTestId("telegram-connect-button")).toBeNull();
  const card = indicator.closest<HTMLElement>('[data-slot="integration-card"]');
  if (!card) {
    throw new Error("Missing Telegram card");
  }
  click(within(card).getByLabelText("More options"));
  click(await screen.findByText("Disconnect"));
  await expect(
    screen.findByText("Telegram account disconnected"),
  ).resolves.toBeInTheDocument();
  await connectControl();
  expect(screen.queryByTestId("telegram-connected-indicator")).toBeNull();
  expect(location.pathname).toBe("/works");
});
test("telegram-oauth-connect-014 A membership update during subscription attachment is read back on Works", async () => {
  botState(context);
  const sub = context.mocks.ably.deferSubscribeOnChannel(
    "user:test-user-123",
    "telegram:changed",
  );
  await openTelegram(context, "/works");
  await connectControl();
  await sub.started;
  botState(context, "99002");
  context.mocks.ably.trigger("telegram:changed", {});
  sub.attach();
  await expect(
    screen.findByTestId("telegram-connected-indicator"),
  ).resolves.toHaveTextContent(/actual_name/);
  expect(location.pathname).toBe("/works");
});
test("telegram-oauth-connect-013 Leaving for Workflows interrupts the tab before its late return to Works", async () => {
  botState(context);
  await openTelegram(context, "/works");
  const bridge = await authorize(context, await connectControl());
  bridge.ready();
  const rail = () => {
    return within(screen.getByTestId("labeled-nav-rail"));
  };
  click(rail().getByLabelText("Workflows"));
  await waitFor(() => {
    return bridge.result("interrupted");
  });
  expect(location.pathname).toBe("/workflows");
  expect(bridge.tab.closed).toBeFalsy();
  bridge.messages.mockClear();
  bridge.send({
    type: "telegram-auth",
    data: {
      id: 99_001,
      first_name: "Marin",
      auth_date: 1_795_100_000,
      hash: "40".repeat(32),
    },
  });
  expect(bridge.messages).not.toHaveBeenCalled();
  click(rail().getByText("Channels"));
  await connectControl();
  expect(location.pathname).toBe("/works");
  expect(screen.queryByTestId("telegram-connected-indicator")).toBeNull();
  bridge.tab.close();
});
test("telegram-oauth-connect-003 Works shows the identity supplied by the opened provider tab", async () => {
  const bot = botState(context);
  let linked: typeof bot.connectedUser = null;
  context.mocks.api(integrationsTelegramContract.link, ({ body, respond }) => {
    const auth = body.telegramAuth;
    if (!auth) {
      throw new Error("Expected a provider identity");
    }
    linked = {
      telegramUserId: String(auth.id),
      telegramUsername: auth.username ?? null,
      telegramDisplayName: auth.first_name ?? null,
    };
    return respond(200, {
      botUsername: "support_bot",
      telegramUserId: String(auth.id),
    });
  });
  context.mocks.api(integrationsTelegramContract.list, ({ respond }) => {
    return respond(200, {
      bots: [
        {
          ...bot,
          isConnected: linked !== null,
          connectedUser: linked,
          official: {
            ...bot.official!,
            linkedTelegramUserId: linked?.telegramUserId ?? null,
          },
        },
      ],
    });
  });
  await openTelegram(context, "/works");
  const { tab } = await authorize(context, await connectControl());
  function deliver(
    source: Window,
    origin: string,
    id: number,
    username: string,
  ) {
    context.mocks.browser.message(
      {
        event: "auth_result",
        result: {
          id,
          username,
          first_name: username,
          auth_date: 1_795_000_000,
          hash: "bc".repeat(32),
        },
      },
      { source, origin },
    );
  }
  deliver(window, "https://oauth.telegram.org", 7101, "another_window");
  deliver(tab, "https://unrelated.example.test", 7102, "another_origin");
  deliver(tab, "https://oauth.telegram.org", 7103, "chosen_identity");
  await screen.findByText("Connected to Telegram!");
  await expect(
    screen.findByTestId("telegram-connected-indicator"),
  ).resolves.toHaveTextContent("chosen_identity");
  expect(screen.queryByTestId("telegram-connect-button")).toBeNull();
  expect(location.pathname).toBe("/works");
});
