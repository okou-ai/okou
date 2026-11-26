import {
  billingCreditCheckoutContract,
  type CreditCheckoutRequest,
  billingStatusContract,
} from "@okouai/api-contracts/contracts/billing";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { screen, within, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { accountModels } from "./chat-account-model-fixture.ts";
import {
  click,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import {
  billingPlanCapabilities,
  defaultBillingStatus,
} from "../../../mocks/handlers/api-billing.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  createChatRunFixtures,
  findEnabledButton,
  promptEvent,
  publishRunUpdate,
  queryButton,
  readyChat,
  RUN_PATH,
  RUN_THREAD_ID,
  sendText,
} from "./chat-run-test-fixtures.ts";

import { packages } from "./workspace-billing-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);
const BLOCKED_PROMPT = "Summarize this week's sales calls";
const BLOCKED_RUN_ID = "d0000000-0000-4000-a000-000000000b01";

interface Workspace {
  tier: "limited-free-1" | "pro";
  credits: number;
}

function arrangeWorkspace(
  role: "admin" | "member",
  initial: Workspace,
  overrides: { canBuyCredits?: boolean } = {},
): Workspace {
  const workspace = { ...initial };
  packages(context);
  context.mocks.data.org({ id: "org_billing", name: "Sales Org", role });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, {
      ...defaultBillingStatus(),
      tier: workspace.tier,
      ...billingPlanCapabilities(workspace.tier),
      credits: workspace.credits,
      ...overrides,
    });
  });
  return workspace;
}

function blockedRun(error: "insufficient_credits" | "pro_required"): {
  readonly events: MockChatEventInput[];
} {
  return {
    events: [
      promptEvent({
        id: "e0000000-0000-4000-a000-000000000b01",
        runId: BLOCKED_RUN_ID,
        seqId: 1,
        text: BLOCKED_PROMPT,
        createdAt: "2026-11-20T07:50:00.000Z",
      }),
      {
        id: "e0000000-0000-4000-a000-000000000b02",
        role: "assistant",
        content: null,
        error,
        runId: BLOCKED_RUN_ID,
        seqId: 2,
        createdAt: "2026-11-20T07:50:01.000Z",
      },
    ],
  };
}

async function openBlockedChat(
  error: "insufficient_credits" | "pro_required",
): Promise<MockChatEventInput[]> {
  const { events } = blockedRun(error);
  installRunChat({ chatEvents: events });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  await expect(screen.findByText(BLOCKED_PROMPT)).resolves.toBeInTheDocument();
  return events;
}

async function upgradeToPro(): Promise<HTMLElement> {
  click(await findEnabledButton("Upgrade to Pro"));
  const plans = await screen.findByRole("dialog", { name: "Choose a plan" });
  click(await findEnabledButton("Start with Pro", plans));
  return await screen.findByRole("dialog", {
    name: "Configure member packages",
  });
}

test("Let a free workspace admin choose a small top-up or the Pro plans flow", async () => {
  arrangeWorkspace("admin", { tier: "limited-free-1", credits: 0 });
  const checkoutRequests: CreditCheckoutRequest[] = [];
  context.mocks.api(
    billingCreditCheckoutContract.create,
    ({ body, respond }) => {
      checkoutRequests.push(body);
      return respond(200, {
        status: "preview",
        credits: body.credits,
        amountCents: body.credits / 10,
        currency: "usd",
        expiresAt: "2026-12-01T00:10:00.000Z",
        previewToken: `credit-preview-${String(checkoutRequests.length)}`,
      });
    },
  );
  await openBlockedChat("insufficient_credits");
  const frame = await screen.findByTestId("assistant-error-card-shell");
  await expect(
    within(frame).findByText(
      "Add credits from $5 to keep going, or upgrade to Pro to unlock exclusive features.",
    ),
  ).resolves.toBeInTheDocument();
  expect(
    queryAllByRoleFast("button", frame).map((button) => {
      return button.textContent?.trim();
    }),
  ).toStrictEqual(["$5", "$10", "Upgrade to Pro"]);
  for (const dollars of [5, 10]) {
    click(await findEnabledButton(`$${String(dollars)}`, frame));
    const review = await screen.findByRole("dialog", {
      name: "Review credit purchase",
    });
    expect(
      within(review).getByText(`$${dollars.toFixed(2)}`),
    ).toBeInTheDocument();
    expect(checkoutRequests.at(-1)).toMatchObject({
      credits: dollars * 1000,
      supportsInAppPreview: true,
    });
    click(await findEnabledButton("Cancel", review));
    await waitFor(() => {
      expect(review).not.toBeInTheDocument();
    });
  }
  const configuration = await upgradeToPro();
  expect(within(configuration).getByText("Step 2 of 2")).toBeInTheDocument();
  click(within(configuration).getByLabelText("Close"));
  await waitFor(() => {
    expect(configuration).not.toBeInTheDocument();
  });
  expect(screen.getByRole("textbox", { name: "Message" })).toBeInTheDocument();
});

test("Let a paid workspace admin keep their existing top-up choices", async () => {
  arrangeWorkspace("admin", { tier: "pro", credits: 0 });
  await openBlockedChat("insufficient_credits");
  const frame = await screen.findByTestId("assistant-error-card-shell");
  await expect(
    within(frame).findByText("Add credits to keep chatting with Okou."),
  ).resolves.toBeInTheDocument();
  expect(
    queryAllByRoleFast("button", frame).map((button) => {
      return button.textContent?.trim();
    }),
  ).toStrictEqual(["$100", "$200", "$300", "Custom", "Buy"]);
  click(await findEnabledButton("Custom", frame));
  await expect(
    screen.findByRole("textbox", { name: "Custom dollar amount" }),
  ).resolves.toBeInTheDocument();
});

test("A free workspace can recover from a Pro-only rejection even when top-ups are available", async () => {
  arrangeWorkspace(
    "admin",
    { tier: "limited-free-1", credits: 500 },
    { canBuyCredits: true },
  );
  await openBlockedChat("pro_required");

  await expect(
    screen.findByText(/^Upgrade to Pro to keep chatting with /u),
  ).resolves.toBeInTheDocument();
  expect(queryButton("$5")).toBeNull();
  expect(queryButton("$10")).toBeNull();
  await upgradeToPro();
});

test("Show that a previously blocked chat can continue after credits return", async () => {
  arrangeWorkspace("member", { tier: "pro", credits: 25_000 });

  await openBlockedChat("insufficient_credits");

  await expect(
    screen.findByText("Credits available"),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText(/^Your credits have been added\. You can continue/u),
  ).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveAttribute(
    "contenteditable",
    "true",
  );
  expect(queryButton("Upgrade to Pro")).toBeNull();
  expect(queryButton("$100")).toBeNull();
});

test("Show a new credit rejection with the current balance", async () => {
  const workspace = arrangeWorkspace("admin", {
    tier: "pro",
    credits: 25_000,
  });
  const events = await openBlockedChat("insufficient_credits");
  await expect(
    screen.findByText("Credits available"),
  ).resolves.toBeInTheDocument();
  // The balance runs out, so the API rejects the next message the way it
  // rejects a queued input: the input is replaced and an error follows it.
  workspace.credits = 0;
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    events.push(
      {
        id: "e0000000-0000-4000-a000-000000000b03",
        role: "user",
        content: body.prompt ?? "",
        ...(body.userMessage ? { userMessage: body.userMessage } : {}),
        revokesEventId: body.clientEventId,
        error: "insufficient_credits",
        runId: undefined,
        seqId: 100,
        createdAt: "2026-11-20T08:00:00.000Z",
      },
      {
        id: "e0000000-0000-4000-a000-000000000b04",
        role: "assistant",
        content: null,
        error: "insufficient_credits",
        runId: undefined,
        seqId: 101,
        createdAt: "2026-11-20T08:00:00.001Z",
      },
    );
    publishRunUpdate(RUN_THREAD_ID);
    return respond(201, { threadId: RUN_THREAD_ID });
  });

  await sendText("Try the summary again");

  await expect(
    screen.findAllByText("You're out of credits"),
  ).resolves.not.toHaveLength(0);
  expect(screen.queryByText("Credits available")).not.toBeInTheDocument();
});

test("A limited-free owner sees the specific recovery explanation for an exhausted balance", async () => {
  arrangeWorkspace("admin", { tier: "limited-free-1", credits: 0 });
  await openBlockedChat("insufficient_credits");
  const explanation = await screen.findByText(
    "Add credits from $5 to keep going, or upgrade to Pro to unlock exclusive features.",
  );
  expect(explanation).toBeVisible();
  expect(screen.queryByText("Upgrade to Pro to run")).not.toBeInTheDocument();
  expect(
    screen.queryByText("insufficient_credits", { exact: true }),
  ).toBeNull();
  await expect(
    screen.findByText("You're out of credits", { exact: true }),
  ).resolves.toBeVisible();
});

test.each(["admin", "member"] as const)(
  "A structured credit failure shows the billing recovery available to the %s",
  async (role) => {
    arrangeWorkspace(role, { tier: "limited-free-1", credits: 0 });
    accountModels(context, ["gpt-5.6-sol", "gpt-5.6-luna"], "gpt-5.6-sol");
    const raw = "The provider rejected invoice authorization for the draft.";
    const { events } = blockedRun("insufficient_credits");
    installRunChat({
      chatEvents: [
        events[0]!,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          runId: BLOCKED_RUN_ID,
          content: raw,
          runLifecycleEvent: "failed",
          failureReason: "insufficient_credits",
          seqId: 2,
          createdAt: "2026-11-20T07:52:00Z",
        },
      ],
    });
    await setupPage({ context, path: RUN_PATH });
    await screen.findByText(BLOCKED_PROMPT);
    const card = await screen.findByTestId("assistant-error-card-shell");
    const content = within(card);
    expect(content.getByText("You're out of credits")).toBeVisible();
    expect(content.queryByText("Upgrade to Pro to run")).toBeNull();
    expect(screen.queryByText(raw)).toBeNull();
    expect(content.queryByRole("combobox")).toBeNull();
    const explanation =
      role === "admin"
        ? "Add credits from $5 to keep going, or upgrade to Pro to unlock exclusive features."
        : "Ask a workspace admin to add credits so you can keep chatting with Okou.";
    await expect(content.findByText(explanation)).resolves.toBeVisible();
    const labels = queryAllByRoleFast("button", card).map((button) => {
      return button.textContent?.trim();
    });
    expect(labels).toStrictEqual(
      role === "admin" ? ["$5", "$10", "Upgrade to Pro"] : [],
    );
  },
);
