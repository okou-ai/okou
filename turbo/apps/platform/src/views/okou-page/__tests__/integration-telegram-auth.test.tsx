import { click, startPage } from "../../../__tests__/page-helper.ts";
import {
  design,
  directory,
  switchMenu,
  switchButton,
} from "./switcher-directory-fixture.ts";
import { screen, waitFor, within } from "@testing-library/react";
import { test, expect } from "vitest";
import {
  integrationsTelegramContract as api,
  integrationsTelegramContract,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { mockNow } from "../../../lib/time.ts";
import {
  botState,
  openTelegram,
  authorize,
  connectControl,
  telegramPath,
  signedQuery,
  telegramBotUrl,
  visitLink,
} from "./telegram-page-fixture.ts";

const context = testContext();

const account = {
  id: 99_001,
  username: "marin",
  first_name: "Marin",
  auth_date: 1_795_100_000,
  hash: "40".repeat(32),
} as const;
test("telegram-callback-v2-001 Repeated Telegram deliveries finish the one pending link and acknowledge the result", async () => {
  botState(context);
  const posted = createDeferredPromise<void>(context.signal),
    release = createDeferredPromise<void>(context.signal);
  const bindings: number[] = [];
  context.mocks.api(api.link, async ({ body, respond }) => {
    const id = Number(body.telegramAuth?.id);
    bindings.push(id);
    posted.resolve();
    await release.promise;
    botState(context, String(id));
    return respond(200, {
      telegramUserId: String(id),
      botUsername: "support_bot",
    });
  });
  await openTelegram(context, "/works");
  const bridge = await authorize(context, await connectControl());
  bridge.ready();
  const identity = () => {
    return bridge.send({ type: "telegram-auth", data: account });
  };
  identity();
  await posted.promise;
  identity();
  expect(bridge.messages).toHaveBeenCalledWith(
    expect.objectContaining({ type: "telegram-auth-ack", stage: "identity" }),
    bridge.callback.origin,
  );
  expect(screen.queryByTestId("telegram-connected-indicator")).toBeNull();
  release.resolve();
  await waitFor(() => {
    return bridge.result("linked");
  });
  await expect(
    screen.findByTestId("telegram-connected-indicator"),
  ).resolves.toBeInTheDocument();
  bridge.ready();
  identity();
  bridge.send({ type: "telegram-auth-ack", stage: "result" });
  const count = bridge.messages.mock.calls.length;
  bridge.ready();
  identity();
  expect(bridge.messages).toHaveBeenCalledTimes(count);
  expect(bindings).toStrictEqual([99_001]);
  expect(bridge.tab.closed).toBeFalsy();
  expect(location.pathname).toBe("/works");
  bridge.tab.close();
});
test("telegram-callback-v2-005 A suspended authorization reports expiry and releases Connect", async () => {
  let clock = 1_795_100_000_000;
  mockNow(() => {
    return clock;
  }, context.signal);
  botState(context);
  await openTelegram(context, "/works");
  const button = await connectControl();
  const bridge = await authorize(context, button);
  bridge.ready();
  clock += 121_000;
  bridge.send({ type: "telegram-auth", data: account });
  await waitFor(() => {
    return bridge.result("interrupted");
  });
  await connectControl();
  expect(bridge.messages).not.toHaveBeenCalledWith(
    expect.objectContaining({ status: "linked" }),
    bridge.callback.origin,
  );
  bridge.tab.close();
});
test("telegram-callback-v2-006 Denying authorization and acknowledging cancellation restores the standalone retry action", async () => {
  botState(context);
  await openTelegram(context, telegramPath);
  const button = await screen.findByText("Continue with Telegram");
  const bridge = await authorize(context, button);
  bridge.ready();
  context.mocks.browser.message(
    { event: "auth_result", result: false },
    { origin: "https://oauth.telegram.org", source: bridge.tab },
  );
  await waitFor(() => {
    return bridge.result("cancelled");
  });
  bridge.send({ type: "telegram-auth-ack", stage: "result" });
  await expect(
    screen.findByText(/This attempt did not confirm a connection/),
  ).resolves.toBeInTheDocument();
  expect(button).toBeEnabled();
  expect(bridge.messages).not.toHaveBeenCalledWith(
    expect.objectContaining({ status: "linked" }),
    bridge.callback.origin,
  );
  bridge.tab.close();
});
test("telegram-callback-v2-007 Only the matching result receipt ends delivery to the open callback", async () => {
  botState(context);
  await openTelegram(context, telegramPath);
  const bridge = await authorize(
    context,
    await screen.findByText("Continue with Telegram"),
  );
  bridge.ready();
  const identity = { type: "telegram-auth", data: account };
  bridge.send(identity);
  await waitFor(() => {
    return bridge.result("linked");
  });
  bridge.send({
    type: "telegram-auth-ack",
    stage: "result",
    operationId: crypto.randomUUID(),
  });
  bridge.messages.mockClear();
  bridge.ready();
  bridge.result("linked");
  bridge.send({ type: "telegram-auth-ack", stage: "result" });
  bridge.messages.mockClear();
  bridge.ready();
  bridge.send(identity);
  expect(bridge.messages).not.toHaveBeenCalled();
  expect(bridge.tab.closed).toBeFalsy();
  bridge.tab.close();
});
test("telegram-callback-v2-004 Changing workspace interrupts the pending Telegram connection before the second workspace can link", async () => {
  const template = botState(context);
  const designRead = createDeferredPromise<void>(context.signal);
  const linked = new Set<string>();
  context.mocks.api(api.link, ({ request, body, respond }) => {
    linked.add(request.headers.get("authorization") ?? "");
    return respond(200, {
      telegramUserId: String(body.telegramAuth?.id),
      botUsername: "channel_bot",
    });
  });
  context.mocks.api(api.list, ({ request, respond }) => {
    const owner = request.headers.get("authorization") ?? "";
    const next = owner === "Bearer " + design.id;
    if (next) {
      designRead.resolve();
    }
    return respond(200, {
      bots: [
        {
          ...template,
          username: next ? "design_channel_bot" : "acme_channel_bot",
          isConnected: linked.has(owner),
        },
      ],
    });
  });
  await directory(context, () => {
    return Promise.resolve();
  });
  const channels = () => {
    return within(screen.getByTestId("labeled-nav-rail")).getByText("Channels");
  };
  click(channels());
  const bridge = await authorize(
    context,
    await connectControl(),
    "http://localhost",
  );
  bridge.ready();
  const menu = await switchMenu();
  click(within(menu).getByText(design.name));
  await waitFor(() => {
    return bridge.result("interrupted");
  });
  const workspace = await switchButton();
  await expect(
    within(workspace).findByRole("img", { name: design.name }),
  ).resolves.toBeInTheDocument();
  if (location.pathname !== "/works") {
    click(channels());
  }
  await designRead.promise;
  await connectControl();
  expect(linked.has("Bearer " + design.id)).toBeFalsy();
  expect(screen.queryByTestId("telegram-connected-indicator")).toBeNull();
  expect(bridge.messages).not.toHaveBeenCalledWith(
    expect.objectContaining({ status: "linked" }),
    bridge.callback.origin,
  );
  bridge.tab.close();
});

test("telegram-connect-routes-001 The linked member lands on standalone Telegram with the original query and fragment", async () => {
  botState(context, "99001");
  await openTelegram(context, telegramPath + signedQuery);
  await expect(
    screen.findByText("Already connected to Telegram"),
  ).resolves.toBeInTheDocument();
  expect(location.href).toBe(
    "https://app.okou.ai" + telegramPath + signedQuery,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  await visitLink(context, "Open Telegram", telegramBotUrl);
});
test("telegram-connect-routes-003 Sign-in carries the complete signed member destination", async () => {
  await startPage({
    context,
    auth: null,
    host: "app.okou.ai",
    path: telegramPath + signedQuery,
  });
  await waitFor(() => {
    expect(location.pathname).toBe("/sign-in");
  });
  expect(new URL(location.href).searchParams.get("redirect_url")).toBe(
    "https://app.okou.ai" + telegramPath + signedQuery,
  );
});
test("telegram-connect-routes-005 Setup opens onboarding in a new page and preserves the signed request", async () => {
  botState(context);
  context.mocks.data.onboardingStatus({
    hasOrg: false,
    needsOnboarding: true,
  });
  const path =
    telegramPath +
    signedQuery.replace("context=phone", "prompt=connect&context=phone");
  await openTelegram(context, path);
  await expect(
    screen.findByText("Finish account setup"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("Connect")).toBeNull();
  await visitLink(context, "Open setup", "https://app.okou.ai/onboarding");
  expect(location.href).toBe("https://app.okou.ai" + path);
});

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
