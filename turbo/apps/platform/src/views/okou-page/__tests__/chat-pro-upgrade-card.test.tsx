import {
  billingStatusContract,
  billingUsagePackCatalogContract,
  billingUsagePackCreditsContract,
} from "@okouai/api-contracts/contracts/billing";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  billingPlanCapabilities,
  defaultBillingStatus,
} from "../../../mocks/handlers/api-billing.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  completedConversation,
  FIRST_CAPABILITY_RUN_ID,
  readyChat,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";
import {
  completedEvent,
  createChatRunFixtures,
  findButton,
  findEnabledButton,
  sendText,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);
const UPGRADE_LINK =
  "[Compare plans](https://app.okou.ai/?settings=billing&billingView=plans)";

function mockBilling(tier = "limited-free-1") {
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, {
      ...defaultBillingStatus(),
      tier,
      credits: 0,
      ...billingPlanCapabilities(tier),
      onboardingPaymentPending: false,
    });
  });
  context.mocks.api(billingUsagePackCreditsContract.get, ({ respond }) => {
    return respond(200, {
      totalCredits: 1000,
      purchasedCredits: 0,
      bonusCredits: 1000,
      creditGrants: [],
      hasUsagePack: false,
    });
  });
}

async function openUpgradeChat(tier = "limited-free-1") {
  mockBilling(tier);
  installRunChat({
    chatEvents: [
      ...completedConversation(`Your report is ready.\n\n${UPGRADE_LINK}`),
      completedEvent({
        id: "upgrade-completed",
        runId: FIRST_CAPABILITY_RUN_ID,
        seqId: 3,
      }),
      {
        id: "upgrade-followups",
        content: null,
        runId: FIRST_CAPABILITY_RUN_ID,
        seqId: 4,
        createdAt: "2026-08-01T10:00:04.000Z",
        followups: [{ prompt: "Summarize the report", kind: "talk" }],
      },
    ],
  });
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  await readyChat();
  return screen.findByTestId("plan-upgrade-card");
}

test("Show the lowest paid catalog price and open the existing plans dialog", async () => {
  context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
    return respond(200, {
      supportsFreeMembers: true,
      usagePacks: [
        {
          usagePackUsd: 50,
          priceUsd: 45,
          purchasedCredits: 50_000,
          bonusCredits: 5000,
          totalCredits: 55_000,
        },
        {
          usagePackUsd: 20,
          priceUsd: 18,
          purchasedCredits: 20_000,
          bonusCredits: 2000,
          totalCredits: 22_000,
        },
      ],
    });
  });

  const card = await openUpgradeChat();
  const completion = document.querySelector<HTMLElement>(
    "[data-chat-run-status-tail]",
  );
  if (!completion) {
    throw new Error("Expected the task completion status");
  }
  expect(completion).not.toContainElement(card);
  const separator = within(completion).getByRole("separator");
  expect(
    card.compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    screen.getByText("Your report is ready.").compareDocumentPosition(card) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  const assistant = card.closest<HTMLElement>('[data-role="assistant"]');
  if (!assistant) {
    throw new Error("Expected the completed result");
  }
  const copy = await findEnabledButton("Copy message", assistant);
  expect(
    copy.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    within(completion).getByRole("group", { name: "Keep going" }),
  ).toBeInTheDocument();
  await expect(within(card).findByText("$18")).resolves.toBeVisible();
  expect(within(card).queryByText("$0")).toBeNull();
  expect(within(card).getByText("Fewer than 2 tasks left")).toBeInTheDocument();
  expect(within(card).getByText("+400")).toBeInTheDocument();
  expect(
    within(card).getByText(/bonus credits · Just now/u),
  ).toBeInTheDocument();
  click(await findEnabledButton("Upgrade now", card));
  await expect(
    screen.findByRole("dialog", { name: "Choose a plan" }),
  ).resolves.toBeVisible();
});

test("Keep the upgrade action usable when the price catalog is unavailable", async () => {
  context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_SERVER_ERROR", message: "Catalog unavailable" },
    });
  });

  const card = await openUpgradeChat();
  await expect(
    within(card).findByText("See plans for current pricing"),
  ).resolves.toBeVisible();
  expect(within(card).queryByText(/\$/u)).toBeNull();
  expect(within(card).getByText("+400")).toBeInTheDocument();
  await expect(findEnabledButton("Upgrade now", card)).resolves.toBeEnabled();
});

test("Keep the general plans action for an existing paid workspace", async () => {
  const card = await openUpgradeChat("pro");
  await expect(
    within(card).findByText("Upgrade your workspace"),
  ).resolves.toBeVisible();
  expect(within(card).queryByText("Do more with Pro")).toBeNull();
  expect(within(card).queryByText("+400")).toBeNull();
  click(await findEnabledButton("Compare plans", card));
  await expect(
    screen.findByRole("dialog", { name: "Choose a plan" }),
  ).resolves.toBeVisible();
});

test("Wait for successful completion, show one trailing card, and retire it on the next task", async () => {
  mockBilling();
  const chat = installRunChat({
    chatEvents: completedConversation(
      `Your report is ready.\n\n${UPGRADE_LINK}`,
    ),
    activeRunIds: [FIRST_CAPABILITY_RUN_ID],
  });
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  await readyChat();
  await findButton("Stop");
  expect(screen.getByText("Your report is ready.")).toBeInTheDocument();
  expect(screen.queryByTestId("plan-upgrade-card")).toBeNull();

  chat.completeRun(`Everything is ready.\n\n${UPGRADE_LINK}`);

  const card = await screen.findByTestId("plan-upgrade-card");
  expect(screen.getAllByTestId("plan-upgrade-card")).toHaveLength(1);
  expect(card.closest("[data-chat-run-status-tail]")).toBeNull();

  await sendText("Summarize the report");
  await findButton("Stop");
  expect(screen.queryByTestId("plan-upgrade-card")).toBeNull();
  chat.completeRun("Here is the summary.");
  await screen.findByText("Here is the summary.");
  await findButton("Send");
  expect(screen.queryByTestId("plan-upgrade-card")).toBeNull();
});

test("Do not promote an upgrade link from an unsuccessful response", async () => {
  mockBilling();
  installRunChat({
    chatEvents: [
      ...completedConversation(
        `Still preparing the report.\n\n${UPGRADE_LINK}`,
      ),
      {
        id: "upgrade-failed",
        eventType: "run.failed",
        content: null,
        error: "The report could not be completed.",
        runId: FIRST_CAPABILITY_RUN_ID,
        seqId: 3,
        createdAt: "2026-08-01T10:00:03.000Z",
      },
    ],
  });
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  await readyChat();
  await screen.findByText("The report could not be completed.");
  expect(screen.queryByTestId("plan-upgrade-card")).toBeNull();
});
