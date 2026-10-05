import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";
import {
  personalModelProviderAccountsByIdContract,
  personalSubscriptionsContract,
} from "@okouai/api-contracts/contracts/personal-model-providers";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const REQUEST_ID = "20000000-0000-4000-8000-000000000001";
const THREAD_ID = "30000000-0000-4000-8000-000000000001";
const PATH = `/subscriptions/${ACCOUNT_ID}/reset?idempotencyKey=${REQUEST_ID}`;
const URL = `https://app.okou.ai${PATH}`;

function subscription(
  overrides: Partial<ModelProviderResponse> = {},
): ModelProviderResponse {
  return {
    id: ACCOUNT_ID,
    type: "codex-oauth-token",
    framework: "codex",
    secretName: null,
    authMethod: "auth_json",
    secretNames: [],
    isDefault: false,
    selectedModel: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    accountEmail: "original@example.test",
    planType: "pro",
    isActive: false,
    needsReconnect: false,
    lastRefreshErrorCode: null,
    subscriptionResetSupported: true,
    subscriptionResetCredits: 3,
    subscriptionUsage: {
      fiveHour: {
        usedPercent: 100,
        remainingPercent: 0,
        resetAt: "2026-10-05T22:00:00.000Z",
        windowSeconds: 18_000,
      },
      weekly: {
        usedPercent: 40,
        remainingPercent: 60,
        resetAt: "2026-10-10T00:00:00.000Z",
        windowSeconds: 604_800,
      },
    },
    ...overrides,
  };
}

function button(
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const found = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
  if (!found) {
    throw new Error(`Missing button ${name}`);
  }
  return found;
}

async function setupChat(content: string, enabled = true) {
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "Subscription actions",
    chatEvents: [
      {
        id: "reset-request",
        role: "assistant",
        runId: "run-reset-request",
        content,
        createdAt: "2026-10-05T12:00:00.000Z",
      },
    ],
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
    featureSwitches: { subscriptionControls: enabled },
  });
}

function mockRead(account = subscription()) {
  context.mocks.api(
    personalSubscriptionsContract.get,
    ({ params, respond }) => {
      expect(params.id).toBe(ACCOUNT_ID);
      return respond(200, account);
    },
  );
}

function frame() {
  return screen.getByTestId("subscription-reset-card-shell");
}

test("a reset link displays exact-account usage and never resets before a click", async () => {
  mockRead();
  let submitted = false;
  context.mocks.api(
    personalModelProviderAccountsByIdContract.resetSubscriptionUsage,
    ({ params, body, respond }) => {
      expect(params.id).toBe(ACCOUNT_ID);
      expect(body.idempotencyKey).toBe(REQUEST_ID);
      submitted = true;
      return respond(200, { outcome: "reset" });
    },
  );
  await setupChat(`Before reset\n\n[Review reset](${URL})\n\nAfter reset`);
  await expect(
    screen.findByRole("progressbar", {
      name: "original@example.test 5h remaining",
    }),
  ).resolves.toHaveAttribute("aria-valuenow", "0");
  expect(
    screen.getByRole("progressbar", {
      name: "original@example.test Week remaining",
    }),
  ).toHaveAttribute("aria-valuenow", "60");
  expect(button("Reset")).toHaveAccessibleDescription(
    expect.stringContaining("Remaining resets: 3"),
  );
  expect(screen.getByText(/Codex · original@example.test/)).toBeInTheDocument();
  expect(submitted).toBeFalsy();
  const originalFrame = frame();
  click(button("Reset"));
  await expect(
    screen.findByText("Usage reset successfully."),
  ).resolves.toBeInTheDocument();
  expect(submitted).toBeTruthy();
  expect(button("Reset")).toBeDisabled();
  expect(frame()).toBe(originalFrame);
});

test("repeated cards share the in-flight request and refreshed remaining credits", async () => {
  let redeemed = false;
  let submissions = 0;
  const gate = context.mocks.deferred<void>();
  context.mocks.api(personalSubscriptionsContract.get, ({ respond }) => {
    return respond(
      200,
      subscription({ subscriptionResetCredits: redeemed ? 2 : 3 }),
    );
  });
  context.mocks.api(
    personalModelProviderAccountsByIdContract.resetSubscriptionUsage,
    async ({ body, respond, withSignal }) => {
      expect(body.idempotencyKey).toBe(REQUEST_ID);
      submissions += 1;
      await withSignal(gate.promise);
      redeemed = true;
      return respond(200, { outcome: "reset" });
    },
  );
  await setupChat(`${URL}\n\nThe same request:\n\n${URL}`);
  await waitFor(() => {
    expect(screen.getAllByText("Remaining resets: 3")).toHaveLength(2);
  });
  const buttons = queryAllByRoleFast("button").filter((candidate) => {
    return candidate.getAttribute("aria-label") === "Reset";
  });
  click(buttons[0]);
  click(buttons[1]);
  await waitFor(() => {
    expect(
      queryAllByRoleFast("button").filter((candidate) => {
        return candidate.getAttribute("aria-label") === "Resetting…";
      }),
    ).toHaveLength(2);
  });
  gate.resolve();
  await waitFor(() => {
    expect(screen.getAllByText("Remaining resets: 2")).toHaveLength(2);
  });
  expect(submissions).toBe(1);
  expect(screen.getAllByText("Usage reset successfully.")).toHaveLength(2);
});

test("the direct URL opens an authenticated reset page and still requires a click", async () => {
  mockRead();
  let submitted = false;
  context.mocks.api(
    personalModelProviderAccountsByIdContract.resetSubscriptionUsage,
    ({ params, respond }) => {
      expect(params.id).toBe(ACCOUNT_ID);
      submitted = true;
      return respond(200, { outcome: "alreadyRedeemed" });
    },
  );
  await setupPage({
    context,
    path: PATH,
    host: "app.okou.ai",
    featureSwitches: { subscriptionControls: true },
  });
  await screen.findByText("Remaining resets: 3");
  expect(submitted).toBeFalsy();
  click(button("Reset"));
  await expect(
    screen.findByText("This reset request has already been redeemed."),
  ).resolves.toBeInTheDocument();
  expect(submitted).toBeTruthy();
});

test("an uncertain last-credit request can be retried only with its original idempotency key", async () => {
  const keys: string[] = [];
  context.mocks.api(personalSubscriptionsContract.get, ({ respond }) => {
    return respond(
      200,
      subscription({ subscriptionResetCredits: keys.length === 0 ? 1 : 0 }),
    );
  });
  context.mocks.api(
    personalModelProviderAccountsByIdContract.resetSubscriptionUsage,
    ({ body, respond }) => {
      keys.push(body.idempotencyKey);
      return keys.length === 1
        ? respond(500, {
            error: { code: "INTERNAL_SERVER_ERROR", message: "Response lost" },
          })
        : respond(200, { outcome: "alreadyRedeemed" });
    },
  );
  await setupChat(URL);
  await screen.findByText("Remaining resets: 1");
  click(button("Reset"));
  await screen.findByText(
    "Reset failed. Refresh or retry with the same request.",
  );
  await screen.findByText("Remaining resets: 0");
  await waitFor(() => {
    expect(button("Reset")).toBeEnabled();
  });
  click(button("Reset"));
  await expect(
    screen.findByText("This reset request has already been redeemed."),
  ).resolves.toBeInTheDocument();
  expect(keys).toStrictEqual([REQUEST_ID, REQUEST_ID]);
});

test.each([
  {
    name: "Claude Code",
    overrides: {
      type: "claude-code-oauth-token" as const,
      framework: "claude-code" as const,
      subscriptionResetSupported: false,
    },
    notice: "Manual reset is not supported; usage recovers naturally.",
    hasButton: false,
  },
  {
    name: "no credit",
    overrides: { subscriptionResetCredits: 0 },
    notice: "No reset credits are available.",
    hasButton: true,
  },
  {
    name: "reconnect",
    overrides: { needsReconnect: true },
    notice: "Reconnect this subscription in Personal Models.",
    hasButton: true,
  },
])(
  "the $name state cannot submit a reset",
  async ({ overrides, notice, hasButton }) => {
    mockRead(subscription(overrides));
    await setupChat(URL);
    await expect(screen.findByText(notice)).resolves.toBeInTheDocument();
    const resets = queryAllByRoleFast("button").filter((candidate) => {
      return candidate.getAttribute("aria-label") === "Reset";
    });
    expect(
      resets.map((candidate) => {
        return candidate.hasAttribute("disabled");
      }),
    ).toStrictEqual(hasButton ? [true] : []);
  },
);

test("Claude Code recovery details never advertise manual reset credits or confirmation", async () => {
  mockRead(
    subscription({
      type: "claude-code-oauth-token",
      framework: "claude-code",
      subscriptionResetSupported: false,
    }),
  );
  await setupChat(URL);
  const notice = "Manual reset is not supported; usage recovers naturally.";
  await screen.findByText(notice);
  click(button("original@example.test 5h remaining"));
  const details = within(await screen.findByRole("dialog"));
  expect(details.queryByText("Remaining resets: 3")).not.toBeInTheDocument();
  expect(
    details.queryByText(/Only clicking Reset submits the request/),
  ).not.toBeInTheDocument();
  expect(details.getByText(notice)).toBeInTheDocument();
});

test("a delayed unavailable read keeps the mounted frame and content row through refresh", async () => {
  const gate = context.mocks.deferred<void>();
  let missing = true;
  context.mocks.api(
    personalSubscriptionsContract.get,
    async ({ respond, withSignal }) => {
      await withSignal(gate.promise);
      return missing
        ? respond(404, {
            error: { code: "NOT_FOUND", message: "Account disconnected" },
          })
        : respond(200, subscription());
    },
  );
  await setupChat(`Before\n\n${URL}\n\nAfter`);
  await screen.findByText("Loading subscription…");
  const originalFrame = frame();
  const row = screen.getByTestId("subscription-reset-card");
  expect(row).toHaveAttribute("aria-busy", "true");
  expect(originalFrame).toHaveClass("h-[136px]", "@[640px]:h-[88px]");
  gate.resolve();
  await screen.findByText(
    "This subscription is unavailable in the current workspace.",
  );
  expect(frame()).toBe(originalFrame);
  expect(screen.getByTestId("subscription-reset-card")).toBe(row);
  missing = false;
  click(button("Refresh"));
  await screen.findByText("Remaining resets: 3");
  expect(frame()).toBe(originalFrame);
  expect(screen.getByTestId("subscription-reset-card")).toBe(row);
});

test("usage rings open accessible recovery and expiry details outside the fixed frame", async () => {
  mockRead(
    subscription({
      subscriptionResetCreditsNextExpiresAt: "2030-10-12T00:00:00.000Z",
    }),
  );
  await setupChat(URL);
  await screen.findByText("Remaining resets: 3");
  const originalFrame = frame();
  click(button("original@example.test 5h remaining"));
  await screen.findByText("0% left");
  expect(screen.getByText(/Credits expire:/)).toBeInTheDocument();
  expect(
    within(screen.getByRole("dialog")).getByText(
      /Only clicking Reset submits the request/,
    ),
  ).toBeInTheDocument();
  expect(originalFrame.contains(screen.getByText("0% left"))).toBeFalsy();
  expect(frame()).toBe(originalFrame);
});

test("unknown usage still exposes credit details without inventing zero quota", async () => {
  mockRead(subscription({ subscriptionUsage: null }));
  await setupChat(URL);
  await screen.findByText("Remaining resets: 3");
  for (const ring of screen.getAllByRole("progressbar")) {
    expect(ring).not.toHaveAttribute("aria-valuenow");
  }
  click(button("original@example.test 5h remaining"));
  await expect(screen.findByText("--")).resolves.toBeInTheDocument();
  expect(
    within(screen.getByRole("dialog")).getByText("Remaining resets: 3"),
  ).toBeInTheDocument();
});

test("pending reset and failed usage refresh retain the same row and prevent unsafe submission", async () => {
  const gate = context.mocks.deferred<void>();
  let failure = false;
  context.mocks.api(personalSubscriptionsContract.get, ({ respond }) => {
    return failure
      ? respond(500, {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Usage lookup unavailable",
          },
        })
      : respond(200, subscription());
  });
  context.mocks.api(
    personalModelProviderAccountsByIdContract.resetSubscriptionUsage,
    async ({ respond, withSignal }) => {
      await withSignal(gate.promise);
      return respond(200, { outcome: "nothingToReset" });
    },
  );
  await setupChat(URL);
  await screen.findByText("Remaining resets: 3");
  const originalFrame = frame();
  const row = screen.getByTestId("subscription-reset-card");
  failure = true;
  click(button("Refresh"));
  await screen.findByText("Could not read subscription usage.");
  expect(
    queryAllByRoleFast("button").filter((candidate) => {
      return candidate.getAttribute("aria-label") === "Reset";
    }),
  ).toHaveLength(0);
  expect(frame()).toBe(originalFrame);
  expect(screen.getByTestId("subscription-reset-card")).toBe(row);
  failure = false;
  click(button("Refresh"));
  await waitFor(() => {
    expect(button("Reset")).toBeEnabled();
  });
  click(button("Reset"));
  await waitFor(() => {
    expect(button("Resetting…")).toBeDisabled();
  });
  expect(row).toHaveAttribute("aria-busy", "true");
  expect(frame()).toBe(originalFrame);
  gate.resolve();
  await waitFor(() => {
    expect(row).toHaveAttribute("aria-busy", "false");
  });
  await screen.findByText("There is no exhausted usage window to reset.");
  expect(row).toHaveAttribute("aria-busy", "false");
  expect(frame()).toBe(originalFrame);
  expect(screen.getByTestId("subscription-reset-card")).toBe(row);
});

test("disabled rollout renders an inert card rather than performing a reset", async () => {
  await setupChat(URL, false);
  await screen.findByText(
    "This subscription is unavailable in the current workspace.",
  );
  expect(
    queryAllByRoleFast("button").filter((candidate) => {
      return candidate.getAttribute("aria-label") === "Reset";
    }),
  ).toHaveLength(0);
});

test("untrusted reset URLs and code examples stay ordinary message content", async () => {
  await setupChat(
    `Example only\n\n\`${URL}\`\n\nhttps://evil.example/subscriptions/${ACCOUNT_ID}/reset?idempotencyKey=${REQUEST_ID}`,
  );
  await screen.findByText("Example only");
  expect(
    screen.queryByTestId("subscription-reset-card-shell"),
  ).not.toBeInTheDocument();
});
