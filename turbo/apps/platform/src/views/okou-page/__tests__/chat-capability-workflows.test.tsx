import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import {
  workflowAutomationsContract,
  type ChatThreadWorkflowAutomation,
  type WorkflowAutomationSummary,
  type WorkflowAutomationUpdateRequest,
} from "@okouai/api-contracts/contracts/workflows";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { completedEvent, assistantEvent } from "./chat-run-test-fixtures.ts";
import {
  completedConversation,
  context,
  FIRST_CAPABILITY_RUN_ID,
  installCapabilityChat,
  readyChat,
  RUN_PATH,
  RUN_THREAD_ID,
  SECOND_CAPABILITY_RUN_ID,
} from "./chat-capability-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";

const WORKFLOW_ID = "e0000000-0000-4000-a000-000000000861";
const AUTOMATION_ID = "e0000000-0000-4000-a000-000000000862";
const WORKFLOW_AGENT_ID = "e0000000-0000-4000-a000-000000000863";
const OWNER_USER_ID = "test-user-123";
const CREATE_WORKFLOW_PROMPT =
  "Help me create a workflow for this agent. Use the workflow-setup skill, then ask me for the desired outcome, automation, and action before creating the workflow and automation.";

type ScheduleAutomation = Extract<
  ChatThreadWorkflowAutomation,
  { readonly kind: "schedule" }
>;
type GmailMatchAutomation = Extract<
  ChatThreadWorkflowAutomation,
  { readonly eventType: "gmail-new-message" }
>;
type GmailLabelAutomation = Extract<
  ChatThreadWorkflowAutomation,
  { readonly eventType: "gmail-label-applied" }
>;

const WORKFLOW = {
  id: WORKFLOW_ID,
  agentId: WORKFLOW_AGENT_ID,
  name: "release-review",
  displayName: "Release review",
  description: "Review release readiness",
} satisfies ChatThreadWorkflowAutomation["workflow"];

function automationBase() {
  return {
    id: AUTOMATION_ID,
    ownerUserId: OWNER_USER_ID,
    enabled: true,
    chatThreadId: RUN_THREAD_ID,
    nextRunAt: null,
    lastRunAt: "2026-08-01T09:00:00.000Z",
    official: null,
    workflow: WORKFLOW,
  } as const;
}

function scheduleAutomation(intervalSeconds: number): ScheduleAutomation {
  return {
    ...automationBase(),
    kind: "schedule",
    schedule: { type: "loop", intervalSeconds },
    scheduleSummary: `Every ${intervalSeconds / 60} minutes`,
    nextRunAt: "2026-08-01T10:15:00.000Z",
  };
}

function gmailMatchAutomation(
  eventConfig: GmailMatchAutomation["eventConfig"],
): GmailMatchAutomation {
  return {
    ...automationBase(),
    kind: "event",
    eventType: "gmail-new-message",
    eventConfig,
    schedule: null,
    scheduleSummary: null,
  };
}

function gmailLabelAutomation(labelName: string): GmailLabelAutomation {
  return {
    ...automationBase(),
    kind: "event",
    eventType: "gmail-label-applied",
    eventConfig: {
      provider: "gmail",
      event: "label_applied",
      labelName,
    },
    schedule: null,
    scheduleSummary: null,
  };
}

function scheduleSummary(
  automation: ScheduleAutomation,
): WorkflowAutomationSummary {
  return {
    id: automation.id,
    ownerUserId: automation.ownerUserId,
    enabled: automation.enabled,
    chatThreadId: automation.chatThreadId,
    nextRunAt: automation.nextRunAt,
    lastRunAt: automation.lastRunAt,
    official: automation.official,
    kind: automation.kind,
    schedule: automation.schedule,
    scheduleSummary: automation.scheduleSummary,
  };
}

function gmailMatchSummary(
  automation: GmailMatchAutomation,
): WorkflowAutomationSummary {
  return {
    id: automation.id,
    ownerUserId: automation.ownerUserId,
    enabled: automation.enabled,
    chatThreadId: automation.chatThreadId,
    nextRunAt: automation.nextRunAt,
    lastRunAt: automation.lastRunAt,
    official: automation.official,
    kind: automation.kind,
    eventType: automation.eventType,
    eventConfig: automation.eventConfig,
    schedule: null,
    scheduleSummary: null,
  };
}

function gmailLabelSummary(
  automation: GmailLabelAutomation,
): WorkflowAutomationSummary {
  return {
    id: automation.id,
    ownerUserId: automation.ownerUserId,
    enabled: automation.enabled,
    chatThreadId: automation.chatThreadId,
    nextRunAt: automation.nextRunAt,
    lastRunAt: automation.lastRunAt,
    official: automation.official,
    kind: automation.kind,
    eventType: automation.eventType,
    eventConfig: automation.eventConfig,
    schedule: null,
    scheduleSummary: null,
  };
}

function installAutomationConversation(): void {
  installCapabilityChat({
    events: completedConversation(
      "The workflow automation is ready to review.",
    ),
  });
}

function installAutomationList(
  current: () => ChatThreadWorkflowAutomation,
): void {
  context.mocks.api(
    workflowAutomationsContract.listForChatThread,
    ({ respond }) => {
      return respond(200, [current()]);
    },
  );
}

function normalizedText(element: HTMLElement): string {
  return element.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}

function queryButton(
  name: string,
  container: ParentNode = document.body,
): HTMLElement | null {
  return (
    queryAllByRoleFast("button", container).find((element) => {
      return (
        element.getAttribute("aria-label") === name ||
        normalizedText(element) === name
      );
    }) ?? null
  );
}

function findButton(
  name: string,
  container: ParentNode = document.body,
): Promise<HTMLElement> {
  return waitFor(() => {
    const button = queryButton(name, container);
    if (!button) {
      throw new Error(`${name} button was not visible`);
    }
    return button;
  });
}

async function openAutomationEditor(): Promise<HTMLElement> {
  await readyChat();
  click(await findButton("Automations"));
  const sidebar = await screen.findByRole("complementary", {
    name: "Automations",
  });
  click(await findButton("Edit", sidebar));
  return await screen.findByRole("dialog", { name: "Edit automation" });
}

function currentComposer(): HTMLElement {
  return screen.getByRole("textbox", { name: "Message" });
}

function composerText(): string {
  return normalizedText(currentComposer());
}

test("Edit schedule and Gmail workflow triggers", async () => {
  const updates: WorkflowAutomationUpdateRequest[] = [];
  let current = scheduleAutomation(300);
  installAutomationConversation();
  installAutomationList(() => {
    return current;
  });
  context.mocks.api(workflowAutomationsContract.update, ({ body, respond }) => {
    updates.push(body);
    if (!("schedule" in body) || body.schedule.type !== "loop") {
      throw new Error("Expected a schedule update");
    }
    current = scheduleAutomation(body.schedule.intervalSeconds);
    return respond(200, scheduleSummary(current));
  });

  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });

  const dialog = await openAutomationEditor();
  click(within(dialog).getByRole("combobox", { name: "Every" }));
  click(await screen.findByRole("option", { name: "15 minutes" }));
  click(await findButton("Save automation", dialog));

  await waitFor(() => {
    expect(updates).toStrictEqual([
      { schedule: { type: "loop", intervalSeconds: 900 } },
    ]);
    expect(screen.getByText("Every 15 minutes")).toBeVisible();
  });
});

test("Edit Gmail match workflow trigger filters", async () => {
  const updates: WorkflowAutomationUpdateRequest[] = [];
  let current = gmailMatchAutomation({
    provider: "gmail",
    event: "new_message",
    threadId: "gmail-thread-42",
    match: { from: { contains: "alerts@example.com" } },
  });
  installAutomationConversation();
  installAutomationList(() => {
    return current;
  });
  context.mocks.api(workflowAutomationsContract.update, ({ body, respond }) => {
    updates.push(body);
    if (!("eventConfig" in body) || body.eventConfig.event !== "new_message") {
      throw new Error("Expected a Gmail message update");
    }
    current = gmailMatchAutomation(body.eventConfig);
    return respond(200, gmailMatchSummary(current));
  });

  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });

  const dialog = await openAutomationEditor();
  const fixedField = within(dialog).getByLabelText("Thread ID field");
  const fixedOperator = within(dialog).getByLabelText("Thread ID operator");
  expect(fixedField).toBeDisabled();
  expect(fixedField).toHaveValue("Thread ID");
  expect(fixedOperator).toBeDisabled();
  expect(fixedOperator).toHaveValue("Is");
  await fill(
    within(dialog).getByLabelText("From contains"),
    "billing@example.com",
  );
  await fill(
    within(dialog).getByLabelText("Subject contains any"),
    "invoice, receipt",
  );
  click(await findButton("Save automation", dialog));

  const expectedConfig = {
    provider: "gmail" as const,
    event: "new_message" as const,
    threadId: "gmail-thread-42",
    match: {
      from: { contains: "billing@example.com" },
      subject: { containsAny: ["invoice", "receipt"] },
    },
  };
  await waitFor(() => {
    expect(updates).toStrictEqual([{ eventConfig: expectedConfig }]);
    expect(
      screen.getByText(
        'Thread ID is "gmail-thread-42"; From contains "billing@example.com"; Subject contains any of "invoice", "receipt"',
      ),
    ).toBeVisible();
  });
  const sidebar = screen.getByRole("complementary", { name: "Automations" });
  expect(within(sidebar).queryByText("Next run")).not.toBeInTheDocument();
});

test("Edit a Gmail label workflow trigger", async () => {
  const updates: WorkflowAutomationUpdateRequest[] = [];
  let current = gmailLabelAutomation("Inbox");
  installAutomationConversation();
  installAutomationList(() => {
    return current;
  });
  context.mocks.api(workflowAutomationsContract.update, ({ body, respond }) => {
    updates.push(body);
    if (
      !("eventConfig" in body) ||
      body.eventConfig.event !== "label_applied"
    ) {
      throw new Error("Expected a Gmail label update");
    }
    current = gmailLabelAutomation(body.eventConfig.labelName);
    return respond(200, gmailLabelSummary(current));
  });

  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });

  const dialog = await openAutomationEditor();
  await fill(
    within(dialog).getByRole("textbox", { name: "Label name" }),
    "Customer Escalations",
  );
  click(await findButton("Save automation", dialog));

  await waitFor(() => {
    expect(updates).toStrictEqual([
      {
        eventConfig: {
          provider: "gmail",
          event: "label_applied",
          labelName: "Customer Escalations",
        },
      },
    ]);
    expect(screen.getByText('Label "Customer Escalations"')).toBeVisible();
  });
});

function automationInput(args: {
  readonly id: string;
  readonly seqId: number;
  readonly workflowName: string;
  readonly workflowId?: string;
  readonly automationBrief: string;
  readonly prompt?: string;
  readonly runId?: string;
}): MockChatEventInput {
  const parts: UserMessageDocument["parts"] = [
    {
      type: "automation",
      workflowName: args.workflowName,
      ...(args.workflowId ? { workflowId: args.workflowId } : {}),
      automationBrief: args.automationBrief,
    },
    ...(args.prompt ? [{ type: "text" as const, text: args.prompt }] : []),
  ];
  return {
    id: args.id,
    eventType: "input.automation",
    content: null,
    createdAt: `2026-08-01T10:00:${String(args.seqId).padStart(2, "0")}.000Z`,
    seqId: args.seqId,
    runId: args.runId,
    userMessage: { version: 1, parts },
  };
}

test("Present workflow trigger events as meaningful chat history", async () => {
  const actualTriggerPrompt =
    "Review pull request 481 before the production deployment.";
  const unusedBrief = "A different release summary";
  const legacyBrief = "Summarize pipeline failures every Monday.";
  const pendingBrief = "Route new support email to the response queue.";
  const events: MockChatEventInput[] = [
    automationInput({
      id: "workflow-trigger-full",
      seqId: 1,
      runId: FIRST_CAPABILITY_RUN_ID,
      workflowName: "Daily release review",
      workflowId: WORKFLOW_ID,
      automationBrief: unusedBrief,
      prompt: actualTriggerPrompt,
    }),
    assistantEvent({
      id: "workflow-trigger-full-output",
      runId: FIRST_CAPABILITY_RUN_ID,
      seqId: 2,
      text: "The release review is complete.",
    }),
    completedEvent({
      id: "workflow-trigger-full-completed",
      runId: FIRST_CAPABILITY_RUN_ID,
      seqId: 3,
    }),
    automationInput({
      id: "workflow-trigger-legacy",
      seqId: 4,
      runId: SECOND_CAPABILITY_RUN_ID,
      workflowName: "Weekly pipeline summary",
      automationBrief: legacyBrief,
    }),
    assistantEvent({
      id: "workflow-trigger-legacy-output",
      runId: SECOND_CAPABILITY_RUN_ID,
      seqId: 5,
      text: "The pipeline summary is complete.",
    }),
    completedEvent({
      id: "workflow-trigger-legacy-completed",
      runId: SECOND_CAPABILITY_RUN_ID,
      seqId: 6,
    }),
    automationInput({
      id: "workflow-trigger-pending",
      seqId: 7,
      workflowName: "Support email routing",
      automationBrief: pendingBrief,
    }),
  ];
  installCapabilityChat({ events });

  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });

  const chat = await readyChat();
  const workflowLink = within(chat).getByLabelText(
    "Open workflow Daily release review",
  );
  expect(workflowLink).toHaveTextContent("Daily release review");
  expect(workflowLink).toHaveAttribute(
    "href",
    `/workflows/${WORKFLOW_ID}/automations`,
  );
  const triggerPrompt = within(chat).getByText(actualTriggerPrompt);
  expect(triggerPrompt).toBeInTheDocument();
  click(triggerPrompt);
  expect(window.location.pathname).toBe(RUN_PATH);
  expect(within(chat).queryByText(unusedBrief)).not.toBeInTheDocument();
  expect(
    within(chat).getByLabelText("Workflow Weekly pipeline summary"),
  ).toBeVisible();
  expect(within(chat).getByText(legacyBrief)).toBeVisible();

  const pending = await screen.findByRole("listitem", {
    name: "Pending automation event",
  });
  expect(pending).toHaveTextContent(pendingBrief);
  expect(
    screen.queryByRole("listitem", { name: "Queued message" }),
  ).not.toBeInTheDocument();
});

test("Start creating a workflow from the chat composer", async () => {
  const originalDraft = "Keep this unsent customer follow-up.";
  installCapabilityChat({
    events: completedConversation("The composer is ready."),
  });

  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });

  await readyChat();
  click(await findButton("Create workflow"));
  await waitFor(() => {
    expect(composerText()).toBe(CREATE_WORKFLOW_PROMPT);
  });

  await fill(currentComposer(), originalDraft);
  click(await findButton("Create workflow"));
  let dialog = await screen.findByRole("dialog", {
    name: "Replace composer draft?",
  });
  expect(dialog).toHaveTextContent(
    "Continuing will clear your current composer draft and start a workflow prompt.",
  );
  click(await findButton("Cancel", dialog));

  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Replace composer draft?" }),
    ).not.toBeInTheDocument();
    expect(composerText()).toBe(originalDraft);
  });

  click(await findButton("Create workflow"));
  dialog = await screen.findByRole("dialog", {
    name: "Replace composer draft?",
  });
  click(await findButton("Continue", dialog));

  await waitFor(() => {
    expect(composerText()).toBe(CREATE_WORKFLOW_PROMPT);
  });
});
