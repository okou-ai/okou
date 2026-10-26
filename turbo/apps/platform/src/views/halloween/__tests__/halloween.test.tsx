import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import {
  halloweenContract,
  type HalloweenRound,
} from "@okouai/api-contracts/contracts/halloween";
import {
  click,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

import { createDeferredPromise } from "../../../signals/utils.ts";

const context = testContext();
function control(role: "button" | "link", name: string | RegExp) {
  const found = queryAllByRoleFast(role).find((element) => {
    const text = (
      element.getAttribute("aria-label") ??
      element.textContent ??
      ""
    ).trim();
    return typeof name === "string" ? text === name : name.test(text);
  });
  if (!found) {
    throw new Error(`Missing ${role}: ${String(name)}`);
  }
  return found;
}

// The product intentionally holds the wrong-answer state for 1.1 seconds.
// Observe its next screen, without mocking timers or increasing test timeouts.
function waitForResult() {
  const done = createDeferredPromise<void>(context.signal);
  const cleanup = () => {
    observer.disconnect();
    context.signal.removeEventListener("abort", cleanup);
  };
  const check = () => {
    if (
      document.querySelector("h1")?.textContent?.trim() === "You got tricked!"
    ) {
      cleanup();
      done.resolve();
    }
  };
  const observer = new MutationObserver(check);
  observer.observe(document.body, { childList: true, subtree: true });
  context.signal.addEventListener("abort", cleanup, { once: true });
  check();
  return done.promise;
}

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
beforeEach(() => {
  context.mocks.api(halloweenContract.exposure, ({ respond }) => {
    return respond(200, { first: false });
  });
  context.mocks.api(halloweenContract.status, ({ respond }) => {
    return respond(200, { phase: "open", changesInMs: null });
  });
  context.mocks.api(halloweenContract.start, ({ body, respond }) => {
    return respond(200, round(body.id));
  });
});

test("a touch-generated mouseenter does not skip the ghost's first-tap greeting", async () => {
  context.mocks.browser.matchMedia((query) => {
    return query === "(hover: none)";
  });
  await setupPage({ context, path: "/" });
  const entry = await waitFor(() => {
    return control("link", "Play the Halloween quiz");
  });
  fireEvent.mouseEnter(entry);
  await click(entry);
  expect(entry).toBeInTheDocument();
  expect(screen.queryByText("Let’s play")).not.toBeInTheDocument();
  await click(entry);
  await expect(screen.findByText("Let’s play")).resolves.toBeInTheDocument();
});

test("returns to the existing homepage and retries the same result after association fails", async () => {
  const linkedIds: string[] = [];
  context.mocks.api(halloweenContract.answer, ({ body, respond }) => {
    return respond(200, {
      ...round(body.id),
      outcome: "wrong",
      question: null,
      completedAt: "2026-10-30T12:01:00Z",
      feedback: {
        selectedId: body.optionId,
        correct: false,
        explanation: "Okou got you this time.",
      },
    });
  });
  context.mocks.api(halloweenContract.link, ({ body, respond }) => {
    linkedIds.push(body.id);
    if (linkedIds.length === 1) {
      return respond(500, {
        error: { code: "INTERNAL_SERVER_ERROR", message: "Please retry" },
      });
    }
    return respond(200, {
      ...round(body.id),
      outcome: "wrong",
      question: null,
      completedAt: "2026-10-30T12:01:00Z",
      linked: true,
    });
  });
  await setupPage({ context, path: "/halloween" });
  await click(control("button", "Let’s play"));
  await click(
    await waitFor(() => {
      return control("button", /Goku/);
    }),
  );
  await waitForResult();
  const home = control("link", /Make magic with Okou/);
  await click(home);
  await expect(
    screen.findByText("We couldn’t save your game result."),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText(/contact support@okou.ai/)).toBeInTheDocument();
  await click(control("button", "Try again"));
  await expect(
    screen.findByText("Game result saved."),
  ).resolves.toBeInTheDocument();
  expect(linkedIds).toHaveLength(2);
  expect(linkedIds[0]).toBe(linkedIds[1]);
});

test("anonymous players can start, read the rules and answer without a login gate", async () => {
  let answers = 0;
  context.mocks.api(halloweenContract.answer, ({ body, respond }) => {
    answers++;
    return respond(200, {
      ...round(body.id),
      correct: 1,
      feedback: {
        selectedId: body.optionId,
        correct: true,
        explanation: "It’s oh cool.",
      },
    });
  });
  await setupPage({ context, path: "/halloween", auth: null });
  await click(control("button", "Activity rules"));
  await expect(screen.findByRole("dialog")).resolves.toBeInTheDocument();
  expect(
    screen.getByText(/existing Pro access is extended by seven days/),
  ).toBeInTheDocument();
  await click(control("button", "Back to game"));
  await click(control("button", "Let’s play"));
  const heading = await screen.findByRole("heading", { name: question.text });
  expect(heading).toHaveFocus();
  await click(control("button", /Oh cool/));
  await expect(screen.findByText("It’s oh cool.")).resolves.toBeInTheDocument();
  expect(control("button", /Oh cool/)).toBeDisabled();
  expect(control("button", "Next question")).toBeEnabled();
  expect(answers).toBe(1);
});

test("wrong answers show a locked state then the failure screen with optional tasks", async () => {
  context.mocks.api(halloweenContract.answer, ({ body, respond }) => {
    return respond(200, {
      ...round(body.id),
      outcome: "wrong",
      question: null,
      completedAt: "2026-10-30T12:01:00Z",
      feedback: {
        selectedId: body.optionId,
        correct: false,
        explanation: "Okou got you this time.",
      },
    });
  });
  await setupPage({ context, path: "/halloween", auth: null });
  await click(control("button", "Let’s play"));
  await click(
    await waitFor(() => {
      return control("button", /Goku/);
    }),
  );
  expect(control("button", /Goku/)).toBeDisabled();
  await waitForResult();
  expect(
    screen.getByText(/subject to review\. No credits included\./),
  ).toHaveTextContent(
    "7 days of Okou Pro, subject to review. No credits included.",
  );
  expect(control("link", /Create a Halloween image/)).toHaveAttribute(
    "href",
    expect.stringContaining("prompt=Create"),
  );
  expect(control("button", "Play again")).toBeEnabled();
});

test("closed events retain direct rules access but have no play button", async () => {
  context.mocks.api(halloweenContract.status, ({ respond }) => {
    return respond(200, { phase: "ended", changesInMs: null });
  });
  await setupPage({ context, path: "/halloween#rules", auth: null });
  await expect(
    screen.findByText("This Halloween quiz has ended."),
  ).resolves.toBeInTheDocument();
  expect(
    queryAllByRoleFast("button").find((element) => {
      return element.textContent?.trim() === "Let’s play";
    }),
  ).toBeUndefined();
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

test("a delayed leave response cannot erase a newly started round", async () => {
  const releaseLeave = createDeferredPromise<void>(context.signal);
  let phaseReads = 0;
  const startedIds: string[] = [];
  context.mocks.api(halloweenContract.status, ({ respond }) => {
    phaseReads++;
    return respond(200, { phase: "open", changesInMs: null });
  });
  context.mocks.api(halloweenContract.start, ({ body, respond }) => {
    startedIds.push(body.id);
    return respond(200, {
      ...round(body.id),
      question: { ...question, text: `Round ${startedIds.length}` },
    });
  });
  context.mocks.api(halloweenContract.leave, async ({ body, respond }) => {
    await releaseLeave.promise;
    return respond(200, {
      ...round(body.id),
      outcome: "left",
      question: null,
      completedAt: "2026-10-30T12:01:00Z",
    });
  });
  await setupPage({ context, path: "/halloween", auth: null });
  await click(control("button", "Let’s play"));
  await screen.findByRole("heading", { name: "Round 1" });
  await click(control("button", "Leave quiz"));
  await click(control("button", "Let’s play"));
  await screen.findByRole("heading", { name: "Round 2" });
  expect(startedIds).toHaveLength(2);
  expect(startedIds[0]).not.toBe(startedIds[1]);
  const readsBeforeCompletion = phaseReads;
  releaseLeave.resolve();
  await waitFor(() => {
    expect(phaseReads).toBeGreaterThan(readsBeforeCompletion);
  });
  expect(screen.getByRole("heading", { name: "Round 2" })).toBeInTheDocument();
});
