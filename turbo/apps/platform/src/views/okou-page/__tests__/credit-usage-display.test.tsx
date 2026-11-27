import {
  mockChatGeometry,
  messageAnchor,
  requiredElement,
} from "./chat-conversation-locator-test-helpers.ts";
import {
  chatThreadUsageContract,
  type ChatEventUsagePayload,
} from "@okouai/api-contracts/contracts/chat-threads";
import { modelCatalogContract } from "@okouai/api-contracts/contracts/model-catalog";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { fill, setupPage, click } from "../../../__tests__/page-helper.ts";
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

test("credit-usage-display-010 the English receipt rolls historical provider aliases into their user-facing charges", async () => {
  const models = usageLine(
    "model",
    ["auto", 1],
    ["okou-1.0", 2],
    ["@preset/okou-1-0", 3],
    ["@preset/okou-1-0-dsf", 4],
    ["@preset/closed-research", 5],
    ["openai/gpt-6-luna", 6],
    ["gpt-6-luna", 7],
    ["anthropic/claude-sonnet-4.6", 8],
    ["claude-sonnet-4-6", 9],
    ["claude-sonnet-4.6", 10],
    ["okou-1.0-pro", 11],
    ["okou-1.0-max", 12],
  );
  await openAnswer(
    "The historical receipt is attached.",
    settled(99, [
      models,
      usageLine("social", ["news-index", 4]),
      usageLine("commerce", ["catalog", 17]),
    ]),
    [usageHint()],
  );
  const { amount, details } = await inspectCredits(99);
  for (const [label, charge] of [
    ["Auto", 15],
    ["GPT 6 Luna", 13],
    ["Claude Sonnet 4.6", 27],
    ["Data Search", 21],
    ["Okou 1.0 Max", 12],
    ["Okou 1.0 Pro", 11],
  ] as const) {
    await expect(amount(label, charge)).resolves.toBeInTheDocument();
  }
  expect(document.documentElement.lang).toBe("en-US");
  expect(details.queryByText(/@preset\//)).toBeNull();
});

test("credit-usage-display-008 an unavailable settlement leaves the chat answer usable without billing its hint", async () => {
  const reached = context.mocks.deferred<void>();
  const answer = "The field team can read this answer.";
  mockChatLifecycle(context, {
    threadId: context.resourceId,
    historyEvents: [
      { createdAt, runId, role: "user", content: "What did the team find?" },
      { createdAt, runId, role: "assistant", content: answer },
      { createdAt, runId, runLifecycleEvent: "completed", content: null },
      usageHint(),
    ],
  });
  context.mocks.api(chatThreadUsageContract.read, ({ respond }) => {
    reached.resolve();
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Settlement missing" },
    });
  });
  await setupPage({ context, path: "/chats/" + context.resourceId });
  await reached.promise;
  await expect(screen.findByText(answer)).resolves.toBeVisible();
  const draft = await screen.findByRole("textbox", { name: /message/i });
  await fill(draft, "Can you elaborate?");
  expect(draft).toHaveTextContent("Can you elaborate?");
  expect(screen.queryByLabelText("Credit usage 999")).toBeNull();
});

async function wheelToTop(pane: HTMLElement) {
  // The geometry mock stores the offset after initial pinning or a history
  // prepend. Deliver that scroll event before the reader moves the viewport.
  await waitFor(
    () => {
      expect(pane.scrollTop).toBeGreaterThan(0);
    },
    { container: pane },
  );
  fireEvent.scroll(pane);
  fireEvent.wheel(pane, { deltaY: -pane.scrollTop });
  pane.scrollTop = 0;
  fireEvent.scroll(pane);
  fireEvent(pane, new Event("scrollend"));
}

test("credit-usage-display-001 scrolling to the first answer reveals its own settled receipt", async () => {
  const history: MockChatEventInput[] = [];
  const ledger: Record<string, ChatEventUsagePayload> = {};
  for (let turn = 1; turn <= 7; turn++) {
    const id = crypto.randomUUID();
    const stamp = new Date(Date.parse(createdAt) + turn * 60_000).toISOString();
    history.push(
      {
        runId: id,
        createdAt: stamp,
        role: "user",
        content: "Survey question " + turn,
      },
      {
        runId: id,
        createdAt: stamp,
        role: "assistant",
        content: "Survey answer " + turn,
      },
      {
        runId: id,
        createdAt: stamp,
        runLifecycleEvent: "completed",
        content: null,
      },
    );
    if (turn === 1 || turn === 7) {
      history.push({ ...usageHint(), runId: id, createdAt: stamp });
      ledger[id] = settled(60 + turn, [
        usageLine("model", ["gpt-6-luna", 60 + turn]),
      ]);
    }
  }
  mockChatGeometry(() => {
    return 600;
  }, 100);
  mockChatLifecycle(context, {
    threadId: context.resourceId,
    historyEvents: history,
    runUsage: ledger,
  });
  await setupPage({ context, path: "/chats/" + context.resourceId });
  const pane = requiredElement("[data-scroll-container]");
  await within(pane).findByText("Survey answer 7");
  await within(pane).findByLabelText("Credit usage 67");
  expect(screen.queryByText("Survey answer 1")).toBeNull();
  expect(screen.queryByLabelText("Credit usage 61")).toBeNull();
  await wheelToTop(pane);
  await within(pane).findByText("Survey answer 1");
  await wheelToTop(pane);
  await waitFor(() => {
    const first = messageAnchor(
      "Survey answer 1",
      pane,
    ).getBoundingClientRect();
    expect(first.bottom).toBeGreaterThan(0);
    expect(first.top).toBeLessThan(pane.clientHeight);
    expect(screen.getAllByText("Survey answer 1")).toHaveLength(1);
  });
  const { details } = await inspectCredits(61);
  expect(details.queryByText("999")).toBeNull();
  expect(screen.getByLabelText("Credit usage 67")).toBeInTheDocument();
});
