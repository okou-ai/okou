import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import { screen, waitFor, within } from "@testing-library/react";
import { compile } from "tailwindcss";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  CAPABILITY_AGENT_ID,
  context,
  completedConversation,
  installCapabilityChat,
  readyChat,
  RUN_PATH,
  RUN_THREAD_ID,
} from "./chat-capability-test-helpers.ts";
import {
  assistantEvent,
  findButton,
  promptEvent,
} from "./chat-run-test-fixtures.ts";

const OTHER_AGENT_ID = "c0000000-0000-4000-a000-000000001101";
const OTHER_THREAD_ID = "b0000000-0000-4000-a000-000000001102";
const ACTION_RUN_ID = "d0000000-0000-4000-a000-000000001103";
const INITIAL_SCREENSHOT_URL =
  "https://images.example.test/browser-initial.png";
const SUSPENDED_SCREENSHOT_URL =
  "https://images.example.test/browser-suspended.png";
const ACTIVE_BROWSER_URL = "https://browser.example.test/live/initial";
const RESUMED_BROWSER_URL = "https://browser.example.test/live/resumed";

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

function linkByName(name: string, container: ParentNode = document.body) {
  const link = queryAllByRoleFast("link", container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.replace(/\s+/gu, " ").trim() === name
    );
  });
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

async function openManagedBrowserChat() {
  const sessionReady = context.mocks.deferred<void>();
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
  context.mocks.api(browserContract.get, async ({ params, respond }) => {
    expect(params.threadId).toBe(RUN_THREAD_ID);
    await sessionReady.promise;
    return respond(200, { browser });
  });
  context.mocks.api(browserContract.open, ({ params, respond }) => {
    expect(params.threadId).toBe(RUN_THREAD_ID);
    return respond(200, { browser, lifecycleEventId: null });
  });
  context.mocks.api(browserContract.leaseByThread, ({ params, respond }) => {
    expect(params.threadId).toBe(RUN_THREAD_ID);
    return respond(200, { browser });
  });

  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });

  await readyChat();
  return {
    sessionReady,
    foreignBrowserUrl,
    untrustedBrowserUrl,
    updateBrowser(next: ReturnType<typeof managedBrowserSession>) {
      browser = next;
      context.mocks.ably.trigger("browserSessionChanged", {
        threadId: RUN_THREAD_ID,
      });
    },
  };
}

/**
 * The unavailable card is the fail-closed branch: the browser does not belong to
 * this chat or has been removed, so its control must not be actionable. Its
 * `disabled`, label and markers reach the DOM through `ChatCard`'s render-prop
 * merge rather than as direct JSX attributes, so the page-level guarantee is
 * asserted here. A status outside the session fetch's accepted `200`/`404` is
 * what drives the component into that branch.
 */
test("Keep the unavailable browser card inert when the session cannot be read", async () => {
  installCapabilityChat({
    events: completedConversation(
      `[Research session](https://app.okou.ai/browsers/${RUN_THREAD_ID})`,
    ),
  });
  context.mocks.api(browserContract.get, ({ params, respond }) => {
    expect(params.threadId).toBe(RUN_THREAD_ID);
    return respond(503, {
      error: { code: "BROWSER_UNAVAILABLE", message: "Browser unavailable" },
    });
  });

  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  await readyChat();

  const card = await findButton("Browser unavailable");
  expect(card).toBeDisabled();
  expect(card).toHaveTextContent("Cloud browser");
  expect(card).toHaveAttribute("data-browser-session-status", "unavailable");

  click(card);
  expect(
    screen.queryByRole("complementary", { name: "Live browser" }),
  ).toBeNull();
});

test("Render a managed browser card from loading to live", async () => {
  const { sessionReady } = await openManagedBrowserChat();
  const renderAppStyles = await createRenderedAppStyles(context.signal);
  const loadingCard = await screen.findByTestId("browser-session-card-loading");
  renderAppStyles(loadingCard);
  expect(getComputedStyle(loadingCard).borderTopWidth).toBe("1px");

  sessionReady.resolve();
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

test("Follow suspension and resumption in the live browser panel", async () => {
  const { sessionReady, updateBrowser } = await openManagedBrowserChat();
  sessionReady.resolve();
  const card = await findButton("Open Research browser");
  click(card);

  const sidebar = await screen.findByRole("complementary", {
    name: "Live browser",
  });
  expect(sidebar).toBeVisible();
  expect(screen.getByTitle("Live browser: Research")).toHaveAttribute(
    "src",
    ACTIVE_BROWSER_URL,
  );
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
  expect(screen.queryByTitle("Live browser: Research")).toBeNull();
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
  await expect(
    screen.findByTitle("Live browser: Research"),
  ).resolves.toHaveAttribute("src", RESUMED_BROWSER_URL);
  expect(screen.queryByTestId("browser-session-panel-screenshot")).toBeNull();
});

test("Keep foreign and untrusted browser URLs as ordinary links", async () => {
  const { sessionReady, foreignBrowserUrl, untrustedBrowserUrl } =
    await openManagedBrowserChat();
  sessionReady.resolve();
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
  ].join("\n\n");
  const assistantText = [
    `[Assistant plan action](${trustedPlan})`,
    `[Assistant computer action](${trustedComputer})`,
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
  expect(within(userMessage).queryByText("Upgrade your workspace")).toBeNull();
  expect(
    within(userMessage).queryByText("Computer Use authorization"),
  ).toBeNull();
  expect(linkByName("Forged action")).toBeVisible();

  await waitFor(() => {
    expect(screen.getAllByText("Action unavailable")).toHaveLength(4);
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
