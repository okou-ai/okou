import {
  type ChatEventUsagePayload,
  chatThreadUsageContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { modelCatalogContract } from "@okouai/api-contracts/contracts/model-catalog";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";

import { createMockModelCatalog } from "../../../mocks/handlers/api-model-catalog.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createChatEvent } from "../../../mocks/mock-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
const context = testContext();

function usageButton(total: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.getAttribute("aria-label") === `Credit usage ${total}`;
  });
  if (!button) {
    throw new Error(`Credit usage ${total} button not found`);
  }
  return button;
}

function setupUsageChat(
  threadId: string,
  runId: string,
  usage: ChatEventUsagePayload,
  locale: "en-US" | "zh-Hans" = "en-US",
): Promise<void> {
  mockChatLifecycle(context, {
    threadId,
    chatEvents: [
      {
        id: `${runId}-user`,
        role: "user",
        content: "Show this run's credit usage",
        runId,
        createdAt: "2026-08-14T12:00:00.000Z",
      },
      {
        id: `${runId}-assistant`,
        role: "assistant",
        content: "The usage summary is ready.",
        runId,
        createdAt: "2026-08-14T12:00:01.000Z",
      },
      {
        id: `${runId}-usage`,
        role: "assistant",
        content: null,
        runId,
        usage,
        createdAt: "2026-08-14T12:00:02.000Z",
      },
    ],
  });
  return setupPage({
    context,
    path: `/chats/${threadId}`,
    locale,
  });
}

async function openUsage(total: string): Promise<void> {
  await waitFor(() => {
    expect(usageButton(total)).toBeInTheDocument();
  });
  click(usageButton(total));
  await screen.findByText("Credit usage");
}

function ledgerUsage(totalCredits: number): ChatEventUsagePayload {
  return {
    version: 1,
    totalCredits,
    settledAt: "2026-08-14T12:00:02.000Z",
    breakdown: [
      {
        kind: "model/gpt-6-luna/tokens.output",
        credits: totalCredits,
        providers: [{ provider: "openai", credits: totalCredits }],
      },
    ],
  };
}

function mockUsageChat(
  threadId: string,
  events: MockChatEventInput[],
  ledger: Map<string, ChatEventUsagePayload>,
  activeRunIds: string[] = [],
): void {
  mockChatLifecycle(context, { threadId, chatEvents: events, activeRunIds });
  context.mocks.api(chatThreadUsageContract.read, ({ body, respond }) => {
    return respond(200, {
      runs: body.runIds.flatMap((runId) => {
        const usage = ledger.get(runId);
        return usage ? [{ runId, usage }] : [];
      }),
    });
  });
}

function usageChatEvent(
  id: string,
  runId: string,
  seqId: number,
  fields: Partial<MockChatEventInput>,
): MockChatEventInput {
  return {
    id,
    runId,
    seqId,
    role: "assistant",
    content: null,
    createdAt: new Date(
      Date.parse("2026-08-14T12:00:00.000Z") + seqId * 1000,
    ).toISOString(),
    ...fields,
  };
}

test("Historical run usage appears when scrolling reveals its answer", async () => {
  const threadId = "b0000000-0000-4000-a000-000000000815";
  const historicalRunId = "a0000000-0000-4000-a000-000000000815";
  const latestRunId = "a0000000-0000-4000-a000-000000000821";
  const events: MockChatEventInput[] = [];
  // Seven completed turns exceed the initial render window, while
  // fitting within one additional page when the reader scrolls to the top.
  for (let turn = 0; turn < 7; turn++) {
    const runId =
      turn === 0
        ? historicalRunId
        : turn === 6
          ? latestRunId
          : `a0000000-0000-4000-a000-${String(815 + turn).padStart(12, "0")}`;
    const seqId = turn * 4 + 1;
    events.push(
      usageChatEvent(`window-prompt-${String(turn)}`, runId, seqId, {
        role: "user",
        content: `Question ${String(turn + 1)}`,
      }),
      usageChatEvent(`window-answer-${String(turn)}`, runId, seqId + 1, {
        content: `Completed answer ${String(turn + 1)}`,
      }),
      usageChatEvent(`window-completed-${String(turn)}`, runId, seqId + 2, {
        runLifecycleEvent: "completed",
      }),
    );
    if (turn === 0 || turn === 6) {
      events.push(
        usageChatEvent(`window-hint-${String(turn)}`, runId, seqId + 3, {
          usage: ledgerUsage(999),
        }),
      );
    }
  }
  mockUsageChat(
    threadId,
    events,
    new Map([
      [historicalRunId, ledgerUsage(61)],
      [latestRunId, ledgerUsage(67)],
    ]),
  );

  await setupPage({ context, path: `/chats/${threadId}`, locale: "en-US" });
  const latestAnswer = await screen.findByText("Completed answer 7");
  await waitFor(() => {
    expect(usageButton("67")).toBeInTheDocument();
  });
  expect(screen.queryByText("Completed answer 1")).not.toBeInTheDocument();
  expect(
    queryAllByRoleFast("button").some((button) => {
      return button.getAttribute("aria-label") === "Credit usage 61";
    }),
  ).toBeFalsy();

  const viewport = latestAnswer.closest("[data-scroll-container]");
  if (!(viewport instanceof HTMLElement)) {
    throw new Error("Chat scroll viewport not found");
  }
  fireEvent.scroll(viewport, { target: { scrollTop: 0 } });

  await screen.findByText("Completed answer 1");
  await openUsage("61");
  expect(usageButton("67")).toBeInTheDocument();
  const details = screen.getByRole("dialog");
  expect(
    within(details).getByText("Credit usage").parentElement,
  ).toHaveTextContent("Credit usage61");
  expect(within(details).queryByText("999")).not.toBeInTheDocument();
});

// These fixtures change only the mocked server's event stream and ledger;
// createChatEvent delivers the same realtime notification as the production API.
test("A run shows settled usage only after its first usage hint arrives", async () => {
  const threadId = "b0000000-0000-4000-a000-000000000811";
  const runId = "a0000000-0000-4000-a000-000000000811";
  const events = [
    usageChatEvent("no-hint-prompt", runId, 1, {
      role: "user",
      content: "Show the answer before usage arrives",
    }),
    usageChatEvent("no-hint-answer", runId, 2, {
      content: "The answer is available without a usage hint.",
    }),
    usageChatEvent("no-hint-completed", runId, 3, {
      runLifecycleEvent: "completed",
    }),
  ];
  mockUsageChat(threadId, events, new Map([[runId, ledgerUsage(17)]]));

  await setupPage({ context, path: `/chats/${threadId}`, locale: "en-US" });
  await screen.findByText("The answer is available without a usage hint.");
  expect(
    queryAllByRoleFast("button").some((button) => {
      return button.getAttribute("aria-label")?.startsWith("Credit usage ");
    }),
  ).toBeFalsy();

  events.push(
    usageChatEvent("first-usage-hint", runId, 4, { usage: ledgerUsage(999) }),
  );
  createChatEvent(threadId);

  await openUsage("17");
  const details = screen.getByRole("dialog");
  expect(
    within(details).getByText("Credit usage").parentElement,
  ).toHaveTextContent("Credit usage17");
  expect(within(details).queryByText("999")).not.toBeInTheDocument();
});

test("Credit usage merges historical data services and new enrichment while preserving model and connector rows", async () => {
  await setupUsageChat(
    "b0000000-0000-4000-a000-000000000805",
    "a0000000-0000-4000-a000-000000000805",
    {
      version: 1,
      totalCredits: 170,
      settledAt: "2026-08-14T12:00:02.000Z",
      breakdown: [
        {
          kind: "connector",
          credits: 12,
          providers: [{ provider: "x", credits: 12 }],
        },
        {
          kind: "social",
          credits: 56,
          providers: [
            { provider: "monid/x", credits: 3 },
            { provider: "monid/instagram", credits: 7 },
            { provider: "monid/tiktok", credits: 11 },
            { provider: "monid/youtube", credits: 13 },
            { provider: "monid/facebook", credits: 17 },
            { provider: "monid/dy", credits: 2 },
            { provider: "monid/weibo", credits: 3 },
          ],
        },
        {
          kind: "social/monid/x/provider_cost_usd_micros",
          credits: 5,
          providers: [{ provider: "monid/x", credits: 5 }],
        },
        {
          kind: "model/gpt-5.6-sol/tokens.input",
          credits: 2,
          providers: [{ provider: "openai", credits: 2 }],
        },
        {
          kind: "model/gpt-5.6-sol/tokens.output",
          credits: 4,
          providers: [{ provider: "openai", credits: 4 }],
        },
        {
          kind: "model/gpt-5.6-luna/tokens.output",
          credits: 9,
          providers: [{ provider: "openai", credits: 9 }],
        },
        {
          kind: "social",
          credits: 19,
          providers: [{ provider: "socialkit", credits: 19 }],
        },
        {
          kind: "commerce",
          credits: 7,
          providers: [{ provider: "dataforseo", credits: 7 }],
        },
        {
          kind: "commerce/dataforseo/provider_cost_usd_micros",
          credits: 11,
          providers: [{ provider: "dataforseo", credits: 11 }],
        },
        {
          kind: "legacy-data",
          credits: 8,
          providers: [{ provider: "unknown", credits: 8 }],
        },
        {
          kind: "finance",
          credits: 4,
          providers: [{ provider: "apidojo", credits: 4 }],
        },
        {
          kind: "maps",
          credits: 6,
          providers: [{ provider: "google-maps", credits: 6 }],
        },
        {
          kind: "data-search/monid/apollo/provider_cost_usd_micros",
          credits: 10,
          providers: [{ provider: "monid/apollo", credits: 10 }],
        },
        ...(
          [
            ["people-search", "perplexity", 3],
            ["web-search", "perplexity", 2],
            ["scrape", "firecrawl", 4],
            ["seo", "dataforseo", 3],
            ["weather", "google-weather", 5],
          ] as const
        ).map(([kind, provider, credits]) => {
          return { kind, credits, providers: [{ provider, credits }] };
        }),
      ],
    },
  );

  await openUsage("170");

  const details = screen.getByRole("dialog");
  for (const [label, credits] of [
    // Every data service merges once; the X connector remains separate.
    ["X", "12"],
    ["Data Search", "135"],
    ["Legacy Data", "8"],
    ["GPT 5.6 Sol", "6"],
    ["GPT 5.6 Luna", "9"],
  ]) {
    expect(within(details).getByText(label).parentElement).toHaveTextContent(
      `${label}${credits}`,
    );
  }
  expect(within(details).getByText("170")).toBeInTheDocument();
});

test("Chat stays usable and shows no hint amount when settled usage cannot be read", async () => {
  const threadId = "b0000000-0000-4000-a000-000000000806";
  const runId = "a0000000-0000-4000-a000-000000000806";
  mockChatLifecycle(context, {
    threadId,
    chatEvents: [
      {
        id: "usage-unavailable-input",
        createdAt: "2026-08-14T12:00:00.000Z",
        role: "user",
        content: "Show my answer",
        runId,
      },
      {
        id: "usage-unavailable-answer",
        createdAt: "2026-08-14T12:00:01.000Z",
        role: "assistant",
        content: "The conversation is still available.",
        runId,
      },
      {
        id: "usage-unavailable-hint",
        createdAt: "2026-08-14T12:00:02.000Z",
        role: "assistant",
        content: null,
        runId,
        usage: {
          version: 1,
          totalCredits: 999,
          settledAt: "2026-08-14T12:00:02.000Z",
          breakdown: [],
        },
      },
    ],
  });
  context.mocks.api(chatThreadUsageContract.read, ({ respond }) => {
    return respond(404, { error: { code: "NOT_FOUND", message: "Not found" } });
  });
  await setupPage({ context, path: `/chats/${threadId}`, locale: "en-US" });
  await expect(
    screen.findByText("The conversation is still available."),
  ).resolves.toBeVisible();
  expect(
    queryAllByRoleFast("button").some((button) => {
      return button.getAttribute("aria-label") === "Credit usage 999";
    }),
  ).toBeFalsy();
});

test.each(["en-US"] as const)(
  "Credit usage shows managed labels and merges catalog aliases and Auto presets in %s",
  async (locale) => {
    const providers = [
      ["auto", 1],
      ["okou-1.0", 2],
      ["@preset/okou-1-0", 3],
      ["@preset/okou-opus", 4],
      ["@preset/removed-operator-preset", 5],
      ["gpt-6-luna", 6],
      ["openai/gpt-6-luna", 7],
      ["claude-sonnet-4-6", 8],
      ["claude-sonnet-4.6", 9],
      ["anthropic/claude-sonnet-4.6", 10],
      ["okou-1.0-pro", 11],
      ["okou-1.0-max", 12],
    ] as const;
    await setupUsageChat(
      "b0000000-0000-4000-a000-000000000808",
      "a0000000-0000-4000-a000-000000000808",
      {
        version: 1,
        totalCredits: 99,
        settledAt: "2026-08-14T12:00:02.000Z",
        breakdown: [
          {
            kind: "model",
            credits: 78,
            providers: providers.map(([provider, credits]) => {
              return {
                provider,
                credits,
              };
            }),
          },
          {
            kind: "social",
            credits: 4,
            providers: [
              { provider: "monid/dy", credits: 1 },
              { provider: "monid/weibo", credits: 3 },
            ],
          },
          {
            kind: "commerce",
            credits: 17,
            providers: [{ provider: "dataforseo", credits: 17 }],
          },
        ],
      },
      locale,
    );
    await openUsage("99");
    const details = screen.getByRole("dialog");
    for (const [label, credits] of [
      ["Data Search", "21"],
      ["Auto", "15"],
      ["GPT 6 Luna", "13"],
      ["Claude Sonnet 4.6", "27"],
      ["Okou 1.0 Pro", "11"],
      ["Okou 1.0 Max", "12"],
    ]) {
      expect(within(details).getByText(label).parentElement).toHaveTextContent(
        `${label}${credits}`,
      );
    }
    expect(document.documentElement.lang).toBe(locale);
    expect(within(details).getByText("99")).toBeInTheDocument();
    expect(within(details).queryByText(/@preset\//u)).not.toBeInTheDocument();
  },
);

test("Credit usage preserves ambiguous upstream identifiers and uncataloged historical models", async () => {
  const catalog = createMockModelCatalog();
  const route = catalog.routes[1];
  if (!route) {
    throw new Error("Expected a catalog route fixture");
  }
  context.mocks.api(modelCatalogContract.get, ({ respond }) => {
    return respond(200, {
      ...catalog,
      routes: [
        ...catalog.routes,
        {
          ...route,
          model: "gpt-6-luna",
          upstreamModel: "openai/shared-history",
          enabled: false,
        },
        {
          ...route,
          model: "gpt-6-sol",
          upstreamModel: "openai/shared-history",
        },
        {
          ...route,
          model: "claude-opus-4-8",
          upstreamModel: "anthropic/disabled-opus",
          enabled: false,
        },
      ],
    });
  });
  await setupUsageChat(
    "b0000000-0000-4000-a000-000000000809",
    "a0000000-0000-4000-a000-000000000809",
    {
      version: 1,
      totalCredits: 10,
      settledAt: "2026-08-14T12:00:02.000Z",
      breakdown: [
        {
          kind: "model",
          credits: 10,
          providers: [
            { provider: "openai/shared-history", credits: 1 },
            { provider: "claude-haiku-4-5-20251001", credits: 2 },
            { provider: "anthropic/disabled-opus", credits: 3 },
            { provider: "anthropic/claude-opus-4-8", credits: 4 },
          ],
        },
      ],
    },
  );
  await openUsage("10");
  const details = screen.getByRole("dialog");
  expect(
    within(details).getByText("openai/shared-history").parentElement,
  ).toHaveTextContent("1");
  expect(
    within(details).getByText("claude-haiku-4-5-20251001").parentElement,
  ).toHaveTextContent("2");
  expect(
    within(details).getByText("Claude Opus 4.8").parentElement,
  ).toHaveTextContent("7");
  expect(
    within(details).queryByText("Claude Opus 5.5"),
  ).not.toBeInTheDocument();
});
