import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  completedConversation,
  createChatCapabilityHelpers,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";

const context = testContext();
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
