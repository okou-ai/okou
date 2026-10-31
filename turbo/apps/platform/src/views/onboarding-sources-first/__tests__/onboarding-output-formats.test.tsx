import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  createTestRuntime,
  testContext,
  type TestContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { resetSignal } from "../../../signals/utils.ts";
import { mockChatLifecycle } from "../../okou-page/__tests__/chat-test-helpers.ts";

const context = testContext();
const reloadedContext = createTestRuntime(context);
const TASK =
  "Review last week's ad results and suggest three things to test next.";
const PRESENTATION =
  "Present the findings as an Okou presentation with key results, recommendations, and next steps, and share its link.";
const REPORT =
  "Present the findings as a structured report with key results, recommendations, and next steps.";
const PRIORITY =
  "Use this format for the final deliverable, replacing any earlier format request.";

async function openReady(
  pageContext: TestContext = context,
): Promise<HTMLTextAreaElement> {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  await setupPage({
    context: pageContext,
    path: ROUTES.onboardingReady,
    locale: "en-US",
  });
  const input = await screen.findByRole("textbox", {
    name: "Your starting prompt",
  });
  if (!(input instanceof HTMLTextAreaElement)) {
    throw new Error("Expected the starting prompt textarea");
  }
  return input;
}

function button(name: string): HTMLElement {
  const match = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!match) {
    throw new Error(`Expected button named "${name}"`);
  }
  return match;
}

test("formats augment the recommended task and the first chat receives the visible prompt", async () => {
  let sentPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      sentPrompt = body.prompt;
    },
  });
  const input = await openReady();
  const original = input.value;
  const choices = [
    ["Image", "Present the findings as a clear visual summary image."],
    [
      "Website",
      "Present the findings as a shareable webpage with clear sections and takeaways.",
    ],
    ["Report", REPORT],
    [
      "Research brief",
      "Present the findings as a research brief with supporting sources and open questions. Distinguish sourced facts from recommendations.",
    ],
    [
      "People shortlist",
      "Use this task as context to produce a shortlist of relevant people, with their roles, reasons for inclusion, and public professional profile links. If their relevance to the task is unclear, ask a focused question before searching.",
    ],
    ["Presentation", PRESENTATION],
  ] as const;
  for (const [name, instruction] of choices) {
    click(button(name));
    await waitFor(() => {
      expect(input).toHaveValue(`${original}\n\n${instruction} ${PRIORITY}`);
      expect(button(name)).toHaveAttribute("aria-pressed", "true");
      expect(input).toHaveFocus();
    });
  }
  // Selecting the same format again must not append a second instruction.
  click(button("Presentation"));
  expect(input).toHaveValue(`${original}\n\n${PRESENTATION} ${PRIORITY}`);
  click(button("Start with Okou"));
  await waitFor(() => {
    expect(sentPrompt).toBe(`${original}\n\n${PRESENTATION} ${PRIORITY}`);
  });
});

test("switching and clearing formats preserve edits around the output paragraph", async () => {
  const input = await openReady();
  await fill(input, TASK);
  click(button("Presentation"));
  await waitFor(() => {
    expect(input).toHaveValue(`${TASK}\n\n${PRESENTATION} ${PRIORITY}`);
  });
  const user = userEvent.setup({ delay: null });
  await user.click(input);
  await user.keyboard("{Control>}{Home}{/Control}Please ");
  const wordStart = input.value.indexOf("key results");
  expect(wordStart).toBeGreaterThanOrEqual(0);
  input.setSelectionRange(wordStart, wordStart + "key results".length);
  await user.keyboard("detailed results");
  await user.keyboard(
    "{Control>}{End}{/Control}{Enter}{Enter}Use plain English.",
  );

  click(button("Report"));
  await waitFor(() => {
    expect(input).toHaveValue(
      `Please ${TASK}\n\n${REPORT} ${PRIORITY}\n\nUse plain English.`,
    );
  });
  click(button("Clear selection"));
  await waitFor(() => {
    expect(input).toHaveValue(`Please ${TASK}\n\nUse plain English.`);
    expect(button("Report")).toHaveAttribute("aria-pressed", "false");
    expect(input).toHaveFocus();
  });
});

test("replacing the whole prompt starts a new task without stale output ownership", async () => {
  const input = await openReady();
  click(button("Presentation"));
  await waitFor(() => {
    expect(button("Presentation")).toHaveAttribute("aria-pressed", "true");
  });
  await fill(input, "Draft a customer update.");
  await waitFor(() => {
    expect(button("Presentation")).toHaveAttribute("aria-pressed", "false");
  });
  click(button("Report"));
  await waitFor(() => {
    expect(input).toHaveValue(
      `Draft a customer update.\n\n${REPORT} ${PRIORITY}`,
    );
  });
});

test("format choices respect the prompt length limit without truncating the task", async () => {
  const input = await openReady();
  const longTask = "a".repeat(1000);
  await fill(input, "");
  await waitFor(() => {
    expect(input).toHaveValue("");
  });
  await fill(input, longTask);
  expect(input).toHaveValue(longTask);
  await waitFor(() => {
    expect(button("Presentation")).toBeDisabled();
  });
  expect(screen.getByRole("status")).toHaveTextContent(
    "Shorten your task to choose another format.",
  );
  expect(input).toHaveValue(longTask);
  expect(button("Start with Okou")).toBeEnabled();
  await fill(input, "");
  await waitFor(() => {
    expect(input).toHaveValue("");
  });
  await fill(input, TASK);
  await waitFor(() => {
    expect(button("Presentation")).toBeEnabled();
  });
});

test("a reload preserves the complete editable prompt and its format selection", async () => {
  const resetFirstPage = resetSignal();
  const pageSignal = context.store.set(resetFirstPage, context.signal);
  const input = await openReady({ ...context, signal: pageSignal });
  await fill(input, TASK);
  click(button("Presentation"));
  await waitFor(() => {
    expect(input).toHaveValue(`${TASK}\n\n${PRESENTATION} ${PRIORITY}`);
  });
  context.store.set(resetFirstPage);
  cleanup();
  vi.mocked(window.history.pushState).mockRestore();
  vi.mocked(window.history.replaceState).mockRestore();
  vi.mocked(window.history.back).mockRestore();

  const restored = await openReady(reloadedContext);
  expect(restored).toHaveValue(`${TASK}\n\n${PRESENTATION} ${PRIORITY}`);
  expect(button("Presentation")).toHaveAttribute("aria-pressed", "true");
  click(button("Report"));
  await waitFor(() => {
    expect(restored).toHaveValue(`${TASK}\n\n${REPORT} ${PRIORITY}`);
  });
});
