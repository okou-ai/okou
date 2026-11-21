import type { ChatEventUsagePayload } from "@okouai/api-contracts/contracts/chat-threads";
import { modelCatalogContract } from "@okouai/api-contracts/contracts/model-catalog";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage, click } from "../../../__tests__/page-helper.ts";
import { createMockModelCatalog } from "../../../mocks/handlers/api-model-catalog.ts";
import { createChatEvent } from "../../../mocks/mock-helpers.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const runId = "ce000062-0000-4000-8000-000000000027";
const createdAt = "2026-11-02T11:00:00Z";

function settled(
  totalCredits: number,
  breakdown: ChatEventUsagePayload["breakdown"],
): ChatEventUsagePayload {
  return { version: 1, settledAt: createdAt, totalCredits, breakdown };
}

function usageHint(): MockChatEventInput {
  return {
    eventType: "usage.recorded",
    runId,
    createdAt,
    content: null,
    usage: settled(999, []),
  };
}

async function openAnswer(
  answer: string,
  ledger: ChatEventUsagePayload,
  updates: MockChatEventInput[],
) {
  const threadId = context.resourceId;
  mockChatLifecycle(context, {
    threadId,
    historyEvents: [
      { runId, createdAt, role: "user", content: "Summarize my usage." },
      { runId, createdAt, role: "assistant", content: answer },
      { runId, createdAt, runLifecycleEvent: "completed", content: null },
    ],
    chatEvents: updates,
    runUsage: { [runId]: ledger },
  });
  await setupPage({
    context,
    path: "/chats/" + threadId,
    sharedWorkerTestTransport: "message-port",
  });
  await expect(screen.findByText(answer)).resolves.toBeVisible();
}

function usageLine(
  kind: string,
  ...values: [string, number][]
): ChatEventUsagePayload["breakdown"][number] {
  return {
    kind,
    credits: values.reduce((sum, [, credits]) => {
      return sum + credits;
    }, 0),
    providers: values.map(([provider, credits]) => {
      return { provider, credits };
    }),
  };
}

async function inspectCredits(total: number) {
  click(
    await screen.findByLabelText("Credit usage " + total, {
      selector: "button",
    }),
  );
  const details = within(await screen.findByRole("dialog"));
  async function amount(label: string, credits: number) {
    const name = await details.findByText(label);
    const row = name.parentElement;
    if (!row) {
      throw new Error("Missing usage amount for " + label);
    }
    return within(row).getByText(String(credits));
  }
  await expect(amount("Credit usage", total)).resolves.toBeVisible();
  return { details, amount };
}

test("credit-usage-display-002 a late hint makes the completed answer’s settled charge available", async () => {
  const updates: MockChatEventInput[] = [];
  await openAnswer(
    "Your November balance is ready.",
    settled(17, [usageLine("connector", ["calendar", 17])]),
    updates,
  );
  expect(
    screen.queryByLabelText(/^Credit usage /u, { selector: "button" }),
  ).toBeNull();
  await waitFor(() => {
    expect(
      context.mocks.ably.hasChannelSubscriptionOnChannel(
        "user-org:test-user-123:org_default",
      ),
    ).toBeTruthy();
  });
  updates.push(usageHint());
  createChatEvent(context.resourceId);
  const { details, amount } = await inspectCredits(17);
  await expect(amount("Calendar", 17)).resolves.toBeVisible();
  expect(details.queryByText("999")).toBeNull();
  expect(screen.queryByLabelText("Credit usage 999")).toBeNull();
});

test("credit-usage-display-007 the settled ledger groups data services separately from connectors and models", async () => {
  await openAnswer(
    "The multichannel campaign report is ready.",
    settled(170, [
      usageLine("connector", ["x", 12]),
      usageLine("social", ["socialkit", 33], ["monid/instagram", 22]),
      usageLine("social/monid/instagram/provider_cost_usd_micros", [
        "monid/instagram",
        6,
      ]),
      usageLine("commerce", ["catalog-search", 40]),
      usageLine("commerce/catalog-search/provider_cost_usd_micros", [
        "catalog-search",
        4,
      ]),
      usageLine("web-search", ["search-archive", 19]),
      usageLine("maps", ["map-archive", 11]),
      usageLine("legacy-data", ["unknown", 8]),
      usageLine("model", ["gpt-5.6-sol", 6], ["gpt-5.6-luna", 9]),
    ]),
    [usageHint()],
  );
  const { amount } = await inspectCredits(170);
  await expect(amount("X", 12)).resolves.toBeVisible();
  await expect(amount("Data Search", 135)).resolves.toBeVisible();
  await expect(amount("Legacy Data", 8)).resolves.toBeVisible();
  await expect(amount("GPT 5.6 Sol", 6)).resolves.toBeVisible();
  await expect(amount("GPT 5.6 Luna", 9)).resolves.toBeVisible();
});

test("credit-usage-display-011 an ambiguous route stays identifiable and retired Opus usage keeps its original name", async () => {
  const catalog = createMockModelCatalog();
  const shared = "openai/shared-proxy";
  const unknown = "anthropic/uncataloged-claude-haiku";
  const disabled = "anthropic/disabled-opus";
  const template = catalog.routes[0];
  context.mocks.api(modelCatalogContract.get, ({ respond }) => {
    return respond(200, {
      ...catalog,
      routes: [
        ...catalog.routes,
        { ...template, model: "gpt-6-luna", upstreamModel: shared },
        { ...template, model: "gpt-6-sol", upstreamModel: shared },
        {
          ...template,
          model: "claude-opus-4-8",
          upstreamModel: disabled,
          enabled: false,
        },
      ],
    });
  });
  await openAnswer(
    "Historical model charges are available.",
    settled(10, [
      usageLine(
        "model",
        [shared, 1],
        [unknown, 2],
        [disabled, 4],
        ["claude-opus-4.8", 3],
      ),
    ]),
    [usageHint()],
  );
  const { amount, details } = await inspectCredits(10);
  await expect(amount(shared, 1)).resolves.toBeVisible();
  await expect(amount(unknown, 2)).resolves.toBeVisible();
  await expect(amount("Claude Opus 4.8", 7)).resolves.toBeVisible();
  expect(details.queryByText("Claude Opus 5.5")).toBeNull();
});
