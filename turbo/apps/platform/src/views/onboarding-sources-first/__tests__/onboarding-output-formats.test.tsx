import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  testContext,
  type TestContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { localStorageSignals } from "../../../signals/external/local-storage.ts";
import { mockChatLifecycle } from "../../okou-page/__tests__/chat-test-helpers.ts";

const context = testContext();
const draftStorage = localStorageSignals("onboarding:sources-first-draft");
const TASK =
  "Review last week's ad results and suggest three things to test next.";
const PRESENTATION =
  "Present the findings as a concise presentation with key results, recommendations, and next steps.";
const DOCUMENT =
  "Create a complete document with the results in the requested file format (Markdown by default). Upload it as an artifact and include the working artifact link in your final response.";

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
    name: "Your first task",
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
    "Document",
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
  click(button("Start my first task"));
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

  click(button("Document"));
  await waitFor(() => {
    expect(input).toHaveValue(editedTask);
    expect(button("Document")).toHaveAttribute("aria-pressed", "true");
  });
  click(button("Clear selection"));
  await waitFor(() => {
    expect(input).toHaveValue(editedTask);
    expect(button("Document")).toHaveAttribute("aria-pressed", "false");
  });
  click(button("Start my first task"));
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
  click(button("Start my first task"));
  await waitFor(() => {
    expect(sentPrompt).toBe(`Draft a customer update.\n\n${PRESENTATION}`);
  });
});

test("a saved report draft preserves custom instructions and requests a document artifact", async () => {
  let sentPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      sentPrompt = body.prompt;
    },
  });
  const savedInstruction =
    "\n\nPresent the findings as a structured report. Include a risk register.";
  context.store.set(
    draftStorage.set$,
    JSON.stringify({
      version: 2,
      orgId: "org_default",
      userId: "test-user-123",
      industry: "marketing",
      experienced: false,
      provider: null,
      startingPromptDraft: TASK + savedInstruction,
      startingPromptKey: "marketing:none",
      startingPromptOutput: {
        format: "report",
        start: TASK.length,
        end: TASK.length + savedInstruction.length,
      },
      recommendationJobId: null,
      recommendationStartedAt: null,
    }),
  );
  const input = await openReady();
  expect(input).toHaveValue(TASK);
  expect(button("Document")).toHaveAttribute("aria-pressed", "true");
  click(button("Start my first task"));
  await waitFor(() => {
    expect(sentPrompt).toBe(`${TASK}${savedInstruction}\n\n${DOCUMENT}`);
  });
});
