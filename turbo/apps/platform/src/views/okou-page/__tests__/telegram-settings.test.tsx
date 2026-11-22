import { screen, waitFor, cleanup } from "@testing-library/react";
import { test, expect, vi } from "vitest";
import { integrationsTelegramContract as api } from "@okouai/api-contracts/contracts/integrations-telegram";
import {
  createTestRuntime,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { click } from "../../../__tests__/page-helper.ts";
import {
  telegramPath,
  telegramBotUrl,
  signedQuery,
  chatInstructions,
  botState,
  openTelegram,
  visitLink,
} from "./telegram-page-fixture.ts";
const context = testContext();
test("telegram-settings-002 A status marker leaves an unlinked official bot ready to authorize", async () => {
  botState(context);
  await openTelegram(context, telegramPath + "?status=connected");
  await expect(
    screen.findByText("Continue with Telegram"),
  ).resolves.toBeEnabled();
  expect(screen.queryByText(chatInstructions)).toBeNull();
  expect(location.pathname).toBe(telegramPath);
});
test("telegram-settings-004 Reloading an already linked bot leaves the bot tab closed until Open Telegram", async () => {
  botState(context, "99001");
  const writes = vi.fn<() => void>();
  context.mocks.api(api.link, ({ respond }) => {
    writes();
    return respond(400, {
      error: { code: "BAD_REQUEST", message: "Unexpected link" },
    });
  });
  const opened = vi.spyOn(window, "open");
  const path = telegramPath + "?status=connected";
  await openTelegram(context, path);
  await screen.findByText(chatInstructions);
  cleanup();
  expect(screen.queryByText(chatInstructions)).toBeNull();
  await openTelegram(createTestRuntime(context), path);
  await expect(
    screen.findByText(chatInstructions),
  ).resolves.toBeInTheDocument();
  expect(opened).not.toHaveBeenCalled();
  expect(writes).not.toHaveBeenCalled();
  await visitLink(context, "Open Telegram", telegramBotUrl);
});
test("telegram-settings-005 A different linked identity shows both accounts and offers workspace management", async () => {
  botState(context, "99002");
  await openTelegram(context, telegramPath + signedQuery);
  await expect(
    screen.findByText("A different Telegram account is connected"),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText(/@actual_name.*99001/)).toBeInTheDocument();
  expect(screen.queryByText("Connect")).toBeNull();
  expect(location.search).toContain("sig=" + "71".repeat(32));
  await visitLink(
    context,
    "Manage connected account",
    "https://app.okou.ai/works",
  );
});
test("telegram-settings-006 The signed link survives a pending save and is consumed only after successful binding", async () => {
  botState(context);
  const gate = createDeferredPromise<void>(context.signal),
    received = createDeferredPromise<void>(context.signal);
  const requests: string[] = [];
  context.mocks.api(api.link, async ({ body, respond }) => {
    const id = body.connectSignature?.telegramUserId ?? "";
    requests.push(id);
    received.resolve();
    await gate.promise;
    botState(context, id);
    return respond(200, { telegramUserId: id, botUsername: "support_bot" });
  });
  await openTelegram(context, telegramPath + signedQuery);
  click(await screen.findByText("Connect"));
  await received.promise;
  expect(location.search).toContain("sig=");
  expect(screen.queryByText(chatInstructions)).toBeNull();
  expect(screen.queryByText("Connected to Telegram!")).toBeNull();
  gate.resolve();
  await expect(
    screen.findByText(chatInstructions),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(new URL(location.href).searchParams.has("sig")).toBeFalsy();
  });
  const url = new URL(location.href);
  expect(url.searchParams.has("tgUser")).toBeFalsy();
  expect(url.searchParams.getAll("context")).toStrictEqual(["phone", "inbox"]);
  expect(url.hash).toBe("#message");
  expect(requests).toStrictEqual(["99001"]);
});
test("telegram-settings-007 A refused signed link retains retry and the bot destination", async () => {
  botState(context);
  context.mocks.api(api.link, ({ respond }) => {
    return respond(400, {
      error: {
        code: "BAD_REQUEST",
        message: "Invalid or expired connect link.",
      },
    });
  });
  await openTelegram(context, telegramPath + signedQuery);
  click(await screen.findByText("Connect"));
  await waitFor(() => {
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Invalid or expired connect link.",
    );
  });
  expect(screen.getByText("Connect")).toBeEnabled();
  expect(location.search).toContain("sig=");
  await visitLink(context, "Open Telegram", telegramBotUrl);
});
test.each([
  ["009", "focus"],
  ["010", "visibilitychange"],
] as const)(
  "telegram-settings-%s Standalone %s reloads verified Telegram membership",
  async (_id, event) => {
    botState(context);
    context.mocks.browser.standaloneDisplayMode(true);
    const writes = vi.fn<() => void>();
    context.mocks.api(api.link, ({ respond }) => {
      writes();
      return respond(400, {
        error: { code: "BAD_REQUEST", message: "Unexpected link" },
      });
    });
    const subscription = context.mocks.ably.deferSubscribeOnChannel(
      "user:test-user-123",
      "telegram:changed",
    );
    await openTelegram(context, telegramPath);
    await screen.findByText("Continue with Telegram");
    await subscription.started;
    botState(context, "99001");
    (event === "focus" ? window : document).dispatchEvent(new Event(event));
    await expect(
      screen.findByText(chatInstructions),
    ).resolves.toBeInTheDocument();
    expect(writes).not.toHaveBeenCalled();
    subscription.attach();
  },
);
test("telegram-settings-013 An unsupported bot has no connection action", async () => {
  await openTelegram(context, telegramPath + "?bot=unknown");
  await expect(
    screen.findByText("Connect link is incomplete"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("Connect")).toBeNull();
});
