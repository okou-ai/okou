import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import {
  browserUserActionsContract,
  type BrowserUserActionResponse,
} from "@okouai/api-contracts/contracts/browser-user-actions";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { compile } from "tailwindcss";
import { HttpResponse } from "msw";
import { state } from "ccstate";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  mockBrowserCdp,
  TEST_BROWSER_EXTENSION,
} from "../../../__tests__/browser-cdp-fixture.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  CAPABILITY_AGENT_ID,
  completedConversation,
  readyChat,
  RUN_PATH,
  RUN_THREAD_ID,
  createChatCapabilityHelpers,
} from "./chat-capability-test-helpers.ts";
import {
  assistantEvent,
  findButton,
  promptEvent,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installCapabilityChat } = createChatCapabilityHelpers(context);

const OTHER_AGENT_ID = "c0000000-0000-4000-a000-000000001101";
const OTHER_THREAD_ID = "b0000000-0000-4000-a000-000000001102";
const ACTION_RUN_ID = "d0000000-0000-4000-a000-000000001103";
const INITIAL_SCREENSHOT_URL =
  "https://images.example.test/browser-initial.png";
const SUSPENDED_SCREENSHOT_URL =
  "https://images.example.test/browser-suspended.png";
const ACTIVE_BROWSER_URL = "https://browser.example.test/live/initial";
const RESUMED_BROWSER_URL = "https://browser.example.test/live/resumed";
const BROWSER_INPUT_TOKEN = `vm0_browser_user_action_${"a".repeat(43)}`;
const BROWSER_INPUT_SUCCESS_CLIENT_ID = "10000000-0000-4000-a000-000000001104";
const BROWSER_INPUT_SUCCESS_SORT_ID = "10000000-0000-4000-a000-000000001105";
const BROWSER_INPUT_CANCEL_CLIENT_ID = "10000000-0000-4000-a000-000000001106";
const BROWSER_INPUT_CANCEL_SORT_ID = "10000000-0000-4000-a000-000000001107";
const BROWSER_INPUT_CALLBACK = "Continue after browser input";
const BROWSER_USER_ACTION_TOPIC = `browserUserActionChanged:${RUN_THREAD_ID}`;

// The fake API reports a callback once it was sent and notifies the thread
// after persisting it, as the production API does.
const callbackSent$ = state(false);

function acceptCallback(): void {
  context.store.set(callbackSent$, true);
  context.mocks.ably.trigger(BROWSER_USER_ACTION_TOPIC);
}

function browserInputAction(
  state: BrowserUserActionResponse["state"],
  hasTaskContext = true,
): Extract<BrowserUserActionResponse, { kind: "input" }> {
  return {
    kind: "input",
    ...(hasTaskContext
      ? {
          title: "Sign in to download invoices",
          reason: "The website requires sign-in to access your invoices.",
        }
      : {}),
    requestToken: BROWSER_INPUT_TOKEN,
    state,
    callbackDelivered: context.store.get(callbackSent$),
    completedAt: state === "pending" ? null : "2026-09-22T04:00:00.000Z",
    agentId: CAPABILITY_AGENT_ID,
    threadId: RUN_THREAD_ID,
    siteOrigin: "https://accounts.example.test",
    fields: [
      {
        key: "username",
        label: "Account email",
        description: "The email used for this account",
        fieldKind: "username",
        required: true,
        control: { tagName: "INPUT", inputType: "email" },
      },
      {
        key: "password",
        label: "Password",
        fieldKind: "password",
        required: true,
        control: { tagName: "INPUT", inputType: "password" },
      },
      {
        key: "code",
        label: "Verification code",
        fieldKind: "one_time_code",
        required: false,
        control: { tagName: "INPUT", inputType: "tel" },
      },
    ],
    callbackIds: {
      success: {
        clientEventId: BROWSER_INPUT_SUCCESS_CLIENT_ID,
        chatThreadSortEventId: BROWSER_INPUT_SUCCESS_SORT_ID,
      },
      cancellation: {
        clientEventId: BROWSER_INPUT_CANCEL_CLIENT_ID,
        chatThreadSortEventId: BROWSER_INPUT_CANCEL_SORT_ID,
      },
    },
  };
}

function browserInputUrl(
  args: {
    readonly agentId?: string;
    readonly threadId?: string;
  } = {},
): string {
  const url = new URL(
    `/browser/actions/${BROWSER_INPUT_TOKEN}`,
    "https://app.okou.ai",
  );
  url.searchParams.set("agentId", args.agentId ?? CAPABILITY_AGENT_ID);
  url.searchParams.set("threadId", args.threadId ?? RUN_THREAD_ID);
  url.searchParams.set("callbackPrompt", BROWSER_INPUT_CALLBACK);
  return url.href;
}

function browserInputRelativeUrl(): string {
  const url = new URL(browserInputUrl());
  return `${url.pathname}${url.search}`;
}

/**
 * The chat card surface is Tailwind utilities on the element itself, so the
 * App's utility output is the whole style source; nothing has to be lifted out
 * of the stylesheet. Colors are not observable here — happy-dom resolves
 * neither `var()` nor `@layer`, which is why these checks stay on the border
 * geometry the card's arbitrary width owns.
 */
async function createRenderedAppStyles(
  signal: AbortSignal,
): Promise<(element: HTMLElement) => void> {
  const compiler = await compile("@tailwind utilities;");
  const styleElement = document.createElement("style");
  document.head.append(styleElement);
  signal.addEventListener(
    "abort",
    () => {
      styleElement.remove();
    },
    { once: true },
  );

  return (element) => {
    styleElement.textContent = compiler.build([...element.classList]);
  };
}

function managedBrowserSession(args: {
  readonly status: "active" | "suspended";
  readonly screenshotUrl: string;
  readonly liveUrl: string | null;
}): BrowserSession {
  return {
    threadId: RUN_THREAD_ID,
    name: "Research",
    status: args.status,
    viewerUrl: `https://browser.example.test/view/${RUN_THREAD_ID}`,
    liveUrl: args.liveUrl,
    screenshotUrl: args.screenshotUrl,
    proxyCountryCode: "US",
    timeoutMinutes: 240,
    ...(args.status === "active"
      ? {
          screen: { width: 1440, height: 900, resizable: true },
          idleExpiresAt: "2026-08-18T12:10:00.000Z",
          suspendedAt: null,
          suspensionReason: null,
        }
      : {
          idleExpiresAt: null,
          suspendedAt: "2026-08-18T12:05:00.000Z",
          suspensionReason: "idle" as const,
        }),
    createdAt: "2026-08-18T11:00:00.000Z",
    updatedAt: "2026-08-18T12:05:00.000Z",
  };
}

function planActionUrl(origin: string): string {
  const url = new URL("/", origin);
  url.searchParams.set("settings", "billing");
  url.searchParams.set("billingView", "plans");
  return url.href;
}

function computerAuthorizationUrl(origin: string, token: string): string {
  return new URL(`/computer-use/authorize/${token}`, origin).href;
}

function connectorAuthorizationUrl(args: {
  readonly agentId?: string;
  readonly threadId?: string;
  readonly callbackPrompt?: string;
}): string {
  const url = new URL("/connectors/slack/authorize", "https://app.okou.ai");
  if (args.agentId !== undefined) {
    url.searchParams.set("agentId", args.agentId);
  }
  if (args.threadId !== undefined) {
    url.searchParams.set("threadId", args.threadId);
  }
  if (args.callbackPrompt !== undefined) {
    url.searchParams.set("callbackPrompt", args.callbackPrompt);
  }
  return url.href;
}

function linksByName(name: string, container: ParentNode = document.body) {
  return queryAllByRoleFast("link", container).filter((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.replace(/\s+/gu, " ").trim() === name
    );
  });
}

function linkByName(name: string, container: ParentNode = document.body) {
  const link = linksByName(name, container)[0];
  if (!link) {
    throw new Error(`${name} link was not visible`);
  }
  return link;
}

function buttonsByName(
  name: string,
  container: ParentNode = document.body,
): HTMLElement[] {
  return queryAllByRoleFast("button", container).filter((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.replace(/\s+/gu, " ").trim() === name
    );
  });
}

async function browserUserActionSubscribed() {
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscription(BROWSER_USER_ACTION_TOPIC),
    ).toBeTruthy();
  });
}

async function openManagedBrowserChat(
  sharedWorkerTestTransport: "direct" | "message-port" = "direct",
) {
  const cdpUrl = "wss://cdp.browser-use.com/research";
  mockBrowserCdp(context, cdpUrl);
  context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
    return respond(200, { cdpUrl, extension: TEST_BROWSER_EXTENSION });
  });
  let browser = managedBrowserSession({
    status: "active",
    screenshotUrl: INITIAL_SCREENSHOT_URL,
    liveUrl: ACTIVE_BROWSER_URL,
  });
  const trustedBrowserUrl = `https://app.okou.ai/browsers/${RUN_THREAD_ID}`;
  const foreignBrowserUrl = `https://app.okou.ai/browsers/${OTHER_THREAD_ID}`;
  const untrustedBrowserUrl = `https://app.okou.ai.evil.test/browsers/${RUN_THREAD_ID}`;
  installCapabilityChat({
    events: completedConversation(
      [
        `[Research session](${trustedBrowserUrl})`,
        `[Other conversation browser](${foreignBrowserUrl})`,
        `[Untrusted browser](${untrustedBrowserUrl})`,
      ].join("\n\n"),
    ),
  });
  context.mocks.api(browserContract.get, ({ params, respond }) => {
    expect(params.threadId).toBe(RUN_THREAD_ID);
    return respond(200, { browser });
  });
  context.mocks.api(browserContract.open, ({ params, respond }) => {
    expect(params.threadId).toBe(RUN_THREAD_ID);
    return respond(200, { browser });
  });
  context.mocks.api(browserContract.leaseByThread, ({ params, respond }) => {
    expect(params.threadId).toBe(RUN_THREAD_ID);
    return respond(200, { browser });
  });

  await setupPage({
    context,
    path: RUN_PATH,
    host: "app.okou.ai",
    sharedWorkerTestTransport,
  });

  await readyChat();
  return {
    foreignBrowserUrl,
    untrustedBrowserUrl,
    updateBrowser(
      next: ReturnType<typeof managedBrowserSession>,
      notify = true,
    ) {
      browser = next;
      if (notify) {
        context.mocks.ably.trigger("browserSessionChanged", {
          threadId: RUN_THREAD_ID,
        });
      }
    },
  };
}

test("Render a live managed browser card", async () => {
  await openManagedBrowserChat();
  const renderAppStyles = await createRenderedAppStyles(context.signal);
  const card = await findButton("Open Research browser");
  renderAppStyles(card);
  expect(getComputedStyle(card).borderTopWidth).toBe("1px");
  expect(getComputedStyle(card).transitionProperty).toBe(
    "background-color,border-color,transform",
  );
  expect(card).toHaveTextContent("Cloud browser");
  expect(card).toHaveTextContent("Live");
  const status = within(card).getByText("Live");
  renderAppStyles(status);
  expect(getComputedStyle(status).lineHeight).toBe("16px");
  expect(screen.getByTestId("browser-session-thumbnail")).toHaveAttribute(
    "src",
    INITIAL_SCREENSHOT_URL,
  );
});

test("Browser cards show status and thumbnail changes on events and continuity gaps", async () => {
  const attachment = context.mocks.ably.deferSubscribeOnChannel(
    "user:test-user-123",
    "browserSessionChanged",
  );
  const browser = await openManagedBrowserChat("message-port");
  const card = await findButton("Open Research browser");
  await waitFor(() => {
    expect(card).toHaveTextContent("Live");
  });
  await attachment.started;
  browser.updateBrowser(
    managedBrowserSession({
      status: "suspended",
      screenshotUrl: SUSPENDED_SCREENSHOT_URL,
      liveUrl: null,
    }),
    false,
  );
  attachment.attach();
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscription("browserSessionChanged"),
    ).toBeTruthy();
  });
  context.mocks.ably.trigger("browserSessionChanged", {
    threadId: RUN_THREAD_ID,
  });
  await waitFor(() => {
    expect(card).toHaveTextContent("Stopped");
  });
  expect(screen.getByTestId("browser-session-thumbnail")).toHaveAttribute(
    "src",
    SUSPENDED_SCREENSHOT_URL,
  );

  context.mocks.ably.triggerConnectionState("suspended");
  browser.updateBrowser(
    managedBrowserSession({
      status: "active",
      screenshotUrl: INITIAL_SCREENSHOT_URL,
      liveUrl: RESUMED_BROWSER_URL,
    }),
    false,
  );
  context.mocks.ably.triggerConnectionState("connected");
  await waitFor(() => {
    expect(card).toHaveTextContent("Live");
  });
  expect(screen.getByTestId("browser-session-thumbnail")).toHaveAttribute(
    "src",
    INITIAL_SCREENSHOT_URL,
  );
});

test("A browser card uses a private screenshot thumbnail while its panel keeps the original", async () => {
  const screenshotUrl =
    `https://${"a".repeat(32)}.r2.cloudflarestorage.com/private-artifacts/browser-screenshot.webp` +
    "?X-Amz-Signature=browser-screenshot-signature";
  const browser = managedBrowserSession({
    status: "suspended",
    screenshotUrl,
    liveUrl: null,
  });
  installCapabilityChat({
    events: completedConversation(
      `[Research session](https://app.okou.ai/browsers/${RUN_THREAD_ID})`,
    ),
  });
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, { browser });
  });

  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  const card = await findButton("Open Research browser");
  expect(within(card).getByTestId("browser-session-thumbnail")).toHaveAttribute(
    "src",
    `https://a.okou.io/cdn-cgi/image/width=800,fit=scale-down,format=auto,quality=85,metadata=none/${screenshotUrl}`,
  );

  click(card);
  await expect(
    screen.findByTestId("browser-session-panel-screenshot"),
  ).resolves.toHaveAttribute("src", screenshotUrl);
});

test("Follow suspension and resumption in the live browser panel", async () => {
  const { updateBrowser } = await openManagedBrowserChat();
  const card = await findButton("Open Research browser");
  click(card);

  const sidebar = await screen.findByRole("complementary", {
    name: "Cloud browser",
  });
  expect(sidebar).toBeVisible();
  await waitFor(() => {
    expect(
      within(sidebar).getByDisplayValue("https://example.com"),
    ).toBeEnabled();
  });
  expect(screen.getByTestId("browser-session-thumbnail")).toHaveAttribute(
    "src",
    INITIAL_SCREENSHOT_URL,
  );

  updateBrowser(
    managedBrowserSession({
      status: "suspended",
      screenshotUrl: SUSPENDED_SCREENSHOT_URL,
      liveUrl: null,
    }),
  );

  await waitFor(() => {
    expect(buttonsByName("Open Research browser")[0]).toHaveTextContent(
      "Stopped",
    );
  });
  expect(within(sidebar).getByLabelText("Remote browser input")).toBeDisabled();
  await expect(
    screen.findByTestId("browser-session-panel-screenshot"),
  ).resolves.toHaveAttribute("src", SUSPENDED_SCREENSHOT_URL);
  expect(within(sidebar).getByText("Browser not live")).toBeVisible();

  updateBrowser(
    managedBrowserSession({
      status: "active",
      screenshotUrl: SUSPENDED_SCREENSHOT_URL,
      liveUrl: RESUMED_BROWSER_URL,
    }),
  );

  await waitFor(() => {
    expect(screen.getByText("Live")).toBeVisible();
  });
  await waitFor(() => {
    expect(
      within(sidebar).getByDisplayValue("https://example.com"),
    ).toBeEnabled();
  });
  expect(screen.queryByTestId("browser-session-panel-screenshot")).toBeNull();
});

test("Keep foreign and untrusted browser URLs as ordinary links", async () => {
  const { foreignBrowserUrl, untrustedBrowserUrl } =
    await openManagedBrowserChat();
  await findButton("Open Research browser");
  const foreignLink = linkByName("Other conversation browser");
  expect(foreignLink).toHaveAttribute("href", foreignBrowserUrl);
  expect(foreignLink.closest("[data-browser-session-card]")).toBeNull();
  const untrustedLink = linkByName("Untrusted browser");
  expect(untrustedLink).toHaveAttribute("href", untrustedBrowserUrl);
  expect(untrustedLink.closest("[data-browser-session-card]")).toBeNull();
});

test("Recognize trusted assistant actions without trusting lookalikes", async () => {
  const trustedPlan = planActionUrl("https://app.okou.ai");
  const trustedComputer = computerAuthorizationUrl(
    "https://app.okou.ai",
    "assistant-trusted",
  );
  const userText = [
    `[User plan action](${trustedPlan})`,
    `[User computer action](${trustedComputer})`,
    `[User browser input](${browserInputUrl()})`,
  ].join("\n\n");
  const assistantText = [
    `[Assistant plan action](${trustedPlan})`,
    `[Assistant computer action](${trustedComputer})`,
    `[Malformed browser input](${browserInputUrl()}&extra=unexpected)`,
    `[Forged action](${computerAuthorizationUrl("https://app.okou.ai.evil.test", "forged")})`,
    "Wrong agent:",
    connectorAuthorizationUrl({
      agentId: OTHER_AGENT_ID,
      threadId: RUN_THREAD_ID,
      callbackPrompt: "Continue after authorization",
    }),
    "Wrong conversation:",
    connectorAuthorizationUrl({
      agentId: CAPABILITY_AGENT_ID,
      threadId: OTHER_THREAD_ID,
      callbackPrompt: "Continue in another conversation",
    }),
    "Missing action context:",
    connectorAuthorizationUrl({}),
    "Unavailable agent:",
    `https://app.okou.ai/agents/${OTHER_AGENT_ID}/permissions?connectorSlug=slack&permission=messages.read`,
  ].join("\n\n");
  installCapabilityChat({
    events: [
      promptEvent({
        id: "safe-actions-user",
        runId: ACTION_RUN_ID,
        seqId: 1,
        text: userText,
      }),
      assistantEvent({
        id: "safe-actions-assistant",
        runId: ACTION_RUN_ID,
        seqId: 2,
        text: assistantText,
      }),
    ],
  });

  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });

  await readyChat();
  await expect(
    screen.findByText("Upgrade your workspace"),
  ).resolves.toBeVisible();
  expect(screen.getAllByText("Upgrade your workspace")).toHaveLength(1);
  expect(screen.getAllByText("Computer Use authorization")).toHaveLength(1);
  const userMessage = screen
    .getByText(/User plan action/u)
    .closest<HTMLElement>('[data-role="user"]');
  if (!userMessage) {
    throw new Error("User action-like text was not visible");
  }
  expect(userMessage).toHaveTextContent("User plan action");
  expect(userMessage).toHaveTextContent("User computer action");
  expect(userMessage).toHaveTextContent("User browser input");
  expect(within(userMessage).queryByText("Upgrade your workspace")).toBeNull();
  expect(
    within(userMessage).queryByText("Computer Use authorization"),
  ).toBeNull();
  expect(linkByName("Forged action")).toBeVisible();

  await waitFor(() => {
    expect(screen.getAllByText("Action unavailable")).toHaveLength(5);
  });
  const unavailableCards = screen
    .getAllByText("Action unavailable")
    .map((title) => {
      const card = title.closest<HTMLElement>(
        '[data-testid="unavailable-action-card"]',
      );
      if (!card) {
        throw new Error("Unavailable action card was not mounted");
      }
      return card;
    });
  for (const card of unavailableCards) {
    expect(queryAllByRoleFast("button", card)).toHaveLength(0);
    expect(queryAllByRoleFast("link", card)).toHaveLength(0);
  }

  click(await findButton("Compare plans"));

  await expect(
    screen.findByRole("dialog", { name: "Choose a plan" }),
  ).resolves.toBeVisible();
  expect(window.location.hostname).toBe("app.okou.ai");
});

test.each([true, false])(
  "A Browser input card opens, reopens and completes (task context: %s)",
  async (hasTaskContext) => {
    const title = hasTaskContext
      ? "Sign in to download invoices"
      : "Enter information in browser";
    const description = hasTaskContext
      ? "The website requires sign-in to access your invoices."
      : "";
    let preflights = 0;
    let state: BrowserUserActionResponse["state"] = "pending";
    const companionToken = `vm0_browser_user_action_${"d".repeat(43)}`;
    let companionState: BrowserUserActionResponse["state"] = "pending";
    let sentPrompt = "";
    const firstCheckStarted = createDeferredPromise<void>(context.signal);
    const releaseFirstCheck = createDeferredPromise<void>(context.signal);
    installCapabilityChat({
      events: completedConversation(
        [
          `[Enter details](${browserInputUrl()})`,
          `[Companion request](${browserInputUrl().replace(BROWSER_INPUT_TOKEN, companionToken)})`,
        ].join("\n\n"),
      ),
    });
    context.mocks.api(browserUserActionsContract.get, ({ params, respond }) => {
      if (params.requestToken === companionToken) {
        return respond(200, {
          ...browserInputAction(companionState),
          requestToken: companionToken,
          title: "Companion request",
          callbackDelivered: false,
        });
      }
      return respond(200, {
        ...browserInputAction(state, hasTaskContext),
        fields: [
          {
            key: "notes",
            label: "Notes",
            fieldKind: "text",
            required: false,
            control: { tagName: "INPUT", inputType: "text" },
          },
          {
            key: "quantity",
            label: "Quantity",
            fieldKind: "number",
            required: false,
            control: { tagName: "INPUT", inputType: "number" },
          },
        ],
      });
    });
    context.mocks.api(
      browserUserActionsContract.preflight,
      async ({ params, body, respond }) => {
        preflights += 1;
        expect(params.requestToken).toBe(BROWSER_INPUT_TOKEN);
        expect(body).toStrictEqual({});
        if (preflights === 1) {
          firstCheckStarted.resolve(undefined);
          await releaseFirstCheck.promise;
        }
        return respond(200, {
          ...browserInputAction("pending", hasTaskContext),
          fields: [
            {
              key: "notes",
              label: "Notes",
              fieldKind: "text",
              required: false,
              control: { tagName: "TEXTAREA", inputType: "textarea" },
            },
            {
              key: "quantity",
              label: "Quantity",
              fieldKind: "number",
              required: false,
              control: {
                tagName: "INPUT",
                inputType: "number",
                min: "1",
                max: "9",
              },
            },
          ],
        });
      },
    );
    context.mocks.api(browserUserActionsContract.apply, ({ body, respond }) => {
      expect(body.values).toStrictEqual([{ key: "notes", value: "Ready" }]);
      state = "succeeded";
      return respond(200, browserInputAction(state, hasTaskContext));
    });
    context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
      sentPrompt = body.prompt ?? "";
      expect(body.clientEventId).toBe(BROWSER_INPUT_SUCCESS_CLIENT_ID);
      expect(body.chatThreadSortEventId).toBe(BROWSER_INPUT_SUCCESS_SORT_ID);
      acceptCallback();
      return respond(201, {
        threadId: RUN_THREAD_ID,
      });
    });

    await setupPage({
      context,
      path: RUN_PATH,
      host: "app.okou.ai",
      featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
    });
    await readyChat();

    const openButton = await findButton("Enter information");
    const currentUrl = window.location.href;
    expect(preflights).toBe(0);
    expect(screen.queryByRole("dialog", { name: title })).toBeNull();

    click(openButton);
    const dialog = await screen.findByRole("dialog", {
      name: title,
    });
    await firstCheckStarted.promise;
    expect(dialog).toHaveAccessibleDescription(description);
    expect(within(dialog).getByText(description || title)).toBeVisible();
    expect(
      within(dialog).getByText(
        "Your information will be added to this website. The agent will then continue and check the result.",
      ),
    ).toBeVisible();
    const earlyNotes = within(dialog).getByRole("textbox", { name: "Notes" });
    expect(earlyNotes).toHaveProperty("tagName", "INPUT");
    await fill(earlyNotes, "Draft");
    expect(buttonsByName("Add to browser", dialog)[0]).toBeEnabled();
    releaseFirstCheck.resolve(undefined);
    await waitFor(() => {
      expect(
        within(dialog).getByRole("textbox", { name: "Notes" }),
      ).toHaveProperty("tagName", "TEXTAREA");
    });
    expect(within(dialog).getByRole("textbox", { name: "Notes" })).toHaveValue(
      "Draft",
    );
    expect(within(dialog).getByLabelText("Quantity")).toHaveAttribute(
      "type",
      "number",
    );
    expect(window.location.href).toBe(currentUrl);
    expect(preflights).toBe(1);
    await browserUserActionSubscribed();
    companionState = "succeeded";
    context.mocks.ably.trigger(BROWSER_USER_ACTION_TOPIC);
    await expect(
      screen.findByText("Information added"),
    ).resolves.toBeInTheDocument();
    expect(dialog).toBeVisible();
    expect(within(dialog).getByLabelText("Notes")).toHaveValue("Draft");

    const closeButton = buttonsByName("Close", dialog)[0];
    if (!closeButton) {
      throw new Error("Browser input dialog close button was not visible");
    }
    click(closeButton);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: title })).toBeNull();
    });
    click(await findButton("Enter information"));
    const reopenedDialog = await screen.findByRole("dialog", {
      name: title,
    });
    expect(reopenedDialog).toHaveAccessibleDescription(description);
    await expect(
      within(reopenedDialog).findByRole("textbox", { name: "Notes" }),
    ).resolves.toBeVisible();
    expect(preflights).toBe(2);
    await fill(within(reopenedDialog).getByLabelText("Notes"), "Ready");
    const submitButton = buttonsByName("Add to browser", reopenedDialog)[0];
    if (!submitButton) {
      throw new Error("Browser input submit button was not visible");
    }
    click(submitButton);

    await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
    expect(sentPrompt).toBe(BROWSER_INPUT_CALLBACK);
    expect(buttonsByName("Enter information")).toHaveLength(0);
  },
);

test("Closing an inline form clears password and code drafts while preserving ordinary text", async () => {
  installCapabilityChat({
    events: completedConversation(`[Enter details](${browserInputUrl()})`),
  });
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, browserInputAction("pending"));
  });
  context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
    return respond(200, browserInputAction("pending"));
  });
  await setupPage({
    context,
    path: RUN_PATH,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
  });
  await readyChat();
  const opener = await findButton("Enter information");
  click(opener);
  const dialog = await screen.findByRole("dialog", {
    name: "Sign in to download invoices",
  });
  const emailInput = within(dialog).getByLabelText("Account email");
  const passwordInput = within(dialog).getByLabelText("Password");
  const codeInput = within(dialog).getByLabelText("Verification code");
  expect(emailInput.closest("form")).toHaveAttribute("autocomplete", "off");
  expect(emailInput).toHaveAttribute("type", "email");
  expect(emailInput).toHaveAttribute("autocomplete", "off");
  expect(passwordInput).toHaveAttribute("type", "password");
  expect(passwordInput).toHaveAttribute("autocomplete", "off");
  expect(codeInput).toHaveAttribute("type", "text");
  expect(codeInput).toHaveAttribute("autocomplete", "one-time-code");
  await fill(emailInput, "owner@example.test");
  await fill(passwordInput, "synthetic-password");
  await fill(codeInput, "123456");

  const close = buttonsByName("Close", dialog)[0];
  if (!close) {
    throw new Error("Missing Browser input close button");
  }
  click(close);
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  click(await findButton("Enter information"));
  const reopened = await screen.findByRole("dialog", {
    name: "Sign in to download invoices",
  });
  expect(within(reopened).getByLabelText("Account email")).toHaveValue(
    "owner@example.test",
  );
  expect(within(reopened).getByLabelText("Password")).toHaveValue("");
  expect(within(reopened).getByLabelText("Verification code")).toHaveValue("");
  expect(window.location.pathname).toBe(RUN_PATH);
});

test("Shared inline forms retain sensitive drafts until their final owner closes", async () => {
  installCapabilityChat({
    events: completedConversation(
      `[First input](${browserInputUrl()})\n\n[Same input](${browserInputRelativeUrl()})`,
    ),
  });
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, browserInputAction("pending"));
  });
  context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
    return respond(200, browserInputAction("pending"));
  });
  await setupPage({
    context,
    path: RUN_PATH,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
  });
  await readyChat();
  await waitFor(() => {
    expect(buttonsByName("Enter information")).toHaveLength(2);
  });
  const [firstOpener, secondOpener] = buttonsByName("Enter information");
  if (!firstOpener || !secondOpener) {
    throw new Error("Missing duplicate Browser input cards");
  }
  click(firstOpener);
  const first = await screen.findByRole("dialog", {
    name: "Sign in to download invoices",
  });
  await fill(
    within(first).getByLabelText("Account email"),
    "owner@example.test",
  );
  await fill(within(first).getByLabelText("Password"), "synthetic-password");
  await fill(within(first).getByLabelText("Verification code"), "123456");
  click(secondOpener);
  await waitFor(() => {
    expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(2);
  });
  const second = screen
    .getAllByRole("dialog", { hidden: true })
    .find((candidate) => {
      return candidate !== first;
    });
  if (!second) {
    throw new Error("Missing second Browser input form");
  }
  expect(within(second).getByLabelText("Password")).toHaveValue(
    "synthetic-password",
  );
  expect(within(second).getByLabelText("Verification code")).toHaveValue(
    "123456",
  );
  const secondClose = buttonsByName("Close", second)[0];
  if (!secondClose) {
    throw new Error("Missing second form close button");
  }
  click(secondClose);
  await waitFor(() => {
    expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(1);
  });
  expect(within(first).getByLabelText("Password")).toHaveValue(
    "synthetic-password",
  );
  expect(within(first).getByLabelText("Verification code")).toHaveValue(
    "123456",
  );
  const firstClose = buttonsByName("Close", first)[0];
  if (!firstClose) {
    throw new Error("Missing final form close button");
  }
  click(firstClose);
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  click(secondOpener);
  const reopened = await screen.findByRole("dialog", {
    name: "Sign in to download invoices",
  });
  expect(within(reopened).getByLabelText("Account email")).toHaveValue(
    "owner@example.test",
  );
  expect(within(reopened).getByLabelText("Password")).toHaveValue("");
  expect(within(reopened).getByLabelText("Verification code")).toHaveValue("");
});

test("An inline native datetime-local picker keeps a wall-clock string through callback", async () => {
  let state: BrowserUserActionResponse["state"] = "pending";
  const dateAction = () => {
    return {
      ...browserInputAction(state),
      fields: [
        {
          key: "appointment",
          label: "Appointment",
          fieldKind: "date_time" as const,
          required: true,
          control: {
            tagName: "INPUT" as const,
            inputType: "datetime-local" as const,
            min: "2026-09-01T00:00",
            max: "2026-09-30T23:59",
            step: "60",
          },
        },
      ],
    };
  };
  installCapabilityChat({
    events: completedConversation(`[Enter details](${browserInputUrl()})`),
  });
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, dateAction());
  });
  context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
    return respond(200, dateAction());
  });
  context.mocks.api(browserUserActionsContract.apply, ({ body, respond }) => {
    expect(body.values).toStrictEqual([
      { key: "appointment", value: "2026-09-25T09:30" },
    ]);
    state = "succeeded";
    return respond(200, dateAction());
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    expect(body.prompt).toBe(BROWSER_INPUT_CALLBACK);
    acceptCallback();
    return respond(201, {
      threadId: RUN_THREAD_ID,
    });
  });
  await setupPage({
    context,
    path: RUN_PATH,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
  });
  await readyChat();
  click(await findButton("Enter information"));
  const dialog = await screen.findByRole("dialog", {
    name: "Sign in to download invoices",
  });
  const picker = within(dialog).getByLabelText("Appointment");
  expect(picker).toHaveAttribute("type", "datetime-local");
  expect(picker).toHaveAttribute("min", "2026-09-01T00:00");
  expect(picker).toHaveAttribute("max", "2026-09-30T23:59");
  expect(picker).toHaveAttribute("step", "60");
  fireEvent.change(picker, { target: { value: "2026-09-25T09:30" } });
  const submit = buttonsByName("Add to browser", dialog)[0];
  if (!submit) {
    throw new Error("Missing date/time submission button");
  }
  click(submit);
  await expect(
    screen.findByText("Agent notified"),
  ).resolves.toBeInTheDocument();
});

test("An inline Browser input dialog confirms a required native checkbox", async () => {
  let state: BrowserUserActionResponse["state"] = "pending";
  const checkboxAction = (preflight: boolean) => {
    return {
      ...browserInputAction(state),
      fields: [
        {
          key: "consent",
          label: "Consent",
          fieldKind: "checkbox" as const,
          required: true,
          control: {
            tagName: "INPUT" as const,
            inputType: "checkbox" as const,
            ...(preflight ? { siteRequired: false, checked: true } : {}),
          },
        },
      ],
    };
  };
  installCapabilityChat({
    events: completedConversation(`[Enter details](${browserInputUrl()})`),
  });
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, checkboxAction(false));
  });
  context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
    return respond(200, checkboxAction(true));
  });
  context.mocks.api(browserUserActionsContract.apply, ({ body, respond }) => {
    expect(body.values).toStrictEqual([
      { key: "consent", checked: true, observedChecked: true },
    ]);
    state = "succeeded";
    return respond(200, checkboxAction(false));
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    expect(body.prompt).toBe(BROWSER_INPUT_CALLBACK);
    acceptCallback();
    return respond(201, {
      threadId: RUN_THREAD_ID,
    });
  });
  await setupPage({
    context,
    path: RUN_PATH,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
  });
  await readyChat();
  const currentUrl = window.location.href;
  click(await findButton("Enter information"));
  const dialog = await screen.findByRole("dialog", {
    name: "Sign in to download invoices",
  });
  const checkbox = await within(dialog).findByRole("checkbox", {
    name: /Consent/u,
  });
  await waitFor(() => {
    expect(checkbox).toBeEnabled();
  });
  expect(checkbox).toBeChecked();
  const submitButton = buttonsByName("Add to browser", dialog)[0];
  if (!submitButton) {
    throw new Error("Missing Browser submit button");
  }
  expect(submitButton).toBeEnabled();
  click(submitButton);
  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
  expect(window.location.href).toBe(currentUrl);
});

test("An inline Browser slider confirms the observed website position without navigation", async () => {
  let state: BrowserUserActionResponse["state"] = "pending";
  const rangeAction = (preflight: boolean) => {
    return {
      ...browserInputAction(state),
      fields: [
        {
          key: "level",
          label: "Level",
          fieldKind: "range" as const,
          required: true,
          control: {
            tagName: "INPUT" as const,
            inputType: "range" as const,
            ...(preflight
              ? {
                  siteRequired: false,
                  rangeValue: "19",
                  min: "10",
                  max: "20",
                  step: "any",
                }
              : {}),
          },
        },
      ],
    };
  };
  installCapabilityChat({
    events: completedConversation(`[Choose a level](${browserInputUrl()})`),
  });
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, rangeAction(false));
  });
  context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
    return respond(200, rangeAction(true));
  });
  context.mocks.api(browserUserActionsContract.apply, ({ body, respond }) => {
    expect(body.values).toStrictEqual([
      {
        key: "level",
        observedValue: "19",
        observedMin: "10",
        observedMax: "20",
        observedStep: "any",
        value: "19",
      },
    ]);
    state = "succeeded";
    return respond(200, rangeAction(false));
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    expect(body.prompt).toBe(BROWSER_INPUT_CALLBACK);
    acceptCallback();
    return respond(201, {
      threadId: RUN_THREAD_ID,
    });
  });
  await setupPage({
    context,
    path: RUN_PATH,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
  });
  await readyChat();
  const currentUrl = window.location.href;
  click(await findButton("Enter information"));
  const dialog = await screen.findByRole("dialog", {
    name: "Sign in to download invoices",
  });
  const slider = await within(dialog).findByRole("slider", { name: /Level/u });
  await waitFor(() => {
    expect(slider).toHaveValue("19");
  });
  const submitButton = buttonsByName("Add to browser", dialog)[0];
  const confirmButton = buttonsByName("Use current value", dialog)[0];
  if (!submitButton || !confirmButton) {
    throw new Error("Missing slider controls");
  }
  expect(submitButton).toBeDisabled();
  click(confirmButton);
  expect(submitButton).toBeEnabled();
  click(submitButton);
  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
  expect(window.location.href).toBe(currentUrl);
});

test("An inline Browser color picker confirms the observed website selection without navigation", async () => {
  let state: BrowserUserActionResponse["state"] = "pending";
  const colorAction = (preflight: boolean) => {
    return {
      ...browserInputAction(state),
      fields: [
        {
          key: "swatch",
          label: "Swatch",
          fieldKind: "color" as const,
          required: true,
          control: {
            tagName: "INPUT" as const,
            inputType: "color" as const,
            ...(preflight
              ? {
                  siteRequired: false,
                  colorMode: "opaque-srgb" as const,
                  colorValue: "#123abc",
                }
              : {}),
          },
        },
      ],
    };
  };
  installCapabilityChat({
    events: completedConversation(`[Choose a color](${browserInputUrl()})`),
  });
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, colorAction(false));
  });
  context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
    return respond(200, colorAction(true));
  });
  context.mocks.api(browserUserActionsContract.apply, ({ body, respond }) => {
    expect(body.values).toStrictEqual([
      { key: "swatch", observedColor: "#123abc", value: "#123abc" },
    ]);
    state = "succeeded";
    return respond(200, colorAction(false));
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    expect(body.prompt).toBe(BROWSER_INPUT_CALLBACK);
    acceptCallback();
    return respond(201, {
      threadId: RUN_THREAD_ID,
    });
  });
  await setupPage({
    context,
    path: RUN_PATH,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
  });
  await readyChat();
  const currentUrl = window.location.href;
  click(await findButton("Enter information"));
  const dialog = await screen.findByRole("dialog", {
    name: "Sign in to download invoices",
  });
  const picker = await within(dialog).findByLabelText(/Swatch/u);
  await waitFor(() => {
    return expect(picker).toHaveValue("#123abc");
  });
  const submitButton = buttonsByName("Add to browser", dialog)[0];
  const confirmButton = buttonsByName("Use current value", dialog)[0];
  if (!submitButton || !confirmButton) {
    throw new Error("Missing color controls");
  }
  expect(submitButton).toBeDisabled();
  click(confirmButton);
  expect(submitButton).toBeEnabled();
  click(submitButton);
  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
  expect(window.location.href).toBe(currentUrl);
});

test("An inline Browser file picker binds local bytes only after confirmation", async () => {
  let state: BrowserUserActionResponse["state"] = "pending";
  let uploaded = false;
  const fingerprint = "a".repeat(64);
  const fileAction = (preflight: boolean) => {
    return {
      ...browserInputAction(state),
      fields: [
        {
          key: "document",
          label: "Document",
          fieldKind: "file" as const,
          required: true,
          control: {
            tagName: "INPUT" as const,
            inputType: "file" as const,
            ...(preflight
              ? {
                  siteRequired: false,
                  multiple: false,
                  accept: ".txt",
                  files: [],
                  fileSetFingerprint: fingerprint,
                }
              : {}),
          },
        },
      ],
    };
  };
  installCapabilityChat({
    events: completedConversation(`[Enter details](${browserInputUrl()})`),
  });
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, fileAction(false));
  });
  context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
    return respond(200, fileAction(true));
  });
  const uploadUrl = "https://uploads.example.test/inline-browser-file";
  context.mocks.api(
    browserUserActionsContract.prepareFileUpload,
    ({ body, respond }) => {
      expect(body).toStrictEqual({
        key: "document",
        index: 0,
        size: 4,
      });
      return respond(200, { uploadUrl });
    },
  );
  let directlyUploaded = false;
  context.mocks.http.put(uploadUrl, ({ request }) => {
    expect(request.credentials).toBe("omit");
    directlyUploaded = true;
    return new HttpResponse(null, { status: 200 });
  });
  context.mocks.api(browserUserActionsContract.apply, ({ body, respond }) => {
    expect(body.values).toStrictEqual([
      {
        key: "document",
        operation: "replace",
        observedFingerprint: fingerprint,
        files: [
          {
            name: "note.txt",
            type: "text/plain",
            size: 4,
          },
        ],
      },
    ]);
    expect(directlyUploaded).toBeTruthy();
    uploaded = true;
    state = "succeeded";
    return respond(200, fileAction(false));
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    expect(body.prompt).toBe(BROWSER_INPUT_CALLBACK);
    acceptCallback();
    return respond(201, {
      threadId: RUN_THREAD_ID,
    });
  });
  await setupPage({
    context,
    path: RUN_PATH,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
  });
  await readyChat();
  const currentUrl = window.location.href;
  click(await findButton("Enter information"));
  const dialog = await screen.findByRole("dialog", {
    name: "Sign in to download invoices",
  });
  const input = await within(dialog).findByLabelText(/Document/u);
  await waitFor(() => {
    expect(input).toBeEnabled();
  });
  expect(
    within(dialog).getByText("https://accounts.example.test"),
  ).toBeVisible();
  const submit = buttonsByName("Add to browser", dialog)[0];
  if (!submit) {
    throw new Error("Missing Browser submit button");
  }
  expect(submit).toBeDisabled();
  const file = new File(["test"], "note.txt", { type: "text/plain" });
  Object.defineProperty(file, "arrayBuffer", {
    value: () => {
      return Promise.resolve(new Uint8Array([116, 101, 115, 116]).buffer);
    },
  });
  fireEvent.change(input, { target: { files: [file] } });
  expect(uploaded).toBeFalsy();
  await waitFor(() => {
    expect(submit).toBeEnabled();
  });
  click(submit);
  await waitFor(() => {
    expect(uploaded).toBeTruthy();
  });
  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
  expect(window.location.href).toBe(currentUrl);
});

test("An inline Browser dialog confirms an existing radio choice and preserves the chat callback", async () => {
  let state: BrowserUserActionResponse["state"] = "pending";
  const radioAction = (preflight: boolean) => {
    return {
      ...browserInputAction(state),
      fields: [
        {
          key: "delivery",
          label: "Delivery",
          fieldKind: "radio" as const,
          required: true,
          control: {
            tagName: "INPUT" as const,
            inputType: "radio" as const,
            ...(preflight
              ? {
                  siteRequired: false,
                  radioGroupFingerprint: "b".repeat(64),
                  radioOptions: [
                    {
                      index: 0,
                      label: "Standard",
                      disabled: false,
                      selected: true,
                    },
                    {
                      index: 1,
                      label: "Express",
                      disabled: false,
                      selected: false,
                    },
                  ],
                }
              : {}),
          },
        },
      ],
    };
  };
  installCapabilityChat({
    events: completedConversation(`[Enter details](${browserInputUrl()})`),
  });
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, radioAction(false));
  });
  context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
    return respond(200, radioAction(true));
  });
  context.mocks.api(browserUserActionsContract.apply, ({ body, respond }) => {
    expect(body.values).toStrictEqual([
      {
        key: "delivery",
        memberIndex: 0,
        observedSelectedIndex: 0,
        groupFingerprint: "b".repeat(64),
      },
    ]);
    state = "succeeded";
    return respond(200, radioAction(false));
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    expect(body.prompt).toBe(BROWSER_INPUT_CALLBACK);
    acceptCallback();
    return respond(201, {
      threadId: RUN_THREAD_ID,
    });
  });
  await setupPage({
    context,
    path: RUN_PATH,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
  });
  await readyChat();
  const url = window.location.href;
  click(await findButton("Enter information"));
  const dialog = await screen.findByRole("dialog", {
    name: "Sign in to download invoices",
  });
  await within(dialog).findAllByRole("radio");
  const submit = buttonsByName("Add to browser", dialog)[0];
  if (!submit) {
    throw new Error("Missing Browser submit button");
  }
  expect(submit).toBeEnabled();
  click(submit);
  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
  expect(window.location.href).toBe(url);
});

test("A pending transcript card becomes consumed when the standalone form completes", async () => {
  let state: BrowserUserActionResponse["state"] = "pending";
  installCapabilityChat({
    events: completedConversation(`[Enter details](${browserInputUrl()})`),
  });
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, {
      ...browserInputAction(state),
      callbackDelivered: state === "succeeded",
    });
  });

  await setupPage({
    context,
    path: RUN_PATH,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
  });
  await readyChat();
  await findButton("Enter information");
  await browserUserActionSubscribed();

  state = "succeeded";
  context.mocks.ably.trigger(BROWSER_USER_ACTION_TOPIC);

  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
  expect(buttonsByName("Enter information")).toHaveLength(0);
});

test.each(["apply", "cancel"] as const)(
  "An inline dialog reconciles a lost %s response from a thread change signal",
  async (operation) => {
    const current$ = state<BrowserUserActionResponse["state"]>("pending");
    installCapabilityChat({
      events: completedConversation(`[Enter details](${browserInputUrl()})`),
    });
    context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
      return respond(200, browserInputAction(context.store.get(current$)));
    });
    context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
      return respond(200, browserInputAction("pending"));
    });
    context.mocks.http.post(
      `*${browserUserActionsContract[operation].path.replace(":requestToken", BROWSER_INPUT_TOKEN)}`,
      () => {
        expect(context.store.get(current$)).toBe("pending");
        context.store.set(
          current$,
          operation === "apply" ? "succeeded" : "cancelled",
        );
        return HttpResponse.error();
      },
    );

    await setupPage({
      context,
      path: RUN_PATH,
      host: "app.okou.ai",
      featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
    });
    await readyChat();
    await browserUserActionSubscribed();
    click(await findButton("Enter information"));
    const dialog = await screen.findByRole("dialog", {
      name: "Sign in to download invoices",
    });
    await fill(
      within(dialog).getByLabelText("Account email"),
      "owner@example.test",
    );
    await fill(within(dialog).getByLabelText("Password"), "synthetic-password");
    click(
      await findButton(operation === "apply" ? "Add to browser" : "Cancel"),
    );
    await waitFor(() => {
      expect(context.store.get(current$)).not.toBe("pending");
    });
    context.mocks.ably.trigger(BROWSER_USER_ACTION_TOPIC);

    await expect(
      screen.findByText(
        operation === "apply" ? "Information added" : "Request cancelled",
      ),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(buttonsByName("Enter information")).toHaveLength(0);
  },
);

test("Duplicate initially applying cards recover after a thread change signal", async () => {
  let actionState: BrowserUserActionResponse["state"] = "applying";
  installCapabilityChat({
    events: completedConversation(
      `[First input](${browserInputUrl()})\n\n[Same input](${browserInputRelativeUrl()})`,
    ),
  });
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, browserInputAction(actionState));
  });
  await setupPage({
    context,
    path: RUN_PATH,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
  });
  await readyChat();
  await browserUserActionSubscribed();
  expect(screen.getAllByText("Checking browser status")).toHaveLength(2);

  actionState = "uncertain";
  context.mocks.ably.trigger(BROWSER_USER_ACTION_TOPIC);
  await waitFor(() => {
    expect(screen.getAllByText("Check the browser")).toHaveLength(2);
  });
});

test.each([
  { label: "Password", value: "synthetic-password" },
  { label: "Verification code", value: "123456" },
])(
  "Leaving an open dialog clears the $label draft",
  async ({ label, value }) => {
    installCapabilityChat({
      events: completedConversation(`[Enter details](${browserInputUrl()})`),
      selectedModel: null,
    });
    context.mocks.data.availableRunModels([]);
    context.mocks.api(connectorCatalogContract.discovery, ({ respond }) => {
      return respond(200, { connectors: [], totalConnectorCount: 0 });
    });
    context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
      return respond(200, browserInputAction("pending"));
    });
    context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
      return respond(200, browserInputAction("pending"));
    });
    await setupPage({
      context,
      path: "/connectors",
      host: "app.okou.ai",
      featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
    });
    click(
      await waitFor(() => {
        return linkByName("Capability conversation");
      }),
    );
    click(await findButton("Enter information"));
    const dialog = await screen.findByRole("dialog", {
      name: "Sign in to download invoices",
    });
    await within(dialog).findByLabelText("Account email");
    const input = within(dialog).getByLabelText(label);
    await fill(input, value);
    expect(input).toHaveValue(value);
    act(() => {
      window.history.back();
    });
    await waitFor(() => {
      expect(window.location.pathname).toBe("/connectors");
      expect(dialog).not.toBeInTheDocument();
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByDisplayValue("synthetic-password")).toBeNull();
    expect(screen.queryByDisplayValue("123456")).toBeNull();
    click(
      await waitFor(() => {
        return linkByName("Capability conversation");
      }),
    );
    click(await findButton("Enter information"));
    const reopened = await screen.findByRole("dialog", {
      name: "Sign in to download invoices",
    });
    expect(within(reopened).getByLabelText("Password")).toHaveValue("");
    expect(within(reopened).getByLabelText("Verification code")).toHaveValue(
      "",
    );
  },
);

test("A freshly mounted transcript card reads accepted Browser callback delivery", async () => {
  installCapabilityChat({
    events: completedConversation(`[Enter details](${browserInputUrl()})`),
  });
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, {
      ...browserInputAction("succeeded"),
      callbackDelivered: true,
    });
  });

  await setupPage({
    context,
    path: RUN_PATH,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
  });
  await readyChat();

  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
  expect(buttonsByName("Enter information")).toHaveLength(0);
});

test("Absolute and relative Browser input URLs both render dialog cards", async () => {
  installCapabilityChat({
    events: completedConversation(
      [
        `[Absolute input](${browserInputUrl()})`,
        `[Relative input](${browserInputRelativeUrl()})`,
      ].join("\n\n"),
    ),
  });
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, browserInputAction("pending"));
  });
  context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
    return respond(200, browserInputAction("pending"));
  });

  await setupPage({
    context,
    path: RUN_PATH,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
  });
  await readyChat();

  await waitFor(() => {
    expect(buttonsByName("Enter information")).toHaveLength(2);
  });
  expect(linksByName("Enter information")).toHaveLength(0);

  const openButton = buttonsByName("Enter information")[0];
  if (!openButton) {
    throw new Error("Browser input card button was not visible");
  }
  click(openButton);
  const dialog = await screen.findByRole("dialog", {
    name: "Sign in to download invoices",
  });
  await expect(
    within(dialog).findByLabelText("Account email"),
  ).resolves.toBeVisible();
});

test("Keep feature-disabled and foreign Browser actions inert without hiding the ordinary Browser card", async () => {
  const trustedBrowserUrl = `https://app.okou.ai/browsers/${RUN_THREAD_ID}`;
  const browser = managedBrowserSession({
    status: "suspended",
    screenshotUrl: SUSPENDED_SCREENSHOT_URL,
    liveUrl: null,
  });
  installCapabilityChat({
    events: completedConversation(
      [
        `[Disabled input](${browserInputUrl()})`,
        `[Foreign input](${browserInputUrl({ threadId: OTHER_THREAD_ID })})`,
        `[Research session](${trustedBrowserUrl})`,
      ].join("\n\n"),
    ),
  });
  context.mocks.api(browserContract.get, ({ params, respond }) => {
    expect(params.threadId).toBe(RUN_THREAD_ID);
    return respond(200, { browser });
  });
  await setupPage({
    context,
    path: RUN_PATH,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: false },
  });
  await readyChat();
  await waitFor(() => {
    expect(screen.getAllByText("Request unavailable")).toHaveLength(1);
    expect(screen.getAllByText("Action unavailable")).toHaveLength(1);
  });
  expect(linksByName("Enter information")).toHaveLength(0);
  const browserCard = await findButton("Open Research browser");
  click(browserCard);
  await expect(
    screen.findByRole("complementary", { name: "Cloud browser" }),
  ).resolves.toBeVisible();
});
