import { expect, test } from "vitest";
import { screen } from "@testing-library/react";
import { onboardingDraftContract } from "@okouai/api-contracts/contracts/onboarding";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findAction } from "../../okou-page/__tests__/connector-integrations-test-helpers.ts";
import {
  documentInstructions,
  receiveFirstChat,
  findSentPrompt,
} from "./onboarding-first-chat-test-helpers.ts";
const context = testContext();
const presentation =
  "Present the findings as a concise presentation with key results, recommendations, and next steps.";
async function ready() {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  await setupPage({ context, path: "/onboarding/ready" });
  return screen.findByRole<HTMLTextAreaElement>("textbox", {
    name: "Your first task",
  });
}
test("onboarding-output-formats-001 comparing six deliverables leaves the suggested task intact and applies Presentation once", async () => {
  const receipt = receiveFirstChat(context);
  const field = await ready();
  const suggested = field.value;
  expect(suggested.trim()).not.toBe("");
  for (const name of [
    "Image",
    "Website",
    "Document",
    "Research brief",
    "People shortlist",
    "Presentation",
    "Presentation",
  ]) {
    const choice = await findAction("button", name);
    click(choice);
    expect(choice).toHaveAttribute("aria-pressed", "true");
    expect(field).toHaveValue(suggested);
  }
  click(await findAction("button", "Start my first task"));
  const message = await receipt;
  await expect(findSentPrompt(message.prompt)).resolves.toBeInTheDocument();
  expect(window.location.pathname).toBe("/chats/" + message.threadId);
  expect(message.prompt).toBe(suggested + "\n\n" + presentation);
});
test("onboarding-output-formats-002 clearing the document choice sends the edited campaign request by itself", async () => {
  const receipt = receiveFirstChat(context);
  const field = await ready();
  const original = "Draft the channel report.";
  await fill(field, original);
  click(await findAction("button", "Presentation"));
  const edit = original + " Focus on the spring campaign.";
  await fill(field, edit);
  const document = await findAction("button", "Document");
  click(document);
  expect(document).toHaveAttribute("aria-pressed", "true");
  expect(field).toHaveValue(edit);
  click(await findAction("button", "Clear selection"));
  expect(field).toHaveValue(edit);
  expect(document).toHaveAttribute("aria-pressed", "false");
  click(await findAction("button", "Start my first task"));
  const message = await receipt;
  await expect(findSentPrompt(message.prompt)).resolves.toBeInTheDocument();
  expect(message.prompt).toBe(edit);
  expect(window.location.pathname).toBe("/chats/" + message.threadId);
});
test("onboarding-output-formats-003 replacing the task keeps its presentation selection through the chat handoff", async () => {
  const receipt = receiveFirstChat(context);
  const field = await ready();
  const choice = await findAction("button", "Presentation");
  click(choice);
  await fill(field, "Draft a customer update.");
  expect(choice).toHaveAttribute("aria-pressed", "true");
  click(await findAction("button", "Start my first task"));
  const message = await receipt;
  await expect(findSentPrompt(message.prompt)).resolves.toBeInTheDocument();
  expect(window.location.pathname).toBe("/chats/" + message.threadId);
  expect(message.prompt).toBe("Draft a customer update.\n\n" + presentation);
});
test("onboarding-output-formats-007 reopening an earlier report preserves its custom directions in the first chat", async () => {
  const receipt = receiveFirstChat(context);
  const task = "Summarize vendor renewals.";
  const custom =
    "\n\nPresent the findings as a structured report and include a risk register.";
  context.mocks.api(onboardingDraftContract.get, ({ respond }) => {
    return respond(200, {
      draft: {
        step: "ready",
        revision: crypto.randomUUID(),
        answers: {
          industry: null,
          experienced: null,
          provider: null,
          startingPromptDraft: task + custom,
          startingPromptKey: "renewals",
          startingPromptOutput: {
            format: "report",
            start: task.length,
            end: task.length + custom.length,
          },
          recommendationJobId: null,
          recommendationStartedAt: null,
        },
      },
    });
  });
  const field = await ready();
  expect(field).toHaveValue(task);
  await expect(findAction("button", "Document")).resolves.toHaveAttribute(
    "aria-pressed",
    "true",
  );
  click(await findAction("button", "Start my first task"));
  const message = await receipt;
  await expect(findSentPrompt(message.prompt)).resolves.toBeInTheDocument();
  expect(window.location.pathname).toBe("/chats/" + message.threadId);
  expect(message.prompt).toBe(task + custom + "\n\n" + documentInstructions);
});
