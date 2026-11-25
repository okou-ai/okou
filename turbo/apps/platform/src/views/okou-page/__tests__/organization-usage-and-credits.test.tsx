import {
  usageMembersContract,
  type MemberUsage,
} from "@okouai/api-contracts/contracts/usage";
import { screen, within, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  action,
  april,
  billing,
  openWorkspace,
  setBilling,
} from "./workspace-billing-fixtures.ts";
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
import { createMockModelCatalog } from "../../../mocks/handlers/api-model-catalog.ts";
import { createChatEvent } from "../../../mocks/mock-helpers.ts";
import { type MockChatEventInput } from "./chat-event-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

test("org-usage-tab-001 Finance's credit history shows the grant date, addition and remaining amount together", async () => {
  setBilling(context, () => {
    return billing("pro", {
      credits: 12_000,
      creditGrants: [
        {
          id: "march-grant",
          source: "monthly",
          label: "March internal grant",
          amount: 10_000,
          remaining: 8000,
          createdAt: "2026-03-01T12:00:00Z",
          expiresAt: april,
        },
      ],
    });
  });
  await openWorkspace(context, "/?settings=usage");
  const card = await screen.findByTestId("credit-balance-info");
  expect(within(card).getByText("Org credits")).toBeInTheDocument();
  expect(within(card).getByText("12,000")).toBeInTheDocument();
  const grant = within(card).getByTestId("credit-grants-march-grant");
  expect(grant).toHaveTextContent("Mar 1, 2026");
  expect(grant).toHaveTextContent("+10,000");
  expect(grant).toHaveTextContent("8,000");
  for (const label of [
    "March internal grant",
    "Pro credits",
    "Purchased credits",
  ]) {
    expect(within(card).queryByText(label)).not.toBeInTheDocument();
  }
});
test("org-usage-tab-005 Hovering Finance's purchased balance identifies its value", async () => {
  setBilling(context, () => {
    return billing("pro", {
      credits: 12_000,
      creditBreakdown: [
        { category: "payAsYouGo", credits: 12_000, label: "Purchased credits" },
      ],
    });
  });
  await openWorkspace(context);
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  click(await action("Credit balance", settings));
  const balance = await within(settings).findByTestId("credit-balance-info");
  expect(within(balance).getByText("12,000")).toBeInTheDocument();
  const segment = within(balance).getByTestId(
    "credit-balance-segment-payAsYouGo",
  );
  expect(
    screen.queryByText("Purchased credits — 12,000"),
  ).not.toBeInTheDocument();
  await userEvent.hover(segment);
  await expect(
    screen.findByText("Purchased credits — 12,000"),
  ).resolves.toBeInTheDocument();
});
function member(id: string, models: number, connectors: number): MemberUsage {
  const breakdown: MemberUsage["breakdown"] = [
    {
      kind: "model",
      credits: models,
      providers: [{ provider: "usage-model", credits: models, usageKinds: [] }],
    },
  ];
  if (connectors) {
    breakdown.push({
      kind: "connector",
      credits: connectors,
      providers: [{ provider: "slack", credits: connectors, usageKinds: [] }],
    });
  }
  return {
    userId: id,
    email: id + "@example.org",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    creditsCharged: models + connectors,
    breakdown,
  };
}
function orgReport() {
  context.mocks.data.orgMembers({
    members: ["Alice", "Bob"].map((name) => {
      const userId = name.toLowerCase();
      return {
        userId,
        email: userId + "@example.org",
        firstName: name,
        lastName: null,
        imageUrl: "",
        role: "member",
        joinedAt: "2025-10-01T12:00:00Z",
      };
    }),
  });

  context.mocks.api(usageMembersContract.get, ({ query, respond }) => {
    const week = query.range === "7d";
    return respond(200, {
      period: { start: "2026-03-01", end: april },
      members: [
        member("alice", week ? 6100 : 6000, 1500),
        member("bob", week ? 2200 : 2100, 0),
      ],
    });
  });
}
async function teamReport() {
  await openWorkspace(context, "/?settings=usage-records");
  click(await screen.findByText("Team usage"));
  return screen.findByTestId("member-usage-alice");
}
test("org-usage-tab-006 The billing period attributes model and connector usage to their owners", async () => {
  orgReport();
  const alice = await teamReport();
  const bob = screen.getByTestId("member-usage-bob");
  await expect(within(alice).findByText("Alice")).resolves.toBeInTheDocument();
  expect(alice).toHaveTextContent("alice@example.org");
  expect(alice).toHaveTextContent("7,500");
  expect(bob).toHaveTextContent("Bob");
  expect(bob).toHaveTextContent("bob@example.org");
  expect(bob).toHaveTextContent("2,100");
  for (const [id, kind, amount] of [
    ["alice", "model", "6,000"],
    ["alice", "connector", "1,500"],
    ["bob", "model", "2,100"],
  ]) {
    const segment = screen.getByTestId("member-usage-kind-" + id + "-" + kind);
    await userEvent.hover(segment);
    await expect(
      screen.findByText(
        (kind === "model" ? "Models" : "Connectors") + " - " + amount,
      ),
    ).resolves.toBeInTheDocument();
    await userEvent.unhover(segment);
  }
});
test("org-usage-tab-009 The seven-day view replaces both members' period totals and Alice's model tooltip", async () => {
  orgReport();
  const alice = await teamReport();
  expect(alice).toHaveTextContent("7,500");
  expect(screen.getByTestId("member-usage-bob")).toHaveTextContent("2,100");
  click(await action("Billing period"));
  click(await screen.findByText("Last 7 days"));
  await expect(within(alice).findByText("7,600")).resolves.toBeInTheDocument();
  expect(screen.getByTestId("member-usage-bob")).toHaveTextContent("2,200");
  await userEvent.hover(
    within(alice).getByTestId("member-usage-kind-alice-model"),
  );
  await expect(
    screen.findByText("Models - 6,100"),
  ).resolves.toBeInTheDocument();
});

test("org-usage-tab-008 Alice's team ledger moves only data search into Connectors while preserving her 84 credits", async () => {
  const provider = (provider: string, credits: number, kind?: string) => {
    return {
      provider,
      credits,
      usageKinds: kind ? [{ kind, credits }] : [],
    };
  };
  context.mocks.api(usageMembersContract.get, ({ respond }) => {
    return respond(200, {
      period: { start: "2026-03-01", end: "2026-04-01" },
      members: [
        {
          userId: "alice",
          email: "alice@ledger.example",
          inputTokens: 70,
          outputTokens: 12,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          creditsCharged: 84,
          breakdown: [
            {
              kind: "connector",
              credits: 14,
              providers: [
                provider("slack", 7),
                provider("catalog", 2, "commerce"),
                provider("archive", 5, "data-search"),
              ],
            },
            {
              kind: "other",
              credits: 60,
              providers: [
                provider("archive", 19, "data-search/archive/units"),
                provider("catalog", 27, "commerce/catalog/units"),
                provider("legacy-data", 14),
              ],
            },
            {
              kind: "model",
              credits: 10,
              providers: [provider("gpt-5.6-sol", 10)],
            },
          ],
        },
      ],
    });
  });
  await openWorkspace(context, "/?settings=usage-records");
  click(await screen.findByText("Team usage", { selector: '[role="tab"]' }));
  const memberRow = await screen.findByTestId("member-usage-alice");
  expect(memberRow).toHaveTextContent("alice@ledger.example");
  expect(within(memberRow).getByText("84")).toBeInTheDocument();
  const user = userEvent.setup({ delay: null });
  for (const group of [
    { kind: "other", heading: "Other - 14", rows: [["Legacy Data", "14"]] },
    {
      kind: "connector",
      heading: "Connectors - 60",
      rows: [
        ["Data Search", "53"],
        ["Slack", "7"],
      ],
    },
    { kind: "model", heading: "Models - 10", rows: [["GPT 5.6 Sol", "10"]] },
  ]) {
    const bar = within(memberRow).getByTestId(
      "member-usage-kind-alice-" + group.kind,
    );
    await user.hover(bar);
    const heading = await screen.findByText(group.heading);
    const detail = heading.parentElement!;
    for (const [name, count] of group.rows) {
      expect(
        within(detail).getByText(name).nextElementSibling,
      ).toHaveTextContent(new RegExp("^" + count + "$", "u"));
    }
    await user.unhover(bar);
  }
});

test.each(["pro", "limited-free-1"])(
  "Finance can buy credits from the %s balance",
  async (tier) => {
    setBilling(context, () => {
      return billing(tier);
    });
    await openWorkspace(context, "/?settings=usage");
    click(await screen.findByTestId("credit-balance-buy-credits"));
    await expect(
      screen.findByRole("heading", { name: "Billing" }),
    ).resolves.toBeVisible();
    await expect(
      screen.findByRole("heading", { name: "Buy credits" }),
    ).resolves.toBeVisible();
  },
);

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
  fireEvent.wheel(pane, { deltaY: -pane.scrollHeight });
  pane.scrollTop = 0;
  fireEvent.scroll(pane);
  fireEvent(pane, new Event("scrollend"));
  await within(pane).findByText("Survey answer 1");
  fireEvent.wheel(pane, { deltaY: -pane.scrollHeight });
  pane.scrollTop = 0;
  fireEvent.scroll(pane);
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
