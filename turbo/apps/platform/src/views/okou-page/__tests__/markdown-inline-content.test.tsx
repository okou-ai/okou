import { sessionOutputChannelName } from "@okouai/api-contracts/contracts/realtime";
import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  completedMarkdownReply,
  createMarkdownChatFixture,
} from "./markdown-page-test-helpers.ts";
import { getAction } from "./connector-integrations-test-helpers.ts";
import {
  completedConversation,
  createChatCapabilityHelpers,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";
import { assistantRow, conversation } from "./attachment-preview-boundaries.ts";

const context = testContext();

function display(source: string) {
  return setupPage({ context, path: completedMarkdownReply(context, source) });
}
test("markdown-cjk-emphasis-001 a completed Chinese paragraph retains nested emphasis and surrounding prose", async () => {
  await display(
    "序章 **预算** 与 *明细*。\n\n***同步*** 和 **外层 *内层* 结尾** 完毕。",
  );
  await expect(
    screen.findByText("预算", { selector: "strong" }),
  ).resolves.toBeVisible();
  expect(screen.getByText("明细", { selector: "em" })).toBeVisible();
  const both = screen.getByText("同步");
  expect(both.closest("em")).toBeVisible();
  expect(both.closest("strong")).toBeVisible();
  const nested = screen.getByText("内层", { selector: "strong em" });
  expect(nested.closest("p")?.textContent).toBe(
    "同步 和 外层 内层 结尾 完毕。",
  );
  expect(screen.getByText("预算").closest("p")?.textContent).toBe(
    "序章 预算 与 明细。",
  );
});
test("markdown-cjk-emphasis-002 punctuation beside the markers stays inside the intended CJK span", async () => {
  await display("前**「初稿**后\n\n甲**终稿」**乙\n\n开*(复核)*关");
  for (const [selector, text, paragraph] of [
    ["strong", "「初稿", "前「初稿后"],
    ["strong", "终稿」", "甲终稿」乙"],
    ["em", "(复核)", "开(复核)关"],
  ]) {
    const el = await screen.findByText(text, { selector });
    expect(el).toBeVisible();
    expect(el.closest("p")?.textContent).toBe(paragraph);
  }
});
test("markdown-cjk-emphasis-008 Copy message preserves authored invisible spaces as well as the original markers", async () => {
  const ordinary = "收\u200b件",
    emphasized = "核\u200b准",
    source = ordinary + " 后 **" + emphasized + "** 完成";
  const clipboard = context.mocks.browser.clipboardWriteText();
  await display(source);
  const strong = await screen.findByText(emphasized, { selector: "strong" });
  expect(strong.closest("p")?.textContent).toBe(
    ordinary + " 后 " + emphasized + " 完成",
  );
  const row = strong.closest('[data-role="assistant"]');
  if (!row) {
    throw new Error("Missing assistant response");
  }
  click(getAction("button", "Copy message", row));
  await waitFor(() => {
    return expect(clipboard.writes).toContain(source);
  });
});
test("markdown-cjk-emphasis-003 CJK repair respects code, escapes, math and reference destinations", async () => {
  const url = "https://example.org/a*b";
  const source = [
    "甲**（通知）**乙",
    "",
    "内联 `**样例**` 及 \\*字面\\* 与 file*.csv",
    "",
    "~~~txt",
    "**保留**",
    "~~~",
    "",
    "[链接](" + url + String.raw`) 与 \(a*b\) 以及 <widget>原样</widget>`,
  ].join("\n");
  await display(source);
  await expect(
    screen.findByText("（通知）", { selector: "strong" }),
  ).resolves.toBeVisible();
  expect(screen.getByText("**样例**", { selector: "code" })).toBeVisible();
  expect(
    Array.from(document.querySelectorAll("pre code")).find((item) => {
      return item.textContent?.trim() === "**保留**";
    }),
  ).toBeVisible();
  const paragraph = screen.getByText("**样例**").closest("p");
  expect(paragraph?.textContent).toContain("*字面* 与 file*.csv");
  expect(getAction("link", "链接")).toHaveAttribute("href", url);
  const math = await screen.findByText("a*b", { selector: "annotation" });
  expect(math.getAttribute("encoding")).toBe("application/x-tex");
  expect(getAction("link", "链接").closest("p")).toHaveTextContent(
    "<widget>原样</widget>",
  );
});

test("markdown-cjk-emphasis-009 only the completed live pair becomes bold and stays bold in history", async () => {
  const chat = createMarkdownChatFixture(context),
    runId = crypto.randomUUID(),
    eventId = crypto.randomUUID(),
    runEventId = "budget-draft";
  const prompt = chat.inputPrompt("Stream the budget note", {
    seqId: 1,
    runId,
  });
  const rows = [prompt];
  chat.install({
    rows: () => {
      return rows;
    },
  });
  const channel = sessionOutputChannelName(
    "test-user-123",
    "org_default",
    runId,
  );
  await setupPage({ context, path: chat.path });
  await screen.findByText("Stream the budget note");
  await waitFor(() => {
    return expect(
      context.mocks.ably.hasSubscriptionOnChannel(channel, runId),
    ).toBeTruthy();
  });
  const chunk = (chunkIndex: number, delta: string) => {
    return context.mocks.ably.triggerOnChannel(channel, runId, {
      threadId: chat.threadId,
      runId,
      eventId,
      runEventId,
      createdAt: prompt.createdAt,
      chunkIndex,
      delta,
    });
  };
  const prefix = "前*未闭合\n\n另***未闭合\n\n开始**（预算草稿";
  const literal = () => {
    for (const text of ["前*未闭合", "另***未闭合"]) {
      const line = screen.getByText(text, { selector: "p" });
      expect(line).toBeVisible();
      expect(line.querySelector("em,strong")).toBeNull();
    }
  };
  chunk(0, prefix);
  const open = await screen.findByText("开始**（预算草稿", { selector: "p" });
  expect(open.querySelector("strong,em")).toBeNull();
  literal();
  chunk(1, "）*");
  const partial = await screen.findByText("开始**（预算草稿）*", {
    selector: "p",
  });
  expect(partial.querySelector("strong,em")).toBeNull();
  literal();
  chunk(2, "）**后文");
  const strong = await screen.findByText("（预算草稿）*）", {
    selector: "strong",
  });
  expect(strong.closest("p")?.textContent).toBe("开始（预算草稿）*）后文");
  literal();
  await expect(screen.findByLabelText("Stop")).resolves.toBeVisible();
  rows.push(
    chat.outputMessage(prefix + "）*）**后文", {
      seqId: 2,
      runId,
      id: eventId,
      runEventId,
    }),
    chat.runCompleted({ seqId: 3, runId }),
  );
  context.mocks.ably.trigger(chat.realtimeTopic);
  await waitFor(() => {
    return expect(screen.queryByLabelText("Stop")).toBeNull();
  });
  expect(
    screen.getByText("（预算草稿）*）", { selector: "strong" }).closest("p")
      ?.textContent,
  ).toBe("开始（预算草稿）*）后文");
  literal();
});

const { installCapabilityChat } = createChatCapabilityHelpers(context);

const ANSWER = [
  String.raw`Pythagoras: \(a^2 + b^2 = c^2\) holds.`,
  "",
  String.raw`\[`,
  String.raw`\int_0^1 x\,dx = \tfrac{1}{2}`,
  String.raw`\]`,
  "",
  String.raw`Label \(\text{katex-error}\) is only text.`,
  "",
  String.raw`Broken \(\frac{1}{\) stays readable.`,
  "",
  String.raw`Runaway \(\def\loop{\loop}\loop\) stays readable.`,
  "",
  "Lunch costs $5 to $10 and $AAPL closed higher.",
  "",
  `Inline code \`${String.raw`\(x + y\)`}\` stays code.`,
  "",
  "```",
  String.raw`\[ z = 1 \]`,
  "```",
].join("\n");

function formulas(status: string): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      `[data-role='assistant'] [data-math-status="${status}"]`,
    ),
  ];
}

test("Agent formulas render from explicit delimiters without treating currency as math", async () => {
  installCapabilityChat({ events: completedConversation(ANSWER) });

  await setupPage({ context, path: RUN_PATH });

  await waitFor(() => {
    expect(formulas("rendered")).toHaveLength(3);
  });
  for (const formula of formulas("rendered")) {
    expect(formula.querySelector("math")).not.toBeNull();
  }
  expect(
    formulas("hasError").map((formula) => {
      return formula.textContent;
    }),
  ).toStrictEqual([
    String.raw`\(\frac{1}{\)`,
    String.raw`\(\def\loop{\loop}\loop\)`,
  ]);
  expect(
    screen.getByText("Lunch costs $5 to $10 and $AAPL closed higher."),
  ).toBeInTheDocument();
  const code = [
    ...document.querySelectorAll<HTMLElement>("[data-role='assistant'] code"),
  ].map((element) => {
    return element.textContent?.trim();
  });
  expect(code).toStrictEqual(
    expect.arrayContaining([String.raw`\(x + y\)`, String.raw`\[ z = 1 \]`]),
  );
  for (const element of document.querySelectorAll(
    "[data-role='assistant'] code",
  )) {
    expect(element.querySelector("[data-math-status]")).toBeNull();
  }
});

function useLosAngelesBrowser() {
  vi.stubEnv("TZ", "America/Los_Angeles");
  context.signal.addEventListener(
    "abort",
    () => {
      return vi.unstubAllEnvs();
    },
    {
      once: true,
    },
  );
}
test("markdown-time-001 seasonal timestamps use the browser zone while preserving their original instants and emphasis", async () => {
  useLosAngelesBrowser();
  context.mocks.data.userPreferences({ timezone: "Pacific/Auckland" });
  const summer = "2026-09-09T15:00:00+08:00",
    winter = "2026-01-09T07:00:00Z";
  await conversation(context, {
    chatEvents: [
      assistantRow(
        'Summer **<time datetime="' +
          summer +
          '">depart</time>** and winter <time datetime="' +
          winter +
          '">arrive</time>.',
      ),
    ],
  });
  const departure = await screen.findByText("Sep 9, 2026, 12:00:00 AM PDT", {
    selector: "time",
  });
  expect(departure).toHaveAttribute("datetime", summer);
  expect(departure.closest("strong")).toBeVisible();
  expect(
    screen.getByText("Jan 8, 2026, 11:00:00 PM PST", { selector: "time" }),
  ).toHaveAttribute("datetime", winter);
});
test("markdown-time-003 non-instant time tags retain their authored labels", async () => {
  useLosAngelesBrowser();
  const inputs = [
    [undefined, "No datetime provided"],
    ["", "Empty datetime"],
    ["not-a-date", "Invalid datetime"],
    ["2026-02-30T00:00:00Z", "Invalid calendar date"],
    ["2026-11-21", "Date only"],
    ["2026-11-21T09:30:00", "No timezone offset"],
    ["PT30M", "Duration"],
  ] as const;
  const message = inputs
    .map(([value, label]) => {
      return (
        "<time" +
        (value === undefined ? "" : ' datetime="' + value + '"') +
        ">" +
        label +
        "</time>"
      );
    })
    .join(" / ");
  await conversation(context, { chatEvents: [assistantRow(message)] });
  for (const [, label] of inputs) {
    await expect(
      screen.findByText(label, { selector: "time" }),
    ).resolves.toBeVisible();
  }
});
