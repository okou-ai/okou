import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import { chatThreadByIdContract } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

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
  mockBrowserSession(activeSession);
  context.mocks.api(browserContract.leaseByThread, ({ params, respond }) => {
    if (params.threadId === THREAD_ID) {
      leaseCount += 1;
    }
    return respond(200, { browser: activeSession });
  });

  await setupPage({ context, path: `/browsers/${THREAD_ID}` });

  const viewer = await screen.findByTitle("Live browser: booking");
  expect(viewer).toHaveAttribute(
    "src",
    "https://viewer.example/live?token=private",
  );
  expect(viewer).toHaveAttribute("referrerpolicy", "no-referrer");
  await waitFor(() => {
    expect(leaseCount).toBeGreaterThan(0);
  });
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
    return respond(200, { browser: activeSession, lifecycleEventId: null });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: activeSession });
  });

  await setupPage({ context, path: `/browsers/${THREAD_ID}` });

  await expect(screen.findByText("Browser not live")).resolves.toBeVisible();
  click(getButton("Start browser"));

  await expect(
    screen.findByTitle("Live browser: booking"),
  ).resolves.toBeVisible();
  expect(startCount).toBe(1);
  expect(screen.queryByText("Browser not live")).toBeNull();
});
