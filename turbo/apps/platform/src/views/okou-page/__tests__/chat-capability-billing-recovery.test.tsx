import {
  billingCheckoutContract,
  billingStatusContract,
  type BillingStatusResponse,
} from "@okouai/api-contracts/contracts/billing";
import {
  chatEventsContract,
  chatThreadEventsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  mockChatEventRows,
  normalizeMockChatEvents,
  type MockChatEventInput,
} from "./chat-event-test-helpers.ts";
import {
  findButton,
  promptEvent,
  readyChat,
  RUN_PATH,
  RUN_THREAD_ID,
  sendText,
  createChatRunFixtures,
} from "./chat-run-test-fixtures.ts";
import { billingPlanCapabilities } from "../../../mocks/handlers/api-billing.ts";
import { createChatEvent } from "../../../mocks/mock-helpers.ts";
import {
  chatEventRowsResponse,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);

const BILLING_RUN_ID = "d0000000-0000-4000-a000-000000001301";

type WorkspaceRole = "admin" | "member";

function billingFailure(error: "insufficient_credits" | "pro_required") {
  return [
    promptEvent({
      id: "billing-user-prompt",
      runId: BILLING_RUN_ID,
      seqId: 1,
      text: "Finish the campaign brief",
    }),
    {
      id: "billing-run-error",
      eventType: "output.error",
      role: "assistant",
      content: null,
      error,
      runId: BILLING_RUN_ID,
      seqId: 2,
      createdAt: "2026-08-01T10:00:02.000Z",
    },
  ] satisfies MockChatEventInput[];
}

function billingStatus(args: {
  readonly tier: string;
  readonly credits: number;
  readonly canBuyCredits: boolean;
}): BillingStatusResponse {
  const paid = args.tier === "pro" || args.tier === "team";
  return {
    showUsagePack: false,
    tier: args.tier,
    ...billingPlanCapabilities(args.tier),
    canBuyCredits: args.canBuyCredits,
    credits: args.credits,
    onboardingPaymentPending: false,
    subscriptionStatus: paid ? "active" : null,
    currentPeriodEnd: paid ? "2026-09-30T00:00:00.000Z" : null,
    cancelAtPeriodEnd: false,
    scheduledChange: null,
    hasSubscription: paid,
    autoRecharge: { enabled: false, threshold: null, amount: null },
    creditExpiry: { expiringNextCycle: 0, nextExpiryDate: null },
    creditBreakdown: [],
    creditGrants: [],
    concurrencyLimit: 0,
    concurrencySubscriptions: [],
  };
}

function installBillingState(args: {
  readonly tier: string;
  readonly role: WorkspaceRole;
  readonly credits: number;
  readonly canBuyCredits: boolean;
}): void {
  context.mocks.data.org({
    id: "org_billing_recovery",
    name: "Billing Recovery Workspace",
    role: args.role,
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, billingStatus(args));
  });
}

function installBlockedChat(
  error: "insufficient_credits" | "pro_required" = "insufficient_credits",
): void {
  installRunChat({ chatEvents: billingFailure(error) });
}

function queryButton(
  name: string,
  container: ParentNode = document.body,
): HTMLElement | null {
  return (
    queryAllByRoleFast("button", container).find((button) => {
      return (
        button.getAttribute("aria-label") === name ||
        button.textContent?.replace(/\s+/gu, " ").trim() === name
      );
    }) ?? null
  );
}

async function expectProCheckout(): Promise<void> {
  const user = userEvent.setup({ delay: null });
  const checkoutRequests: string[] = [];
  context.mocks.api(billingCheckoutContract.create, ({ body, respond }) => {
    checkoutRequests.push(body.tier);
    return respond(200, { url: "https://checkout.example.test/pro" });
  });

  await user.click(await findButton("Upgrade to Pro"));

  await waitFor(() => {
    expect(checkoutRequests).toStrictEqual(["pro"]);
    expect(window.location.href).toBe("https://checkout.example.test/pro");
  });
}

test("Let a workspace admin recover from a free-plan billing limit", async () => {
  installBillingState({
    tier: "limited-free-1",
    role: "admin",
    credits: 0,
    canBuyCredits: false,
  });
  installBlockedChat("insufficient_credits");

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  await expect(
    screen.findByText(/Upgrade to Pro to keep chatting/u),
  ).resolves.toBeVisible();

  await expectProCheckout();
});

test("Let a limited-free workspace admin unlock a Pro-only capability", async () => {
  installBillingState({
    tier: "limited-free-1",
    role: "admin",
    credits: 500,
    canBuyCredits: false,
  });
  installBlockedChat("pro_required");

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  await expect(
    screen.findByText(/Upgrade to Pro to keep chatting/u),
  ).resolves.toBeVisible();

  await expectProCheckout();
});

test("Show that a previously blocked chat can continue after credits return", async () => {
  installBillingState({
    tier: "pro",
    role: "member",
    credits: 25_000,
    canBuyCredits: true,
  });
  installBlockedChat();

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  await expect(screen.findByText("Credits available")).resolves.toBeVisible();
  expect(
    screen.getByText(
      /Your credits have been added\. You can continue chatting/u,
    ),
  ).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();
  expect(queryButton("Upgrade to Pro")).not.toBeInTheDocument();
  expect(queryButton("$100")).not.toBeInTheDocument();
});

// The send response is not read, so the rejection a send turns into arrives as
// persisted events. The card rendered from them must use the org's current
// credits rather than the balance loaded before they ran out.
test("Show a new credit rejection with the current balance", async () => {
  const tierArgs = { tier: "pro", canBuyCredits: true } as const;
  installBillingState({ ...tierArgs, role: "admin", credits: 25_000 });
  installBlockedChat();
  const events: MockChatEventInput[] = [
    ...billingFailure("insufficient_credits"),
  ];
  context.mocks.api(
    chatThreadEventsContract.rows,
    ({ params, query, respond }) => {
      const rows = mockChatEventRows(
        normalizeMockChatEvents(events, params.threadId),
      ).filter((row) => {
        return row.seqId > query.sinceSeqId;
      });
      return respond(200, chatEventRowsResponse(rows, query));
    },
  );
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    const createdAt = "2026-08-01T10:01:00.000Z";
    events.push(
      {
        id: body.clientEventId,
        role: "user",
        eventType: "input.rejected",
        content: null,
        error: "insufficient_credits",
        userMessage: body.userMessage,
        seqId: 3,
        createdAt,
      },
      {
        id: "billing-rejection-error",
        eventType: "output.error",
        role: "assistant",
        content: null,
        error: "insufficient_credits",
        seqId: 4,
        createdAt: "2026-08-01T10:01:01.000Z",
      },
    );
    createChatEvent(RUN_THREAD_ID);
    return respond(201, { threadId: RUN_THREAD_ID, createdAt });
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  await expect(screen.findByText("Credits available")).resolves.toBeVisible();

  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, billingStatus({ ...tierArgs, credits: 0 }));
  });
  await sendText("Try the brief once more");

  await expect(
    screen.findAllByText("You're out of credits"),
  ).resolves.not.toHaveLength(0);
  expect(screen.queryByText("Credits available")).not.toBeInTheDocument();
});

// A new thread's first send has no persisted history before its rejection, so
// the rejection of the page's own pending message is what makes it new.
