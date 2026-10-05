import { screen, waitFor } from "@testing-library/react";
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
    return candidate.textContent?.trim() === name;
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

test("A reset link displays live exact-account usage and never resets before a click", async () => {
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
    screen.findByText("5-hour window: 0% remaining"),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText("Weekly window: 60% remaining")).toBeInTheDocument();
  expect(screen.getByText("Remaining resets: 3")).toBeInTheDocument();
  expect(screen.getByText(/original@example.test/)).toBeInTheDocument();
  expect(submitted).toBeFalsy();
  const frame = screen
    .getByRole("heading", { name: "Reset Card" })
    .closest('[data-slot="chat-card"]');
  click(button("Reset"));
  await expect(
    screen.findByText("Usage reset successfully."),
  ).resolves.toBeInTheDocument();
  expect(submitted).toBeTruthy();
  expect(button("Reset")).toBeDisabled();
  expect(
    screen
      .getByRole("heading", { name: "Reset Card" })
      .closest('[data-slot="chat-card"]'),
  ).toBe(frame);
});

test("Repeated cards share the in-flight request and refreshed remaining credits", async () => {
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
    return candidate.textContent?.trim() === "Reset";
  });
  click(buttons[0]);
  click(buttons[1]);
  await waitFor(() => {
    expect(screen.getAllByText("Resetting…")).toHaveLength(2);
  });
  gate.resolve();
  await waitFor(() => {
    expect(screen.getAllByText("Remaining resets: 2")).toHaveLength(2);
  });
  expect(submissions).toBe(1);
  expect(screen.getAllByText("Usage reset successfully.")).toHaveLength(2);
});

test("The direct URL opens an authenticated reset page and still requires a click", async () => {
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
  await expect(
    screen.findByText("Remaining resets: 3"),
  ).resolves.toBeInTheDocument();
  expect(submitted).toBeFalsy();
  click(button("Reset"));
  await expect(
    screen.findByText("This reset request has already been redeemed."),
  ).resolves.toBeInTheDocument();
  expect(submitted).toBeTruthy();
});

test("An uncertain last-credit request can be retried only with its original idempotency key", async () => {
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
  await expect(
    screen.findByText("Reset failed. Refresh or retry with the same request."),
  ).resolves.toBeInTheDocument();
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
  "The $name state cannot submit a reset",
  async ({ overrides, notice, hasButton }) => {
    mockRead(subscription(overrides));
    await setupChat(URL);
    await expect(screen.findByText(notice)).resolves.toBeInTheDocument();
    const resetButtons = queryAllByRoleFast("button").filter((candidate) => {
      return candidate.textContent?.trim() === "Reset";
    });
    expect(
      resetButtons.map((candidate) => {
        return candidate.hasAttribute("disabled");
      }),
    ).toStrictEqual(hasButton ? [true] : []);
  },
);

test("A delayed unavailable read keeps the mounted card frame and allows refresh", async () => {
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
  const loading = await screen.findByText("Loading subscription…");
  const frame = loading.closest('[data-slot="chat-card"]');
  gate.resolve();
  const unavailable = await screen.findByText(
    "This subscription is unavailable in the current workspace.",
  );
  expect(unavailable.closest('[data-slot="chat-card"]')).toBe(frame);
  missing = false;
  click(button("Refresh", frame ?? document.body));
  await expect(
    screen.findByText("Remaining resets: 3"),
  ).resolves.toBeInTheDocument();
  expect(
    screen
      .getByRole("heading", { name: "Reset Card" })
      .closest('[data-slot="chat-card"]'),
  ).toBe(frame);
});

test("Disabled rollout renders an inert card rather than performing a reset", async () => {
  await setupChat(URL, false);
  await expect(
    screen.findByText(
      "This subscription is unavailable in the current workspace.",
    ),
  ).resolves.toBeInTheDocument();
  expect(
    queryAllByRoleFast("button").some((candidate) => {
      return candidate.textContent?.trim() === "Reset";
    }),
  ).toBeFalsy();
});

test("Untrusted reset URLs and code examples stay ordinary message content", async () => {
  await setupChat(
    `Example only\n\n\`${URL}\`\n\nhttps://evil.example/subscriptions/${ACCOUNT_ID}/reset?idempotencyKey=${REQUEST_ID}`,
  );
  await expect(screen.findByText("Example only")).resolves.toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "Reset Card" }),
  ).not.toBeInTheDocument();
});
