import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  halloweenContract,
  type HalloweenRound,
} from "@okouai/api-contracts/contracts/halloween";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";

const context = testContext();
const switches = Object.freeze({
  [FeatureSwitchKey.HalloweenQuiz]: true,
  [FeatureSwitchKey.HalloweenQuizModal]: true,
});
const question = Object.freeze({
  id: "QUIZ-01",
  text: "How do you pronounce Okou?",
  options: [
    { id: "C", text: "Oh cool" },
    { id: "B", text: "Goku" },
    { id: "A", text: "Oh-cow" },
  ],
});

function round(id: string): HalloweenRound {
  return {
    id,
    outcome: "playing",
    correct: 0,
    question,
    questionNumber: 1,
    feedback: null,
    startedAt: "2026-10-30T12:00:00Z",
    completedAt: null,
    linked: false,
  };
}

function button(name: string | RegExp, container: ParentNode = document.body) {
  const found = queryAllByRoleFast("button", container).find((element) => {
    const text = (
      element.getAttribute("aria-label") ??
      element.textContent ??
      ""
    ).trim();
    return typeof name === "string" ? text === name : name.test(text);
  });
  if (!found) {
    throw new Error(`Missing button: ${String(name)}`);
  }
  return found;
}

beforeEach(() => {
  context.mocks.api(halloweenContract.status, ({ respond }) => {
    return respond(200, { phase: "open", changesInMs: null });
  });
  context.mocks.api(halloweenContract.exposure, ({ respond }) => {
    return respond(200, { first: false });
  });
  context.mocks.api(halloweenContract.start, ({ body, respond }) => {
    return respond(200, round(body.id));
  });
  context.mocks.api(halloweenContract.answer, ({ body, respond }) => {
    return respond(200, {
      ...round(body.id),
      correct: 1,
      feedback: {
        correct: true,
        selectedId: body.optionId,
        explanation: "It’s oh cool.",
      },
    });
  });
  context.mocks.api(halloweenContract.leave, ({ body, respond }) => {
    return respond(200, {
      ...round(body.id),
      question: null,
      outcome: "left",
      completedAt: "2026-10-30T12:01:00Z",
    });
  });
  context.mocks.api(halloweenContract.link, ({ body, respond }) => {
    return respond(200, {
      ...round(body.id),
      question: null,
      outcome: "left",
      completedAt: "2026-10-30T12:01:00Z",
      linked: true,
    });
  });
});

test.each(["(hover: hover)", "(hover: none)"])(
  "opens the quiz in a dialog and preserves the home draft on %s",
  async (hoverQuery) => {
    context.mocks.browser.matchMedia((query) => {
      return query === hoverQuery;
    });
    await setupPage({ context, path: "/", featureSwitches: switches });
    const composer = await screen.findByRole("textbox", { name: "Message" });
    await fill(composer, "Keep my unfinished request");
    const homePath = pathname();
    const entry = await waitFor(() => {
      return button("Play the Halloween quiz");
    });
    click(entry);
    const dialog = await screen.findByRole("dialog", {
      name: "Spooky Halloween",
    });
    expect(within(dialog).getByText("Let’s play")).toBeInTheDocument();
    expect(pathname()).toBe(homePath);
    click(button("Let’s play", dialog));
    await within(dialog).findByRole("heading", { name: question.text });
    click(button(/Oh cool/, dialog));
    await within(dialog).findByText("It’s oh cool.");
    click(button("Back to Okou", dialog));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(pathname()).toBe(homePath);
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "Keep my unfinished request",
    );
    await waitFor(() => {
      expect(entry).toHaveFocus();
    });
    click(entry);
    const reopened = await screen.findByRole("dialog", {
      name: "Spooky Halloween",
    });
    expect(within(reopened).getByText("Let’s play")).toBeInTheDocument();
  },
);

test("rules open over the quiz and return to the same answer and feedback", async () => {
  await setupPage({ context, path: "/", featureSwitches: switches });
  await waitFor(() => {
    expect(button("Play the Halloween quiz")).toBeInTheDocument();
  });
  click(button("Play the Halloween quiz"));
  const dialog = await screen.findByRole("dialog", {
    name: "Spooky Halloween",
  });
  click(button("Let’s play", dialog));
  await within(dialog).findByRole("heading", { name: question.text });
  click(button(/Oh cool/, dialog));
  await within(dialog).findByText("It’s oh cool.");
  click(button("Activity rules", dialog));
  const rules = await screen.findByRole("dialog", {
    name: "Spooky Halloween — activity rules",
  });
  expect(within(rules).getByText("Your Halloween reward")).toBeInTheDocument();
  click(button("Back to game", rules));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", {
        name: "Spooky Halloween — activity rules",
      }),
    ).not.toBeInTheDocument();
  });
  expect(within(dialog).getByText("It’s oh cool.")).toBeInTheDocument();
  expect(button(/Oh cool/, dialog)).toBeDisabled();
  expect(button("Next question", dialog)).toBeEnabled();
});
