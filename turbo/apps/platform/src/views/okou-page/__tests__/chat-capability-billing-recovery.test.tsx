import {
  billingCheckoutContract,
  billingStatusContract,
} from "@okouai/api-contracts/contracts/billing";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
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
  queryButton,
  readyChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

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
): Workspace {
  const workspace = { ...initial };
  context.mocks.data.org({ id: "org_billing", name: "Sales Org", role });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, {
      ...defaultBillingStatus(),
      tier: workspace.tier,
      ...billingPlanCapabilities(workspace.tier),
      credits: workspace.credits,
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

function mockProCheckout(): { tier?: string } {
  const checkout: { tier?: string } = {};
  context.mocks.api(billingCheckoutContract.create, ({ body, respond }) => {
    checkout.tier = body.tier;
    return respond(200, {
      status: "preview",
      purchaseType: "plan",
      tier: body.tier,
      immediateAmountCents: 2000,
      nextRecurringAmountCents: 2000,
      currency: "usd",
      expiresAt: "2026-11-20T09:00:00.000Z",
      previewToken: "plan-preview-b11",
    });
  });
  return checkout;
}

async function upgradeToPro(): Promise<void> {
  click(await findEnabledButton("Upgrade to Pro"));
  await expect(
    screen.findByRole("dialog", { name: "Upgrade to Pro" }),
  ).resolves.toBeInTheDocument();
}

test("Let a workspace admin recover from a free-plan billing limit", async () => {
  arrangeWorkspace("admin", { tier: "limited-free-1", credits: 0 });
  const checkout = mockProCheckout();
  await openBlockedChat("insufficient_credits");

  await expect(
    screen.findByText(/^Upgrade to Pro to keep chatting with /u),
  ).resolves.toBeInTheDocument();
  await upgradeToPro();

  expect(checkout.tier).toBe("pro");
});

test("Let a limited-free workspace admin unlock a Pro-only capability", async () => {
  arrangeWorkspace("admin", { tier: "limited-free-1", credits: 500 });
  const checkout = mockProCheckout();
  await openBlockedChat("pro_required");

  await expect(
    screen.findByText(/^Upgrade to Pro to keep chatting with /u),
  ).resolves.toBeInTheDocument();
  await upgradeToPro();

  expect(checkout.tier).toBe("pro");
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
