import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { state } from "ccstate";
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
import { localStorageSignals } from "../../../signals/external/local-storage.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname, search } from "../../../signals/location.ts";

const context = testContext();
const homeAnimationStorage = localStorageSignals(
  "halloween_2026_home_animation_seen",
);
const switches = Object.freeze({
  [FeatureSwitchKey.HalloweenQuiz]: true,
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
const correctExplanation =
  "It’s “oh cool.” Like your reaction when your AI teammate gets work done right and fast.";
const roundIds = Object.freeze([
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
]);
const currentRound$ = state<HalloweenRound | null>(null);
const startedRounds$ = state(0);

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
  context.store.set(currentRound$, null);
  context.store.set(startedRounds$, 0);
  context.mocks.api(halloweenContract.status, ({ respond }) => {
    return respond(200, { phase: "open" });
  });
  context.mocks.api(halloweenContract.current, ({ respond }) => {
    const currentRound = context.store.get(currentRound$);
    return currentRound
      ? respond(200, currentRound)
      : respond(404, {
          error: { code: "NOT_FOUND", message: "Game result not found" },
        });
  });
  context.mocks.api(halloweenContract.start, ({ body, respond }) => {
    const currentRound = context.store.get(currentRound$);
    if (!body.restart && currentRound) {
      return respond(200, currentRound);
    }
    const startedRounds = context.store.get(startedRounds$);
    const started = round(roundIds[startedRounds % roundIds.length]!);
    context.store.set(currentRound$, started);
    context.store.set(startedRounds$, startedRounds + 1);
    return respond(200, started);
  });
  context.mocks.api(halloweenContract.answer, ({ body, respond }) => {
    const answered = {
      ...round(body.id),
      correct: 1,
      feedback: {
        correct: true,
        selectedId: body.optionId,
        explanation: "It’s oh cool.",
      },
    };
    context.store.set(currentRound$, answered);
    return respond(200, answered);
  });
});

test("the email deep link opens the quiz and returns to the chat when dismissed", async () => {
  await setupPage({
    context,
    path: "/?halloween=1&prompt=Keep%20my%20request",
    featureSwitches: switches,
  });
  const dialog = await screen.findByRole("dialog", {
    name: "Spooky Halloween",
  });
  expect(within(dialog).getByText("Let’s go")).toBeInTheDocument();
  expect(new URLSearchParams(search()).get("halloween")).toBeNull();
  expect(screen.queryByTestId("halloween-bubbles")).not.toBeInTheDocument();

  click(button("Back to Okou", dialog));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Spooky Halloween" }),
    ).not.toBeInTheDocument();
  });
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "Keep my request",
    );
  });
  click(button("Play the Halloween quiz"));
  await expect(
    screen.findByRole("dialog", { name: "Spooky Halloween" }),
  ).resolves.toBeInTheDocument();
});

test("shows the first-visit home animation", async () => {
  await setupPage({ context, path: "/", featureSwitches: switches });
  await expect(
    screen.findByTestId("halloween-bubbles"),
  ).resolves.toBeInTheDocument();
});

test("does not repeat the home animation stored in this browser", async () => {
  context.store.set(homeAnimationStorage.set$, "seen");
  await setupPage({ context, path: "/", featureSwitches: switches });
  await waitFor(() => {
    expect(button("Play the Halloween quiz")).toBeInTheDocument();
  });
  expect(screen.queryByTestId("halloween-bubbles")).not.toBeInTheDocument();
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
    expect(within(dialog).getByText("Let’s go")).toBeInTheDocument();
    expect(pathname()).toBe(homePath);
    click(button("Let’s go", dialog));
    await within(dialog).findByRole("heading", { name: question.text });
    click(button(/Oh cool/, dialog));
    await within(dialog).findByText(correctExplanation);
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
    expect(within(reopened).getByText(correctExplanation)).toBeInTheDocument();
    expect(button(/Oh cool/, reopened)).toBeDisabled();
  },
);

test.each(["success", "wrong"] as const)(
  "restores a completed %s result with outcome-specific actions until replay",
  async (outcome) => {
    context.store.set(currentRound$, {
      ...round(roundIds[0]!),
      outcome,
      correct: outcome === "success" ? 5 : 0,
      question: null,
      questionNumber: outcome === "success" ? 5 : 1,
      feedback: {
        correct: outcome === "success",
        selectedId: "A",
        explanation:
          outcome === "success"
            ? "Oh cool. Okou likes you too!"
            : "Okou got you this time...",
      },
      completedAt: "2026-10-30T12:05:00Z",
    });
    await setupPage({ context, path: "/", featureSwitches: switches });
    await waitFor(() => {
      expect(button("Play the Halloween quiz")).toBeInTheDocument();
    });
    click(button("Play the Halloween quiz"));
    const dialog = await screen.findByRole("dialog", {
      name: "Spooky Halloween",
    });
    await within(dialog).findByRole("heading", {
      name: outcome === "success" ? "You passed the quiz!" : "You got tricked!",
    });
    const redeem = queryAllByRoleFast("link", dialog).find((element) => {
      return element.textContent?.trim() === "Redeem";
    });
    const email = redeem
      ? new URL(redeem.getAttribute("href") ?? "")
      : undefined;
    expect(
      email && {
        protocol: email.protocol,
        recipient: email.pathname,
        subject: email.searchParams.get("subject"),
        body: email.searchParams.get("body"),
      },
    ).toStrictEqual(
      outcome === "success"
        ? {
            protocol: "mailto:",
            recipient: "contact@okou.ai",
            subject: "Halloween reward redemption",
            body: [
              "Hi Okou team,",
              "",
              "I passed the Halloween quiz and would like to redeem my 7-day Okou Pro trial.",
              "",
              "Okou account email: [Your account email]",
              "",
              "Thank you!",
            ].join("\r\n"),
          }
        : undefined,
    );
    click(button("Play again", dialog));
    await within(dialog).findByRole("heading", { name: question.text });
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
  click(button("Let’s go", dialog));
  await within(dialog).findByRole("heading", { name: question.text });
  click(button(/Oh cool/, dialog));
  await within(dialog).findByText(correctExplanation);
  click(button("Activity rules", dialog));
  const rules = await screen.findByRole("dialog", {
    name: "Spooky Halloween — Activity rules",
  });
  expect(within(rules).getByText("Your Halloween reward")).toBeInTheDocument();
  expect(
    within(rules).getByText(
      "If the activity becomes unavailable, your saved round stays intact and can be resumed when it appears again.",
      { exact: false },
    ),
  ).toBeInTheDocument();
  click(button("Back to game", rules));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", {
        name: "Spooky Halloween — Activity rules",
      }),
    ).not.toBeInTheDocument();
  });
  expect(within(dialog).getByText(correctExplanation)).toBeInTheDocument();
  expect(button(/Oh cool/, dialog)).toBeDisabled();
  expect(button("Next question", dialog)).toBeEnabled();
});

test("keeps ordinary home usable when the campaign endpoint is unavailable and the switch is off", async () => {
  context.mocks.api(halloweenContract.status, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Campaign endpoint unavailable" },
    });
  });
  await setupPage({
    context,
    path: "/?halloween=1",
    featureSwitches: { [FeatureSwitchKey.HalloweenQuiz]: false },
  });
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await fill(composer, "Keep working without the campaign");
  expect(composer).toHaveTextContent("Keep working without the campaign");
  expect(
    screen.queryByRole("dialog", { name: "Spooky Halloween" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText("Campaign endpoint unavailable"),
  ).not.toBeInTheDocument();
  expect(
    queryAllByRoleFast("button").find((element) => {
      return element.getAttribute("aria-label") === "Play the Halloween quiz";
    }),
  ).toBeUndefined();
});

test("the email deep link respects the campaign availability window", async () => {
  context.mocks.api(halloweenContract.status, ({ respond }) => {
    return respond(200, { phase: "unavailable" });
  });
  await setupPage({
    context,
    path: "/?halloween=1",
    featureSwitches: switches,
  });
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await fill(composer, "Keep working outside the campaign");
  expect(composer).toHaveTextContent("Keep working outside the campaign");
  expect(
    screen.queryByRole("dialog", { name: "Spooky Halloween" }),
  ).not.toBeInTheDocument();
});

test("opens by keyboard and restores focus through nested Escape dismissal", async () => {
  await setupPage({ context, path: "/", featureSwitches: switches });
  const entry = await waitFor(() => {
    return button("Play the Halloween quiz");
  });
  entry.focus();
  await userEvent.keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog", {
    name: "Spooky Halloween",
  });
  const rulesButton = button("Activity rules", dialog);
  rulesButton.focus();
  await userEvent.keyboard(" ");
  await screen.findByRole("dialog", {
    name: "Spooky Halloween — Activity rules",
  });
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", {
        name: "Spooky Halloween — Activity rules",
      }),
    ).not.toBeInTheDocument();
    expect(rulesButton).toHaveFocus();
  });
  expect(dialog).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Spooky Halloween" }),
    ).not.toBeInTheDocument();
    expect(entry).toHaveFocus();
  });
});
