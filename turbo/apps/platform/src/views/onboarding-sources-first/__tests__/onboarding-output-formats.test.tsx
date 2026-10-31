import { cleanup, screen, waitFor } from "@testing-library/react";
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
  "Present the findings as a concise presentation with key results, recommendations, and next steps.";
const REPORT =
  "Present the findings as a structured report with key results, recommendations, and next steps.";

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

test("format choices leave the task unchanged and only the final choice reaches the first chat", async () => {
  let sentPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      sentPrompt = body.prompt;
    },
  });
  const input = await openReady();
  const original = input.value;
  const choices = [
    "Image",
    "Website",
    "Report",
    "Research brief",
    "People shortlist",
    "Presentation",
  ] as const;
  for (const name of choices) {
    click(button(name));
    await waitFor(() => {
      expect(input).toHaveValue(original);
      expect(button(name)).toHaveAttribute("aria-pressed", "true");
    });
  }
  // Selecting the same format again must not append a second instruction.
  click(button("Presentation"));
  expect(input).toHaveValue(original);
  click(button("Start with Okou"));
  await waitFor(() => {
    expect(sentPrompt).toBe(`${original}\n\n${PRESENTATION}`);
  });
});

test("switching and clearing formats preserve task edits and clearing submits only the task", async () => {
  let sentPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      sentPrompt = body.prompt;
    },
  });
  const input = await openReady();
  await fill(input, TASK);
  click(button("Presentation"));
  await waitFor(() => {
    expect(button("Presentation")).toHaveAttribute("aria-pressed", "true");
    expect(input).toHaveValue(TASK);
  });
  const editedTask = `${TASK}\n\nFocus on the spring campaign.`;
  await fill(input, editedTask);

  click(button("Report"));
  await waitFor(() => {
    expect(input).toHaveValue(editedTask);
    expect(button("Report")).toHaveAttribute("aria-pressed", "true");
  });
  click(button("Clear selection"));
  await waitFor(() => {
    expect(input).toHaveValue(editedTask);
    expect(button("Report")).toHaveAttribute("aria-pressed", "false");
  });
  click(button("Start with Okou"));
  await waitFor(() => {
    expect(sentPrompt).toBe(editedTask);
  });
});

test("replacing the task preserves the selected format until submission", async () => {
  let sentPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      sentPrompt = body.prompt;
    },
  });
  const input = await openReady();
  click(button("Presentation"));
  await waitFor(() => {
    expect(button("Presentation")).toHaveAttribute("aria-pressed", "true");
  });
  await fill(input, "Draft a customer update.");
  await waitFor(() => {
    expect(button("Presentation")).toHaveAttribute("aria-pressed", "true");
    expect(input).toHaveValue("Draft a customer update.");
  });
  click(button("Start with Okou"));
  await waitFor(() => {
    expect(sentPrompt).toBe(`Draft a customer update.\n\n${PRESENTATION}`);
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

test("the selected format reserves space within the saved prompt limit", async () => {
  let sentPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      sentPrompt = body.prompt;
    },
  });
  const input = await openReady();
  click(button("Report"));
  const taskLimit = 1000 - 2 - REPORT.length;
  await waitFor(() => {
    expect(input).toHaveAttribute("maxlength", String(taskLimit));
  });
  const longTask = "a".repeat(taskLimit);
  await fill(input, "");
  await waitFor(() => {
    expect(input).toHaveValue("");
  });
  await fill(input, longTask);
  expect(input).toHaveValue(longTask);
  click(button("Start with Okou"));
  await waitFor(() => {
    expect(sentPrompt).toBe(`${longTask}\n\n${REPORT}`);
    expect(sentPrompt).toHaveLength(1000);
  });
});

test("a reload preserves the task and separate format selection without duplicating instructions", async () => {
  let sentPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      sentPrompt = body.prompt;
    },
  });
  const resetFirstPage = resetSignal();
  const pageSignal = context.store.set(resetFirstPage, context.signal);
  const input = await openReady({ ...context, signal: pageSignal });
  await fill(input, TASK);
  click(button("Presentation"));
  await waitFor(() => {
    expect(input).toHaveValue(TASK);
    expect(button("Presentation")).toHaveAttribute("aria-pressed", "true");
  });
  context.store.set(resetFirstPage);
  cleanup();
  vi.mocked(window.history.pushState).mockRestore();
  vi.mocked(window.history.replaceState).mockRestore();
  vi.mocked(window.history.back).mockRestore();

  const restored = await openReady(reloadedContext);
  expect(restored).toHaveValue(TASK);
  expect(button("Presentation")).toHaveAttribute("aria-pressed", "true");
  click(button("Report"));
  await waitFor(() => {
    expect(restored).toHaveValue(TASK);
    expect(button("Report")).toHaveAttribute("aria-pressed", "true");
  });
  click(button("Start with Okou"));
  await waitFor(() => {
    expect(sentPrompt).toBe(`${TASK}\n\n${REPORT}`);
  });
});
