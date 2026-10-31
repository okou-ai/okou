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
import { localStorageSignals } from "../../../signals/external/local-storage.ts";
import { resetSignal } from "../../../signals/utils.ts";
import { mockChatLifecycle } from "../../okou-page/__tests__/chat-test-helpers.ts";

const context = testContext();
const reloadedContext = createTestRuntime(context);
const draftStorage = localStorageSignals("onboarding:sources-first-draft");
const TASK =
  "Review last week's ad results and suggest three things to test next.";
const PRESENTATION = "Output format: Okou presentation. Share its link.";
const REPORT = "Output format: Report.";

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

test("format switches preserve the recommended task and apply on submission", async () => {
  let sentPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      sentPrompt = body.prompt;
    },
  });
  const input = await openReady();
  const original = input.value;
  for (const name of [
    "Image",
    "Website",
    "Report",
    "Research brief",
    "People shortlist",
    "Presentation",
  ]) {
    click(button(name));
    await waitFor(() => {
      expect(button(name)).toHaveAttribute("aria-pressed", "true");
    });
    expect(input).toHaveValue(original);
  }
  click(button("Presentation"));
  click(button("Start with Okou"));
  await waitFor(() => {
    expect(sentPrompt).toBe(`${original}\n\n${PRESENTATION}`);
  });
});

test("switching and clearing formats preserve task edits", async () => {
  let sentPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      sentPrompt = body.prompt;
    },
  });
  const input = await openReady();
  await fill(input, TASK);
  click(button("Presentation"));
  const edited = `Please ${TASK}\n\nUse plain English.`;
  await fill(input, edited);
  click(button("Report"));
  await waitFor(() => {
    expect(button("Report")).toHaveAttribute("aria-pressed", "true");
  });
  expect(input).toHaveValue(edited);
  click(button("Clear selection"));
  await waitFor(() => {
    expect(button("Report")).toHaveAttribute("aria-pressed", "false");
    expect(input).toHaveFocus();
  });
  expect(input).toHaveValue(edited);
  click(button("Start with Okou"));
  await waitFor(() => {
    expect(sentPrompt).toBe(edited);
  });
});

test("replacing the whole task preserves its separate format selection", async () => {
  let sentPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      sentPrompt = body.prompt;
    },
  });
  const input = await openReady();
  click(button("Presentation"));
  await fill(input, "Draft a customer update.");
  expect(button("Presentation")).toHaveAttribute("aria-pressed", "true");
  expect(input).toHaveValue("Draft a customer update.");
  click(button("Start with Okou"));
  await waitFor(() => {
    expect(sentPrompt).toBe(`Draft a customer update.\n\n${PRESENTATION}`);
  });
});

test("all formats remain available at the task length limit", async () => {
  let sentPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      sentPrompt = body.prompt;
    },
  });
  const input = await openReady();
  const longTask = "a".repeat(1000);
  await fill(input, "");
  await waitFor(() => {
    expect(input).toHaveValue("");
  });
  await fill(input, longTask);
  for (const name of [
    "Image",
    "Website",
    "Report",
    "Research brief",
    "People shortlist",
    "Presentation",
  ]) {
    expect(button(name)).toBeEnabled();
    click(button(name));
    await waitFor(() => {
      expect(button(name)).toHaveAttribute("aria-pressed", "true");
    });
    expect(input).toHaveValue(longTask);
  }
  click(button("Start with Okou"));
  await waitFor(() => {
    expect(sentPrompt).toBe(`${longTask}\n\n${PRESENTATION}`);
  });
});

test("a reload preserves the task and separate format selection", async () => {
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
    expect(button("Report")).toHaveAttribute("aria-pressed", "true");
  });
  expect(restored).toHaveValue(TASK);
  click(button("Start with Okou"));
  await waitFor(() => {
    expect(sentPrompt).toBe(`${TASK}\n\n${REPORT}`);
  });
});

test("an existing saved draft restores its task and format separately", async () => {
  const paragraph =
    "\n\nPresent the findings as an Okou presentation with key results, recommendations, and next steps, and share its link.";
  context.store.set(
    draftStorage.set$,
    JSON.stringify({
      version: 2,
      orgId: "org_default",
      userId: "test-user-123",
      industry: "marketing",
      experienced: false,
      provider: null,
      startingPromptDraft: `${TASK}${paragraph}\n\nUse plain English.`,
      startingPromptKey: "marketing:none",
      startingPromptOutput: {
        format: "presentation",
        start: TASK.length,
        end: TASK.length + paragraph.length,
      },
      recommendationJobId: null,
      recommendationStartedAt: null,
    }),
  );
  let sentPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      sentPrompt = body.prompt;
    },
  });
  const input = await openReady();
  expect(input).toHaveValue(`${TASK}\n\nUse plain English.`);
  expect(button("Presentation")).toHaveAttribute("aria-pressed", "true");
  click(button("Report"));
  await waitFor(() => {
    expect(button("Report")).toHaveAttribute("aria-pressed", "true");
  });
  click(button("Start with Okou"));
  await waitFor(() => {
    expect(sentPrompt).toBe(`${TASK}\n\nUse plain English.\n\n${REPORT}`);
  });
});
