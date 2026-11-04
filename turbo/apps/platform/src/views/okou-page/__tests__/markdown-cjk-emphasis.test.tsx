import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createMarkdownChatFixture,
  type MarkdownChatFixture,
} from "./markdown-page-test-helpers.ts";

const context = testContext();

function completedMessageRows(chat: MarkdownChatFixture, content: string) {
  return [
    chat.outputMessage(content, { seqId: 1 }),
    chat.runCompleted({ seqId: 2 }),
  ];
}

function markdownFrameFor(element: Element): HTMLElement {
  const frame = element.closest<HTMLElement>(".wmde-markdown");
  if (!frame) {
    throw new Error("Expected content inside a Markdown frame");
  }
  return frame;
}

function paragraphTexts(frame: ParentNode) {
  return Array.from(frame.querySelectorAll("p"), (paragraph) => {
    return paragraph.textContent;
  });
}

test("Complete CJK emphasis pairs render semantic bold, italic, and nested emphasis by default", async () => {
  const chat = createMarkdownChatFixture(context);
  const source = [
    "前文**（加粗）**后文",
    "前文*“斜体”*后文",
    "前文***「粗斜体」***后文",
    "**机构与身份：**个人站 Artibiotics",
    "前文**加粗（*“嵌套”*）**后文",
  ].join("\n\n");
  const rows = completedMessageRows(chat, source);
  chat.install({
    rows: () => {
      return rows;
    },
  });

  await setupPage({
    context,
    path: chat.path,
    host: "app.okou.ai",
  });

  const bold = await screen.findByText("（加粗）", { selector: "strong" });
  const frame = markdownFrameFor(bold);
  expect(bold.tagName).toBe("STRONG");
  expect(screen.getByText("“斜体”").tagName).toBe("EM");
  expect(frame.querySelector("strong em, em strong")?.textContent).toBe(
    "「粗斜体」",
  );
  expect(paragraphTexts(frame)).toStrictEqual([
    "前文（加粗）后文",
    "前文“斜体”后文",
    "前文「粗斜体」后文",
    "机构与身份：个人站 Artibiotics",
    "前文加粗（“嵌套”）后文",
  ]);
  expect(screen.getByText("机构与身份：").tagName).toBe("STRONG");
  expect(frame.querySelector("strong > em")?.textContent).toBe("“嵌套”");
});

test("Opening and closing punctuation boundaries work independently next to CJK text", async () => {
  const chat = createMarkdownChatFixture(context);
  const source = [
    "甲**（开括号**乙",
    "丙**闭括号）**丁",
    "戊*(ASCII括号)*己",
  ].join("\n\n");
  const rows = completedMessageRows(chat, source);
  chat.install({
    rows: () => {
      return rows;
    },
  });

  await setupPage({
    context,
    path: chat.path,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.MarkdownCjkEmphasis]: true },
  });

  const opening = await screen.findByText("（开括号", { selector: "strong" });
  const frame = markdownFrameFor(opening);
  expect(screen.getByText("闭括号）").tagName).toBe("STRONG");
  expect(screen.getByText("(ASCII括号)").tagName).toBe("EM");
  expect(paragraphTexts(frame)).toStrictEqual([
    "甲（开括号乙",
    "丙闭括号）丁",
    "戊(ASCII括号)己",
  ]);
});

test("CJK boundary repair preserves code, escapes, link destinations, math source, and literal asterisks", async () => {
  const chat = createMarkdownChatFixture(context);
  const inlineCode = "中**（行内代码）**文";
  const fencedCode = "中***“围栏代码”***文";
  const destination = "https://example.com/中**（目标）**文?stars=*value*";
  const formula = String.raw`\text{中**（公式）**文}`;
  const escapedText = "转义：**（不加粗）**，*“不倾斜”*，***「不嵌套」***";
  const literalAsterisks = "星号原文：2 * 3 = 6；file*.txt；a**b";
  const source = [
    "前文**（只修正文案）**后文",
    "",
    `\`${inlineCode}\``,
    "",
    "```text",
    fencedCode,
    "```",
    "",
    String.raw`转义：\*\*（不加粗）\*\*，\*“不倾斜”\*，\*\*\*「不嵌套」\*\*\*`,
    "",
    `[原始链接](${destination})`,
    "",
    String.raw`公式：\(${formula}\)`,
    "",
    String.raw`**未闭合公式\(\text{标点。**后}\)`,
    "",
    String.raw`**转义闭合：\**后`,
    "",
    String.raw`*中\!*后`,
    "",
    "**未闭合链接 https://example.net/x：**after",
    "",
    "Raw block <pre>前**（原文）**后</pre>",
    "",
    "**外部未闭合 <code>前：**后</code>",
    "",
    literalAsterisks,
  ].join("\n");
  const rows = completedMessageRows(chat, source);
  chat.install({
    rows: () => {
      return rows;
    },
  });

  await setupPage({
    context,
    path: chat.path,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.MarkdownCjkEmphasis]: true },
  });

  const repaired = await screen.findByText("（只修正文案）", {
    selector: "strong",
  });
  const frame = markdownFrameFor(repaired);
  await waitFor(() => {
    expect(
      frame.querySelector('annotation[encoding="application/x-tex"]')
        ?.textContent,
    ).toBe(formula);
  });
  expect(frame.querySelector("p > code")?.textContent).toBe(inlineCode);
  expect(frame.querySelector("pre code")?.textContent).toBe(`${fencedCode}\n`);
  expect(screen.getByText(escapedText).textContent).toBe(escapedText);
  expect(screen.getByText(literalAsterisks).textContent).toBe(literalAsterisks);
  const link = queryAllByRoleFast("link", frame).find((candidate) => {
    return candidate.textContent === "原始链接";
  });
  expect(link).toHaveAttribute("href", encodeURI(destination));
  expect(
    Array.from(
      frame.querySelectorAll('annotation[encoding="application/x-tex"]'),
      (annotation) => {
        return annotation.textContent;
      },
    ),
  ).toStrictEqual([formula, String.raw`\text{标点。**后}`]);
  expect(screen.getByText("**转义闭合：**后").textContent).toBe(
    "**转义闭合：**后",
  );
  expect(screen.getByText("*中!*后").textContent).toBe("*中!*后");
  expect(screen.getByText("前**（原文）**后").tagName).toBe("PRE");
  expect(
    screen.getByText("前：**后", { selector: "code" }).closest("strong"),
  ).toBeNull();
  expect(
    queryAllByRoleFast("link", frame).find((candidate) => {
      return (
        candidate.getAttribute("href") ===
        encodeURI("https://example.net/x：**after")
      );
    }),
  ).toBeInTheDocument();
  expect(frame.querySelectorAll("strong, em")).toHaveLength(1);
  expect(frame.textContent).not.toContain("\u200b");
});

test("Closed emphasis does not use formula, code, or bare-link asterisks as its closer", async () => {
  const chat = createMarkdownChatFixture(context);
  const formula = String.raw`\text{公式：**内部}`;
  const url = "https://example.net/x：**after";
  const source = [
    String.raw`**外` + "`\\(`" + String.raw`中\(${formula}\)尾：**续`,
    `**外 ${url} 尾：**续`,
    "**外 <code>代码：**原文</code> 尾：**续",
  ].join("\n\n");
  const rows = completedMessageRows(chat, source);
  chat.install({
    rows: () => {
      return rows;
    },
  });

  await setupPage({
    context,
    path: chat.path,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.MarkdownCjkEmphasis]: true },
  });

  const code = await screen.findByText(String.raw`\(`, { selector: "code" });
  const frame = markdownFrameFor(code);
  expect(code.closest("strong")).toBeInTheDocument();
  await waitFor(() => {
    expect(
      frame.querySelector('annotation[encoding="application/x-tex"]')
        ?.textContent,
    ).toBe(formula);
  });
  const link = queryAllByRoleFast("link", frame).find((candidate) => {
    return candidate.getAttribute("href") === encodeURI(url);
  });
  expect(link).toBeInTheDocument();
  expect(link?.closest("strong")).toBeInTheDocument();
  expect(
    screen.getByText("代码：**原文", { selector: "code" }).closest("strong"),
  ).toBeInTheDocument();
  expect(frame.querySelectorAll("strong")).toHaveLength(3);
});

test.each(["code", "kbd"])(
  "Quoted angle brackets do not expose raw %s asterisks as emphasis closers",
  async (tag) => {
    const chat = createMarkdownChatFixture(context);
    const source = [
      "前文**（验收）**后文",
      `**外 <${tag} title="<">未闭合代码：**原文</${tag}>`,
      `**完整 <${tag} title="<">闭合代码：**原文</${tag}> 尾：**续`,
    ].join("\n\n");
    const rows = completedMessageRows(chat, source);
    chat.install({
      rows: () => {
        return rows;
      },
    });

    await setupPage({
      context,
      path: chat.path,
      host: "app.okou.ai",
      featureSwitches: { [FeatureSwitchKey.MarkdownCjkEmphasis]: true },
    });

    const repaired = await screen.findByText("（验收）", {
      selector: "strong",
    });
    const frame = markdownFrameFor(repaired);
    const unclosed = screen.getByText("未闭合代码：**原文", { selector: tag });
    expect(unclosed.closest("strong, em")).toBeNull();
    const closed = screen.getByText("闭合代码：**原文", { selector: tag });
    expect(closed.closest("strong")?.textContent).toBe(
      "完整 闭合代码：**原文 尾：",
    );
    expect(frame.querySelectorAll(tag)).toHaveLength(2);
    expect(frame.querySelectorAll("strong, em")).toHaveLength(2);
    expect(frame.textContent).toContain("**外 未闭合代码：**原文");
  },
);

test("Long literal-star paragraphs preserve text alongside repairable CJK emphasis", async () => {
  const chat = createMarkdownChatFixture(context);
  const literal = "file*.txt ".repeat(4000) + "中文末尾";
  const source = [literal, "前文**（修复）**后文", "中*~内容：*后文"].join(
    "\n\n",
  );
  const rows = completedMessageRows(chat, source);
  chat.install({
    rows: () => {
      return rows;
    },
  });

  await setupPage({
    context,
    path: chat.path,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.MarkdownCjkEmphasis]: true },
  });

  const repaired = await screen.findByText("（修复）", { selector: "strong" });
  const frame = markdownFrameFor(repaired);
  const paragraph = frame.querySelector("p");
  expect(paragraph?.textContent).toBe(literal);
  expect(paragraph?.querySelector("strong, b, em, i")).toBeNull();
  expect(screen.getByText("~内容：", { selector: "em" })).toBeInTheDocument();
  expect(frame.querySelectorAll("strong, em")).toHaveLength(2);
});

test("Rendered text preserves authored zero-width spaces and Copy message keeps the exact raw source", async () => {
  const chat = createMarkdownChatFixture(context);
  const source = [
    "前文**（无需空格）**后文",
    "原有\u200b间隔**“保\u200b留”**结束\u200b。",
  ].join("\n\n");
  const rows = completedMessageRows(chat, source);
  const clipboard = context.mocks.browser.clipboardWriteText();
  chat.install({
    rows: () => {
      return rows;
    },
  });

  await setupPage({
    context,
    path: chat.path,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.MarkdownCjkEmphasis]: true },
  });

  const bold = await screen.findByText("（无需空格）", { selector: "strong" });
  const frame = markdownFrameFor(bold);
  expect(paragraphTexts(frame)).toStrictEqual([
    "前文（无需空格）后文",
    "原有\u200b间隔“保\u200b留”结束\u200b。",
  ]);
  const assistant = frame.closest('[data-role="assistant"]');
  if (!assistant) {
    throw new Error("Expected the assistant message containing the Markdown");
  }
  const copy = queryAllByRoleFast("button", assistant).find((candidate) => {
    return candidate.getAttribute("aria-label") === "Copy message";
  });
  if (!copy) {
    throw new Error("Expected the assistant's Copy message action");
  }

  click(copy);

  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([source]);
  });
});

test("Streaming leaves unclosed runs literal and repairs only a pair completed by appended text", async () => {
  const chat = createMarkdownChatFixture(context);
  const unfinished = ["未闭合单星*（斜体", "未闭合三星***“粗斜体"];
  const partial = "流式前文**（尚未完成";
  const initial = [...unfinished, partial].join("\n\n");
  const rows = [
    chat.outputMessage(initial, {
      id: "cjk-stream",
      runEventId: "cjk-stream",
      seqId: 1,
    }),
  ];
  chat.install({
    rows: () => {
      return rows;
    },
  });

  await setupPage({
    context,
    path: chat.path,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.MarkdownCjkEmphasis]: true },
  });

  const streaming = await screen.findByText(partial);
  const initialFrame = markdownFrameFor(streaming);
  expect(paragraphTexts(initialFrame)).toStrictEqual([...unfinished, partial]);
  expect(initialFrame.querySelectorAll("strong, em")).toHaveLength(0);

  rows[0] = chat.outputMessage(`${initial}）*`, {
    id: "cjk-stream",
    runEventId: "cjk-stream",
    seqId: 2,
    sequenceNumber: 2,
  });
  context.mocks.ably.trigger(chat.realtimeTopic);

  const incompleteClosing = await screen.findByText(`${partial}）*`);
  const incompleteFrame = markdownFrameFor(incompleteClosing);
  expect(paragraphTexts(incompleteFrame)).toStrictEqual([
    ...unfinished,
    `${partial}）*`,
  ]);
  expect(incompleteFrame.querySelectorAll("strong, em")).toHaveLength(0);

  rows[0] = chat.outputMessage(`${initial}）**后文`, {
    id: "cjk-stream",
    runEventId: "cjk-stream",
    seqId: 3,
    sequenceNumber: 3,
  });
  rows.push(chat.runCompleted({ seqId: 4, sequenceNumber: 4 }));
  context.mocks.ably.trigger(chat.realtimeTopic);

  const completed = await screen.findByText("（尚未完成）", {
    selector: "strong",
  });
  const completedFrame = markdownFrameFor(completed);
  expect(paragraphTexts(completedFrame)).toStrictEqual([
    ...unfinished,
    "流式前文（尚未完成）后文",
  ]);
  expect(completedFrame.querySelectorAll("strong, em")).toHaveLength(1);
});

test("Disabling CJK emphasis retains legacy literals without changing ordinary Markdown", async () => {
  const chat = createMarkdownChatFixture(context);
  const literals = [
    "前文**（加粗）**后文",
    "前文*“斜体”*后文",
    "前文***「粗斜体」***后文",
  ];
  const source = [...literals, "**Existing bold** and *existing italic*"].join(
    "\n\n",
  );
  const rows = completedMessageRows(chat, source);
  chat.install({
    rows: () => {
      return rows;
    },
  });

  await setupPage({
    context,
    path: chat.path,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.MarkdownCjkEmphasis]: false },
  });

  const bold = await screen.findByText("Existing bold", { selector: "strong" });
  const frame = markdownFrameFor(bold);
  expect(screen.getByText("existing italic").tagName).toBe("EM");
  expect(paragraphTexts(frame)).toStrictEqual([
    ...literals,
    "Existing bold and existing italic",
  ]);
  expect(frame.querySelectorAll("strong, em")).toHaveLength(2);
});
