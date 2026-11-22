import { click } from "../../../__tests__/page-helper.ts";
import {
  design,
  directory,
  switchMenu,
  switchButton,
} from "./switcher-directory-fixture.ts";
import { screen, waitFor, within } from "@testing-library/react";
import { test, expect } from "vitest";
import { integrationsTelegramContract as api } from "@okouai/api-contracts/contracts/integrations-telegram";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { mockNow } from "../../../lib/time.ts";
import {
  botState,
  openTelegram,
  authorize,
  connectControl,
  telegramPath,
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
