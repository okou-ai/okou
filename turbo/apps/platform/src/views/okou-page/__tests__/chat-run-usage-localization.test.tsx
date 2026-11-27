import { screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import {
  setupPage,
  queryAllByRoleFast,
  click,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { action, findAction } from "./workspace-billing-fixtures.ts";
import {
  RUN_PATH,
  createChatRunFixtures,
  promptEvent,
  assistantEvent,
  completedEvent,
  creditUsage,
  usageEvent,
} from "./chat-run-test-fixtures.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
const context = testContext();
function visit() {
  return setupPage({
    context,
    path: RUN_PATH,
    host: "app.okou.ai",
  });
}
type Origin =
  "slack" | "feishu" | "teams" | "github" | "telegram" | "agentphone" | "lark";
interface Source {
  kind: Origin;
  href?: string;
  name: string;
  action?: string;
  label?: string;
}
async function enterConversation(sources: Source[]) {
  const height = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientHeight",
  )?.get;
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return Object.hasOwn(this.dataset, "scrollContainer")
        ? 1200
        : Number(height?.call(this) ?? 0);
    },
  );
  const events: MockChatEventInput[] = [];
  for (const [index, source] of sources.entries()) {
    const seqId = index * 3 + 1,
      runId = crypto.randomUUID(),
      text = "Dispatch " + String(index + 1);
    events.push(
      {
        ...promptEvent({ id: crypto.randomUUID(), seqId, runId, text }),
        userMessage: {
          version: 1,
          parts: [
            {
              type: "source",
              kind: source.kind,
              ...(source.href ? { href: source.href } : {}),
            },
            { type: "text", text },
          ],
        },
      },
      completedEvent({ id: crypto.randomUUID(), runId, seqId: seqId + 2 }),
    );
  }
  createChatRunFixtures(context).installRunChat({ chatEvents: events });
  await visit();
}
async function dispatchRow(index: number) {
  const prompt = await screen.findByText("Dispatch " + String(index + 1));
  const row = prompt.closest<HTMLElement>('[data-role="user"]');
  if (!row) {
    throw new Error("Missing dispatch message");
  }
  return row;
}
test("chat-run-usage-localization-001 Each completed dispatch identifies its service and distinguishes chat from message links", async () => {
  const sources = [
    {
      kind: "github",
      name: "GitHub",
      href: "https://github.com/example/local/issues/42",
      label: "Open original issue or pull request in GitHub",
      action: "Open message",
    },
    {
      kind: "telegram",
      name: "Telegram",
      href: "https://t.me/ledger_test",
      label: "Open chat in Telegram",
      action: "Open chat",
    },
    {
      kind: "slack",
      name: "Slack",
      href: "https://local.slack.com/archives/C123/p456",
      label: "Open original message in Slack",
      action: "Open message",
    },
    {
      kind: "teams",
      name: "Microsoft Teams",
      href: "https://teams.microsoft.com/l/chat/19:ledger",
      label: "Open chat in Microsoft Teams",
      action: "Open chat",
    },
    {
      kind: "feishu",
      name: "Feishu",
      href: "https://open.feishu.cn/chat/ledger",
      label: "Open original chat in Feishu",
      action: "Open chat",
    },
    {
      kind: "telegram",
      name: "Telegram",
      href: "https://t.me/ledger_test/7",
      label: "Open original message in Telegram",
      action: "Open message",
    },
    {
      kind: "teams",
      name: "Microsoft Teams",
      href: "https://teams.microsoft.com/l/message/19:ledger/7",
      label: "Open original message in Microsoft Teams",
      action: "Open message",
    },
  ] as const;
  await enterConversation([
    ...sources,
    { kind: "agentphone", name: "iMessage" },
  ]);
  for (const [index, source] of sources.entries()) {
    const row = await dispatchRow(index);
    const link = queryAllByRoleFast("link", row).find((el) => {
      return el.getAttribute("href") === source.href;
    });
    expect(link).toHaveAccessibleName(source.label);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveTextContent(source.name);
    expect(link).toHaveTextContent(source.action);
  }
  const sms = await dispatchRow(sources.length);
  expect(within(sms).getByText("iMessage")).toBeInTheDocument();
  expect(queryAllByRoleFast("link", sms)).toHaveLength(0);
});
test("chat-run-usage-localization-003 The canonical Lark dispatch links back to its own chat", async () => {
  const source = {
    kind: "lark",
    name: "Lark",
    href: "https://open.larksuite.com/chat/ch_123",
    label: "Open original chat in Lark",
    action: "Open chat",
  } as const;
  await enterConversation([source]);
  const row = await dispatchRow(0);
  const link = queryAllByRoleFast("link", row).find((el) => {
    return el.getAttribute("aria-label") === source.label;
  });
  expect(link).toHaveTextContent("Lark");
  expect(link).toHaveAttribute("href", source.href);
  expect(link).toHaveAttribute("target", "_blank");
});
test("chat-run-usage-localization-005 The current settlement belongs to its run and Slack's breakdown opens independently", async () => {
  const forecast = crypto.randomUUID(),
    delivery = crypto.randomUUID(),
    first = crypto.randomUUID();
  const model = (amount: number) => {
    return creditUsage(amount, [
      {
        kind: "model",
        credits: amount,
        providers: [{ provider: "gpt-5.6-sol", credits: amount }],
      },
    ]);
  };
  const slack = creditUsage(3, [
    {
      kind: "connector",
      credits: 3,
      providers: [{ provider: "slack", credits: 3 }],
    },
  ]);
  createChatRunFixtures(context).installRunChat({
    runUsage: { [forecast]: model(8), [delivery]: slack },
    chatEvents: [
      promptEvent({
        id: crypto.randomUUID(),
        runId: forecast,
        seqId: 1,
        text: "Compute forecast",
      }),
      assistantEvent({
        id: crypto.randomUUID(),
        runId: forecast,
        seqId: 2,
        text: "Forecast complete",
      }),
      completedEvent({ id: crypto.randomUUID(), runId: forecast, seqId: 3 }),
      usageEvent({ id: first, runId: forecast, seqId: 4, usage: model(5) }),
      usageEvent({
        id: crypto.randomUUID(),
        revokesEventId: first,
        runId: forecast,
        seqId: 5,
        usage: model(999),
      }),
      promptEvent({
        id: crypto.randomUUID(),
        runId: delivery,
        seqId: 6,
        text: "Share to Slack",
      }),
      assistantEvent({
        id: crypto.randomUUID(),
        runId: delivery,
        seqId: 7,
        text: "Posted the forecast",
      }),
      completedEvent({ id: crypto.randomUUID(), runId: delivery, seqId: 8 }),
      usageEvent({
        id: crypto.randomUUID(),
        runId: delivery,
        seqId: 9,
        usage: slack,
      }),
    ],
  });
  await visit();
  const firstAnswer = await screen.findByText("Forecast complete"),
    secondAnswer = await screen.findByText("Posted the forecast");
  const forecastGroup = firstAnswer.closest<HTMLElement>(
    '[data-role="assistant"]',
  );
  const deliveryGroup = secondAnswer.closest<HTMLElement>(
    '[data-role="assistant"]',
  );
  if (!forecastGroup || !deliveryGroup) {
    throw new Error("Missing conversation turn");
  }
  await expect(action("Credit usage 8", forecastGroup)).resolves.toBeEnabled();
  const later = await action("Credit usage 3", deliveryGroup);
  expect(findAction("Credit usage 5")).toBeUndefined();
  expect(findAction("Credit usage 999")).toBeUndefined();
  click(later);
  const detail = await screen.findByText("Slack");
  expect(detail.nextElementSibling).toHaveTextContent(/^3$/u);
  expect(screen.queryByText("GPT 5.6 Sol")).toBeNull();
});
