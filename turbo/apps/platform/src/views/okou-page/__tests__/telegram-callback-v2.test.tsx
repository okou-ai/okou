import {
  integrationsTelegramContract,
  type TelegramAuthCallbackMessage,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import { act, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockNow } from "../../../lib/time.ts";
import {
  getAction,
  getIntegrationCard,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
const identity = Object.freeze({
  id: "99003",
  auth_date: "1700000000",
  hash: "a".repeat(64),
  username: "ada",
});
const bot = Object.freeze({
  id: "official",
  kind: "official" as const,
  username: "support_bot",
  avatarUrl: null,
  agent: { id: "compose_1", name: "Support" },
  isOwner: false,
  isConnected: false,
  connectedUser: null,
  tokenStatus: "valid" as const,
  official: {
    configured: true,
    usesDefaultAgent: true,
    linkedTelegramUserId: null,
  },
  domainConfigured: true,
  environment: {
    requiredSecrets: [],
    requiredVars: [],
    missingSecrets: [],
    missingVars: [],
  },
});

function connected() {
  context.mocks.data.telegramIntegration({
    statuses: [
      {
        ...bot,
        isConnected: true,
        connectedUser: {
          telegramUserId: identity.id,
          telegramUsername: "ada",
          telegramDisplayName: "Ada",
        },
      },
    ],
  });
}

async function begin() {
  context.mocks.data.telegramIntegration({ statuses: [bot] });
  context.mocks.api(
    integrationsTelegramContract.getLinkStatus,
    ({ query, respond }) => {
      expect(query.callbackProtocol).toBe("2");
      return respond(200, {
        linked: false,
        installation: {
          id: "official",
          botUsername: "support_bot",
          loginBotId: "123456789",
          domainConfigured: true,
          authCallbackProtocol: 2,
        },
      });
    },
  );
  const popup = context.mocks.browser.authWindow();
  const outgoing: { message: TelegramAuthCallbackMessage; origin: string }[] =
    [];
  Object.defineProperty(popup, "location", { value: { href: "" } });
  Object.defineProperty(popup, "postMessage", {
    value: (message: TelegramAuthCallbackMessage, origin: string) => {
      outgoing.push({ message, origin });
    },
  });
  const opened = context.mocks.browser.open(popup);
  await setupPage({ context, path: "/works" });
  const button = await waitFor(() => {
    const button = getAction(
      "button",
      "Connect",
      getIntegrationCard("Telegram"),
    );
    expect(button).toBeEnabled();
    return button;
  });
  click(button);
  const callback = await waitFor(() => {
    const url = new URL(popup.location.href);
    expect(url.searchParams.get("bot_id")).toBe("123456789");
    return new URL(url.searchParams.get("return_to") ?? "");
  });
  expect(callback.pathname).toBe("/api/integrations/telegram/auth-callback");
  expect(callback.searchParams.getAll("callbackProtocol")).toStrictEqual(["2"]);
  expect(callback.searchParams.getAll("bot")).toStrictEqual(["official"]);
  expect(callback.searchParams.getAll("targetOrigin")).toStrictEqual([
    window.location.origin,
  ]);
  const operationId = callback.searchParams.get("operationId");
  expect(operationId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  function send(
    type: string,
    extra: Record<string, unknown> = {},
    origin = callback.origin,
    source: Window = popup,
  ) {
    act(() => {
      context.mocks.browser.message(
        { protocol: 2, operationId, bot: "official", type, ...extra },
        { origin, source },
      );
    });
  }
  function native() {
    act(() => {
      context.mocks.browser.message(
        { event: "auth_result", result: identity },
        { origin: "https://oauth.telegram.org", source: popup },
      );
    });
  }
  return { popup, outgoing, opened, callback, send, native, button };
}

function hasResult(
  messages: { message: TelegramAuthCallbackMessage }[],
  status: string,
) {
  return messages.some(({ message }) => {
    return message.type === "telegram-auth-result" && message.status === status;
  });
}

test("The v2 tab waits for one real binding, acknowledges duplicates and leaves Works visible", async () => {
  const post = context.mocks.deferred<void>();
  const requested = context.mocks.deferred<void>();
  let posts = 0;
  context.mocks.api(
    integrationsTelegramContract.link,
    async ({ body, respond }) => {
      posts++;
      expect(body).toStrictEqual({
        telegramBotId: "official",
        telegramAuth: { ...identity, id: 99_003, auth_date: 1_700_000_000 },
      });
      requested.resolve();
      await post.promise;
      connected();
      return respond(200, {
        botUsername: "support_bot",
        telegramUserId: identity.id,
      });
    },
  );
  const bridge = await begin();
  bridge.send("telegram-auth-bridge-ready");
  expect(bridge.outgoing.at(-1)?.message.type).toBe("telegram-auth-ready");
  const firstReady = bridge.outgoing.length;
  bridge.send("telegram-auth-bridge-ready");
  expect(bridge.outgoing).toHaveLength(firstReady);
  bridge.send("telegram-auth", { data: identity });
  await requested.promise;
  bridge.native();
  bridge.send("telegram-auth", { data: identity });
  expect({ value: hasResult(bridge.outgoing, "linked") }).toStrictEqual({
    value: false,
  });
  expect(screen.queryByText("Connected (@ada)")).not.toBeInTheDocument();
  post.resolve();
  await expect(
    screen.findByText("Connected (@ada)"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect({ value: hasResult(bridge.outgoing, "linked") }).toStrictEqual({
      value: true,
    });
  });
  const terminal = bridge.outgoing.find(({ message }) => {
    return message.type === "telegram-auth-result";
  });
  expect(terminal?.origin).toBe(bridge.callback.origin);
  bridge.send("telegram-auth-ack", { stage: "result" });
  bridge.send("telegram-auth-ack", { stage: "result" });
  bridge.send("telegram-auth", { data: identity });
  expect(posts).toBe(1);
  expect({ value: bridge.popup.closed }).toStrictEqual({ value: false });
  expect(window.location.pathname).toBe("/works");
});

test("Native identity can bind first and deliver the owned result when the callback becomes ready later", async () => {
  let posts = 0;
  context.mocks.api(integrationsTelegramContract.link, ({ respond }) => {
    posts++;
    connected();
    return respond(200, {
      botUsername: "support_bot",
      telegramUserId: identity.id,
    });
  });
  const bridge = await begin();
  bridge.native();
  await expect(
    screen.findByText("Connected (@ada)"),
  ).resolves.toBeInTheDocument();
  expect({ value: hasResult(bridge.outgoing, "linked") }).toStrictEqual({
    value: false,
  });
  bridge.send("telegram-auth-bridge-ready");
  expect({ value: hasResult(bridge.outgoing, "linked") }).toStrictEqual({
    value: true,
  });
  bridge.send("telegram-auth", { data: identity });
  bridge.send("telegram-auth-ack", { stage: "result" });
  expect(posts).toBe(1);
  expect({ value: bridge.popup.closed }).toStrictEqual({ value: false });
});

test("Wrong protocol, operation, product bot, origin and window cannot authorize the active operation", async () => {
  const requested = context.mocks.deferred<void>();
  const ids: number[] = [];
  context.mocks.api(integrationsTelegramContract.link, ({ body, respond }) => {
    ids.push(body.telegramAuth!.id);
    requested.resolve();
    return respond(200, {
      botUsername: "support_bot",
      telegramUserId: identity.id,
    });
  });
  const bridge = await begin();
  bridge.send("telegram-auth-bridge-ready");
  const wrong = { ...identity, id: "11111" };
  for (const extra of [
    { protocol: "2" },
    { protocol: 1 },
    { operationId: crypto.randomUUID() },
    { bot: "123456789" },
  ]) {
    bridge.send("telegram-auth", { data: wrong, ...extra });
  }
  bridge.send("telegram-auth", { data: wrong }, "https://untrusted.example");
  bridge.send(
    "telegram-auth",
    { data: wrong },
    bridge.callback.origin,
    context.mocks.browser.authWindow(),
  );
  bridge.send("telegram-auth", { data: wrong }, "https://oauth.telegram.org");
  bridge.send("telegram-auth", { data: { ...wrong, id: [wrong.id] } });
  bridge.send("telegram-auth", {
    data: { ...wrong, auth_date: [wrong.auth_date] },
  });
  bridge.send("telegram-auth", { data: { ...wrong, hash: "invalid" } });
  bridge.send("telegram-auth", { data: identity });
  await requested.promise;
  await waitFor(() => {
    expect({ value: hasResult(bridge.outgoing, "linked") }).toStrictEqual({
      value: true,
    });
  });
  bridge.send("telegram-auth-ack", { stage: "result" });
  expect(ids).toStrictEqual([99_003]);
});

test("Changing the initiating organization stops identity delivery and never binds under the next org", async () => {
  const bridge = await begin();
  bridge.send("telegram-auth-bridge-ready");
  act(() => {
    context.mocks
      .clerk()
      .organization({ activeOrg: { id: "org_changed", name: "Changed" } });
    context.mocks.clerk().stateChanged();
  });
  bridge.send("telegram-auth", { data: identity });
  await waitFor(() => {
    expect(bridge.button).toBeEnabled();
  });
  expect({ value: hasResult(bridge.outgoing, "interrupted") }).toStrictEqual({
    value: true,
  });
  expect({ value: hasResult(bridge.outgoing, "linked") }).toStrictEqual({
    value: false,
  });
  expect(screen.queryByText("Connected to Telegram!")).not.toBeInTheDocument();
});

test("A suspended expired operation rejects late identity and releases its controls", async () => {
  mockNow(1_800_000_000_000, context.signal);
  const bridge = await begin();
  bridge.send("telegram-auth-bridge-ready");
  mockNow(1_800_000_120_001, context.signal);
  bridge.send("telegram-auth", { data: identity });
  await waitFor(() => {
    expect(bridge.button).toBeEnabled();
  });
  expect({ value: hasResult(bridge.outgoing, "interrupted") }).toStrictEqual({
    value: true,
  });
  expect({ value: hasResult(bridge.outgoing, "linked") }).toStrictEqual({
    value: false,
  });
});

test("Denial reports cancelled and permits retry without a binding request", async () => {
  const bridge = await begin();
  bridge.send("telegram-auth-bridge-ready");
  act(() => {
    context.mocks.browser.message(
      { event: "auth_result", result: false },
      { origin: "https://oauth.telegram.org", source: bridge.popup },
    );
  });
  await waitFor(() => {
    expect({ value: hasResult(bridge.outgoing, "cancelled") }).toStrictEqual({
      value: true,
    });
  });
  bridge.send("telegram-auth-ack", { stage: "result" });
  await waitFor(() => {
    expect(bridge.button).toBeEnabled();
  });
  expect(
    screen.getByText(/This attempt did not confirm a connection/u),
  ).toBeInTheDocument();
  expect({ value: hasResult(bridge.outgoing, "linked") }).toStrictEqual({
    value: false,
  });
});

test("An unacknowledged result is repeated on readiness and stops after its correlated result ACK", async () => {
  context.mocks.api(integrationsTelegramContract.link, ({ respond }) => {
    connected();
    return respond(200, {
      botUsername: "support_bot",
      telegramUserId: identity.id,
    });
  });
  const bridge = await begin();
  bridge.send("telegram-auth-bridge-ready");
  bridge.send("telegram-auth", { data: identity });
  await waitFor(() => {
    expect({ value: hasResult(bridge.outgoing, "linked") }).toStrictEqual({
      value: true,
    });
  });
  bridge.send("telegram-auth-ack", {
    stage: "result",
    operationId: crypto.randomUUID(),
  });
  const before = bridge.outgoing.length;
  bridge.send("telegram-auth-bridge-ready");
  expect(bridge.outgoing.length).toBeGreaterThan(before);
  bridge.send("telegram-auth-ack", { stage: "result" });
  const completed = bridge.outgoing.length;
  bridge.send("telegram-auth-bridge-ready");
  bridge.send("telegram-auth", { data: identity });
  expect(bridge.outgoing).toHaveLength(completed);
  expect({ value: bridge.popup.closed }).toStrictEqual({ value: false });
});

test.each(["account", "session"])(
  "An initiating %s change during POST ignores the old server request result",
  async (change) => {
    const requested = context.mocks.deferred<void>();
    const release = context.mocks.deferred<void>();
    const responseReturned = context.mocks.deferred<void>();
    context.mocks.api(
      integrationsTelegramContract.link,
      async ({ respond }) => {
        requested.resolve();
        await release.promise;
        const response = respond(200, {
          botUsername: "support_bot",
          telegramUserId: identity.id,
        });
        responseReturned.resolve();
        return response;
      },
    );
    const bridge = await begin();
    bridge.send("telegram-auth-bridge-ready");
    bridge.send("telegram-auth", { data: identity });
    await requested.promise;
    act(() => {
      context.mocks.clerk().user(
        {
          id: change === "account" ? "other-user" : "test-user-123",
          fullName: "Test User",
        },
        { id: "other-session", token: "other-token" },
      );
      context.mocks.clerk().stateChanged();
    });
    await act(async () => {
      release.resolve();
      await responseReturned.promise;
    });
    expect({ value: hasResult(bridge.outgoing, "linked") }).toStrictEqual({
      value: false,
    });
    expect({ value: hasResult(bridge.outgoing, "cancelled") }).toStrictEqual({
      value: false,
    });
    expect(
      screen.queryByText("Connected to Telegram!"),
    ).not.toBeInTheDocument();
  },
);
