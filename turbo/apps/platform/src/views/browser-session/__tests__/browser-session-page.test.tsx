import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import { chatThreadByIdContract } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockBrowserCdp } from "../../../__tests__/browser-cdp-fixture.ts";

const context = testContext();
const THREAD_ID = "11111111-1111-4111-8111-111111111111";

function browserSession(
  overrides: Partial<BrowserSession> = {},
): BrowserSession {
  return {
    threadId: THREAD_ID,
    name: "booking",
    status: "active",
    viewerUrl: `https://viewer.example/browsers/${THREAD_ID}`,
    liveUrl: "https://viewer.example/live?token=private",
    screenshotUrl: null,
    proxyCountryCode: null,
    timeoutMinutes: 240,
    screen: { width: 1440, height: 900, resizable: true },
    idleExpiresAt: "2026-09-01T10:10:00.000Z",
    suspendedAt: null,
    suspensionReason: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

function mockBrowserSession(session: BrowserSession | null): void {
  context.mocks.api(browserContract.get, ({ respond }) => {
    return session
      ? respond(200, { browser: session })
      : respond(404, {
          error: { code: "NOT_FOUND", message: "Browser not found" },
        });
  });
}

function getButton(name: string): HTMLButtonElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${name}`);
  }
  return button;
}

async function openViewerSizingMenu(): Promise<HTMLElement> {
  click(screen.getByLabelText("Browser menu"));
  const menu = await screen.findByRole("menu", { name: "Browser menu" });
  click(within(menu).getByText("Fit to this viewer"));
  return screen.findByRole("menu", { name: "Fit to this viewer" });
}

async function setupInteractiveViewerSizingMenu(): Promise<HTMLElement> {
  const activeSession = browserSession();
  const cdpUrl = "wss://cdp.browser-use.com/test";
  mockBrowserSession(activeSession);
  mockBrowserCdp(context, cdpUrl);
  context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
    return respond(200, { cdpUrl });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: activeSession });
  });

  await setupPage({
    context,
    path: `/browsers/${THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.BrowserCdpViewer]: true },
  });

  await expect(
    screen.findByRole("region", { name: "Remote browser viewer" }),
  ).resolves.toBeInTheDocument();
  await expect(
    screen.findByDisplayValue("https://example.com"),
  ).resolves.toBeEnabled();
  expect(screen.getByLabelText("New tab")).toBeInTheDocument();
  expect(screen.queryByTitle("Cloud browser: booking")).not.toBeInTheDocument();
  const sizingMenu = await openViewerSizingMenu();
  expect(within(sizingMenu).getByText("Sync continuously")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  return sizingMenu;
}

async function selectViewerSizingOption(
  sizingMenu: HTMLElement,
  label: string,
): Promise<HTMLElement> {
  const option = within(sizingMenu).getByText(label);
  expect(option).not.toHaveAttribute("aria-disabled", "true");
  click(option);
  await waitFor(() => {
    expect(sizingMenu).not.toBeInTheDocument();
  });
  const updatedMenu = await openViewerSizingMenu();
  expect(within(updatedMenu).getByText(label)).toHaveAttribute(
    "aria-checked",
    "true",
  );
  return updatedMenu;
}

test("An accessible conversation without a browser can start one", async () => {
  mockBrowserSession(null);

  await setupPage({ context, path: `/browsers/${THREAD_ID}` });

  await expect(screen.findByText("Browser not live")).resolves.toBeVisible();
  expect(getButton("Start browser")).toBeEnabled();
  expect(screen.queryByText("Browser not found")).toBeNull();
});

test("An active browser shows a private live viewer", async () => {
  const activeSession = browserSession();
  let leaseCount = 0;
  let connectionCount = 0;
  context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
    connectionCount += 1;
    return respond(200, { cdpUrl: "wss://cdp.browser-use.com/test" });
  });
  mockBrowserSession(activeSession);
  context.mocks.api(browserContract.leaseByThread, ({ params, respond }) => {
    if (params.threadId === THREAD_ID) {
      leaseCount += 1;
    }
    return respond(200, { browser: activeSession });
  });

  await setupPage({ context, path: `/browsers/${THREAD_ID}` });

  const viewer = await screen.findByTitle("Cloud browser: booking");
  expect(viewer).toHaveAttribute(
    "src",
    "https://viewer.example/live?token=private",
  );
  expect(viewer).toHaveAttribute("referrerpolicy", "no-referrer");
  await waitFor(() => {
    expect(leaseCount).toBeGreaterThan(0);
  });
  expect(connectionCount).toBe(0);
});

test("The viewer switch replaces the provider iframe with the interactive Okou viewer", async () => {
  const sizingMenu = await setupInteractiveViewerSizingMenu();
  expect(
    within(sizingMenu).getByText("Do not sync automatically"),
  ).toHaveAttribute("aria-checked", "false");
  await selectViewerSizingOption(sizingMenu, "Do not sync automatically");
});

test("The browser viewer keeps one-time sizing after automatic sizing is disabled", async () => {
  const sizingMenu = await setupInteractiveViewerSizingMenu();
  const disabledSizingMenu = await selectViewerSizingOption(
    sizingMenu,
    "Do not sync automatically",
  );
  expect(
    within(disabledSizingMenu).getByText("Sync once on opening"),
  ).toHaveAttribute("aria-checked", "false");
  await selectViewerSizingOption(disabledSizingMenu, "Sync once on opening");
});

test("The browser viewer resumes continuous sizing after one-time sizing", async () => {
  const sizingMenu = await setupInteractiveViewerSizingMenu();
  const oneTimeSizingMenu = await selectViewerSizingOption(
    sizingMenu,
    "Sync once on opening",
  );
  expect(
    within(oneTimeSizingMenu).getByText("Sync continuously"),
  ).toHaveAttribute("aria-checked", "false");
  await selectViewerSizingOption(oneTimeSizingMenu, "Sync continuously");
});

test("A reclaimed connection shows an unavailable state without opening the provider iframe", async () => {
  mockBrowserSession(browserSession());
  context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
    return respond(409, {
      error: { code: "BROWSER_NOT_LIVE", message: "Browser is no longer live" },
    });
  });
  await setupPage({
    context,
    path: `/browsers/${THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.BrowserCdpViewer]: true },
  });
  await expect(
    screen.findByText("Browser unavailable"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByTitle("Cloud browser: booking")).not.toBeInTheDocument();
});

test("A replacement browser detaches the previous viewer while its connection loads", async () => {
  let currentSession = browserSession();
  let replacing = false;
  const connectionStarted = context.mocks.deferred<void>();
  const releaseConnection = context.mocks.deferred<void>();
  const cdpUrl = "wss://cdp.browser-use.com/original";
  mockBrowserCdp(context, cdpUrl);
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, { browser: currentSession });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: currentSession });
  });
  context.mocks.api(browserContract.viewerConnection, async ({ respond }) => {
    if (!replacing) {
      return respond(200, { cdpUrl });
    }
    connectionStarted.resolve();
    await releaseConnection.promise;
    return respond(409, {
      error: { code: "BROWSER_NOT_LIVE", message: "Browser is no longer live" },
    });
  });
  await setupPage({
    context,
    path: `/browsers/${THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.BrowserCdpViewer]: true },
  });
  await expect(
    screen.findByDisplayValue("https://example.com"),
  ).resolves.toBeEnabled();
  const previousViewer = screen.getByRole("region", {
    name: "Remote browser viewer",
  });
  currentSession = browserSession({
    liveUrl: "https://viewer.example/live?token=replacement",
  });
  replacing = true;
  act(() => {
    context.mocks.ably.trigger("browserSessionChanged", {
      threadId: THREAD_ID,
    });
  });
  await connectionStarted.promise;
  await waitFor(() => {
    expect(previousViewer).not.toBeInTheDocument();
  });
  expect(screen.queryByTitle("Cloud browser: booking")).not.toBeInTheDocument();
  releaseConnection.resolve();
  await expect(
    screen.findByText("Browser unavailable"),
  ).resolves.toBeInTheDocument();
});

test("An inaccessible conversation has no browser page", async () => {
  mockBrowserSession(null);
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Conversation not found" },
    });
  });

  await setupPage({ context, path: `/browsers/${THREAD_ID}` });

  await expect(screen.findByText("Browser not found")).resolves.toBeVisible();
  expect(screen.queryByText("Start browser")).toBeNull();
});

test("A user can restart a reclaimed browser", async () => {
  const activeSession = browserSession();
  let startCount = 0;
  mockBrowserSession(
    browserSession({
      status: "suspended",
      liveUrl: null,
      screen: undefined,
      idleExpiresAt: null,
      suspendedAt: "2026-09-01T10:10:00.000Z",
      suspensionReason: "idle",
    }),
  );
  context.mocks.api(browserContract.open, ({ params, respond }) => {
    if (params.threadId === THREAD_ID) {
      startCount += 1;
    }
    return respond(200, { browser: activeSession });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: activeSession });
  });

  await setupPage({ context, path: `/browsers/${THREAD_ID}` });

  await expect(screen.findByText("Browser not live")).resolves.toBeVisible();
  click(getButton("Start browser"));

  await expect(
    screen.findByTitle("Cloud browser: booking"),
  ).resolves.toBeVisible();
  expect(startCount).toBe(1);
  expect(screen.queryByText("Browser not live")).toBeNull();
});
