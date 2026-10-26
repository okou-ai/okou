import {
  getAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";
import { integrationsTelegramContract } from "@okouai/api-contracts/contracts/integrations-telegram";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
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
const proof = new URLSearchParams({
  bot: "official",
  tgUser: "99001",
  tgUserName: "requested",
  tgDisplayName: "Requested name",
  ts: "1700000000",
  sig: "b".repeat(64),
}).toString();
function setConnection(connected: boolean, id = "99001") {
  context.mocks.data.telegramIntegration({
    statuses: [
      {
        ...bot,
        isConnected: connected,
        connectedUser: connected
          ? {
              telegramUserId: id,
              telegramUsername: "actual_name",
              telegramDisplayName: "Actual name",
            }
          : null,
      },
    ],
    linkStatus: connected
      ? { linked: true, telegramUserId: id, botUsername: "support_bot" }
      : { linked: false },
  });
}

test.each([
  "/settings/telegram",
  "/settings/telegram?status=connected",
  "/telegram/connect",
])(
  "%s reads the official bot and offers a real connect action without trusting result markers",
  async (path) => {
    setConnection(false);
    await setupPage({ context, path });
    await expect(
      waitFor(() => {
        const action = getAction("button", "Continue with Telegram");
        expect(action).toBeEnabled();
        return action;
      }),
    ).resolves.toBeEnabled();
    expect(
      screen.queryByText("Already connected to Telegram"),
    ).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/settings/telegram");
  },
);

test("A bare result and reload display the verified connection and never bind or launch Telegram", async () => {
  setConnection(true);
  const launched = context.mocks.browser.locationAssign();
  const opened = context.mocks.browser.open();
  let posts = 0;
  context.mocks.api(integrationsTelegramContract.link, ({ respond }) => {
    posts++;
    return respond(200, {
      telegramUserId: "99001",
      botUsername: "support_bot",
    });
  });
  await setupPage({ context, path: "/settings/telegram?status=connected" });
  await expect(
    screen.findByText("Send the bot a message in Telegram to start chatting."),
  ).resolves.toBeInTheDocument();
  const link = getAction("link", "Open Telegram");
  expect(link).toHaveAttribute("href", "https://t.me/support_bot");
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  act(() => {
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(
    screen.findByText("Send the bot a message in Telegram to start chatting."),
  ).resolves.toBeInTheDocument();
  expect(posts).toBe(0);
  expect(launched.calls).toStrictEqual([]);
  expect(opened.calls).toStrictEqual([]);
});

test("Signed identity mismatch is a controlled account-management choice, with no silent unlink or bind", async () => {
  setConnection(true, "99002");
  await setupPage({ context, path: `/settings/telegram?${proof}` });
  await expect(
    screen.findByRole("heading", {
      name: "A different Telegram account is connected",
    }),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText(/@actual_name.*99001/u)).toBeInTheDocument();
  expect(getAction("link", "Manage connected account")).toHaveAttribute(
    "href",
    "/works",
  );
  expect(queryAction("button", "Connect")).not.toBeInTheDocument();
  expect(new URLSearchParams(window.location.search).get("sig")).toBe(
    "b".repeat(64),
  );
});

test("Signed confirmation consumes proof only after the POST and displays a real readback", async () => {
  setConnection(false);
  const requested = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  let posts = 0;
  context.mocks.api(
    integrationsTelegramContract.link,
    async ({ body, respond }) => {
      posts++;
      expect(body.connectSignature).toStrictEqual({
        telegramUserId: "99001",
        telegramUsername: "requested",
        telegramDisplayName: "Requested name",
        timestamp: 1_700_000_000,
        signature: "b".repeat(64),
      });
      requested.resolve();
      await release.promise;
      setConnection(true);
      return respond(200, {
        telegramUserId: "99001",
        botUsername: "support_bot",
      });
    },
  );
  await setupPage({
    context,
    path: `/telegram/connect?${proof}&context=one&context=two#return-context`,
  });
  const connect = await waitFor(() => {
    const action = getAction("button", "Connect");
    expect(action).toBeEnabled();
    return action;
  });
  connect.focus();
  await userEvent.setup({ delay: null }).keyboard("{Enter}");
  await requested.promise;
  expect(screen.queryByText("Connected to Telegram!")).not.toBeInTheDocument();
  expect({
    value: new URLSearchParams(window.location.search).has("sig"),
  }).toStrictEqual({ value: true });
  release.resolve();
  await expect(
    screen.findByText("Send the bot a message in Telegram to start chatting."),
  ).resolves.toBeInTheDocument();
  expect(window.location.pathname).toBe("/settings/telegram");
  expect({
    value: new URLSearchParams(window.location.search).has("sig"),
  }).toStrictEqual({ value: false });
  expect({
    value: new URLSearchParams(window.location.search).has("tgUser"),
  }).toStrictEqual({ value: false });
  expect(
    new URLSearchParams(window.location.search).getAll("context"),
  ).toStrictEqual(["one", "two"]);
  expect(window.location.hash).toBe("#return-context");
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await expect(
    screen.findByText("Send the bot a message in Telegram to start chatting."),
  ).resolves.toBeInTheDocument();
  expect(posts).toBe(1);
});

test.each([400, 409] as const)(
  "A signed server rejection %s stays visible without consuming the pending link",
  async (status) => {
    setConnection(false);
    context.mocks.api(integrationsTelegramContract.link, ({ respond }) => {
      return respond(status, {
        error: {
          code: status === 400 ? "BAD_REQUEST" : "CONFLICT",
          message:
            status === 400
              ? "Invalid or expired connect link."
              : "This Telegram account is already connected elsewhere.",
        },
      });
    });
    await setupPage({ context, path: `/settings/telegram?${proof}` });
    const connect = await waitFor(() => {
      const action = getAction("button", "Connect");
      expect(action).toBeEnabled();
      return action;
    });
    click(connect);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        status === 400
          ? "Invalid or expired connect link."
          : "This Telegram account is already connected elsewhere.",
      );
    });
    expect(getAction("button", "Connect")).toBeEnabled();
    expect({
      value: new URLSearchParams(window.location.search).has("sig"),
    }).toStrictEqual({ value: true });
    expect(getAction("link", "Open Telegram")).toHaveAttribute(
      "href",
      "https://t.me/support_bot",
    );
  },
);

test.each(["focus", "visibilitychange"])(
  "Foreground %s recovers a missed connection without replaying proof",
  async (event) => {
    setConnection(false);
    context.mocks.browser.standaloneDisplayMode(true);
    await setupPage({ context, path: "/settings/telegram" });
    await expect(
      waitFor(() => {
        const action = getAction("button", "Continue with Telegram");
        expect(action).toBeEnabled();
        return action;
      }),
    ).resolves.toBeEnabled();
    setConnection(true);
    act(() => {
      (event === "focus" ? window : document).dispatchEvent(new Event(event));
    });
    await expect(
      screen.findByText(
        "Send the bot a message in Telegram to start chatting.",
      ),
    ).resolves.toBeInTheDocument();
  },
);

test("A member without a default agent sees the administrator prerequisite with the link intact", async () => {
  setConnection(false);
  context.mocks.data.onboardingStatus({
    hasDefaultAgent: false,
    defaultAgentId: null,
    isAdmin: false,
    needsOnboarding: true,
    onboardingComplete: false,
  });
  await setupPage({ context, path: `/settings/telegram?${proof}` });
  await expect(
    screen.findByText(/Ask a workspace administrator/u),
  ).resolves.toBeInTheDocument();
  expect(queryAction("link", "Open setup")).not.toBeInTheDocument();
  expect(queryAction("button", "Connect")).not.toBeInTheDocument();
  expect({
    value: new URLSearchParams(window.location.search).has("sig"),
  }).toStrictEqual({ value: true });
});

test("Returning from setup restores signed confirmation without copying or consuming proof", async () => {
  setConnection(false);
  context.mocks.data.onboardingStatus({
    hasDefaultAgent: false,
    defaultAgentId: null,
    needsOnboarding: true,
    onboardingComplete: false,
  });
  await setupPage({
    context,
    path: `/settings/telegram?${proof}#keep-context`,
  });
  await expect(
    screen.findByRole("heading", { name: "Finish account setup" }),
  ).resolves.toBeInTheDocument();
  const setup = getAction("link", "Open setup");
  expect(setup).toHaveAttribute("href", "/onboarding");
  expect(setup).toHaveAttribute("rel", "noopener noreferrer");
  context.mocks.data.onboardingStatus({
    hasDefaultAgent: true,
    defaultAgentId: "c0000000-0000-4000-a000-000000000001",
    needsOnboarding: false,
    onboardingComplete: true,
  });
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await waitFor(() => {
    expect(getAction("button", "Connect")).toBeEnabled();
  });
  expect(new URLSearchParams(window.location.search).get("sig")).toBe(
    "b".repeat(64),
  );
  expect(window.location.hash).toBe("#keep-context");
});

test.each([
  "bot=unknown",
  "bot=official&bot=official",
  "bot=official&tgUser=99001",
])("An unsupported or incomplete entry %s fails closed", async (search) => {
  await setupPage({ context, path: `/settings/telegram?${search}` });
  await expect(
    screen.findByRole("heading", { name: "Connect link is incomplete" }),
  ).resolves.toBeInTheDocument();
  expect(queryAction("button", "Connect")).toBeNull();
});
