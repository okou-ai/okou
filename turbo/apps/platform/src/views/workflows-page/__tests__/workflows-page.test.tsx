import { integrationsGithubContract } from "@okouai/api-contracts/contracts/integrations-github";
import { createDefaultMockGithubIntegration } from "../../../mocks/handlers/api-integrations-github.ts";
import {
  slashChoice,
  slashRows,
} from "../../okou-page/__tests__/workflow-composer-boundary.ts";
import {
  workflowsCollectionContract,
  workflowsDetailContract,
  workflowAutomationsContract,
  type WorkflowAutomationSummary,
} from "@okouai/api-contracts/contracts/workflows";
import { screen, waitFor, within, fireEvent } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { setupPage, click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findAction } from "../../okou-page/__tests__/connector-integrations-test-helpers.ts";
import {
  createChatRunFixtures,
  RUN_THREAD_ID,
} from "../../okou-page/__tests__/chat-run-test-fixtures.ts";
import { salesWorkflow, serveWorkflows } from "./workflow-boundary.ts";

const context = testContext();

function directory() {
  const sales = salesWorkflow(context),
    ops = salesWorkflow(context, {
      id: crypto.randomUUID(),
      agentId: sales.agentId,
      name: "ops-playbook",
      displayName: "Ops Playbook",
    });
  const entries = [sales, ops];
  serveWorkflows(context, () => {
    return entries;
  });
  return { sales, entries, base: "/workflows/" + sales.id };
}

function weekday(): WorkflowAutomationSummary {
  return {
    id: crypto.randomUUID(),
    ownerUserId: "test-user-123",
    enabled: true,
    kind: "schedule",
    chatThreadId: null,
    lastRunAt: null,
    nextRunAt: null,
    official: null,
    schedule: { type: "cron", cronExpression: "0 9 * * 1-5", timezone: "UTC" },
    scheduleSummary: "Weekday schedule",
  };
}

test("workflows-page-004 a forbidden legacy detail returns to the accessible directory", async () => {
  const { base, entries } = directory();
  entries.shift();
  context.mocks.api(workflowsDetailContract.get, ({ respond }) => {
    return respond(403, { error: { code: "FORBIDDEN", message: "Private" } });
  });
  await setupPage({ context, path: base });
  await screen.findByText("Workflow not found.");
  await expect(screen.findByText("Ops Playbook")).resolves.toBeVisible();
  expect(location.pathname).toBe("/workflows");
});

test("workflows-page-013 a manager without publication permission sees the private workspace policy", async () => {
  const { sales, base } = directory();
  sales.canPublish = false;
  await setupPage({ context, path: base + "/info" });
  const toggle = await screen.findByRole("switch", {
    name: "Make workflow public",
  });
  expect(toggle).toHaveAttribute("aria-disabled", "true");
  click(toggle);
  expect(toggle).not.toBeChecked();
  expect(screen.getByText("Private", { exact: true })).toBeVisible();
  expect(
    screen.getByText(
      "You don’t have permission to publish workflows in this workspace.",
    ),
  ).toBeVisible();
});

test("workflows-page-014 refining Sales Research opens its own My Okou chat with the prepared prompt", async () => {
  createChatRunFixtures(context).installRunChat();
  const { base, sales } = directory();
  const prompt = "help me refine the workflow /sales-research";
  context.mocks.api(
    workflowsDetailContract.chatThread,
    ({ params, respond }) => {
      expect(params.workflowId).toBe(sales.id);
      return respond(200, { chatThreadId: RUN_THREAD_ID, prompt });
    },
  );
  await setupPage({ context, path: base + "/instructions" });
  click(await findAction("button", "Refine with Okou"));
  await waitFor(() => {
    return expect(screen.getByLabelText("Message")).toHaveTextContent(prompt);
  });
  expect(location.pathname).toBe("/chats/" + RUN_THREAD_ID);
});

test("workflows-page-020 failed deletion leaves the confirmation available for a successful retry", async () => {
  const { sales, entries, base } = directory();
  let inUse = true;
  context.mocks.api(workflowsDetailContract.delete, ({ params, respond }) => {
    if (inUse) {
      return respond(409, {
        error: { code: "CONFLICT", message: "Sales Research is still in use" },
      });
    }
    entries.splice(
      entries.findIndex((w) => {
        return w.id === params.workflowId;
      }),
      1,
    );
    return respond(204);
  });
  await setupPage({ context, path: base + "/info" });
  click(await findAction("button", "Delete workflow"));
  const dialog = await screen.findByRole("dialog");
  click(await findAction("button", "Delete", dialog));
  await screen.findByText("Sales Research is still in use");
  expect(dialog).toBeVisible();
  expect(location.pathname).toBe(base + "/info");
  inUse = false;
  click(await findAction("button", "Delete", dialog));
  await screen.findByText("Ops Playbook");
  expect(location.pathname).toBe("/workflows");
  expect(screen.queryByText(sales.displayName!)).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("workflows-page-021 the settings form sends the revised title, slug and description together", async () => {
  const { sales, base } = directory();
  const next = {
    displayName: "Account Brief",
    name: "account-brief",
    description: "Prepare account context",
  };
  context.mocks.api(workflowsDetailContract.update, ({ body, respond }) => {
    expect(body).toMatchObject(next);
    Object.assign(sales, body);
    return respond(200, sales);
  });
  await setupPage({ context, path: base + "/info" });
  const name = await screen.findByLabelText("Name"),
    slug = screen.getByLabelText("Slug"),
    desc = screen.getByLabelText("Description");
  expect(name).toHaveValue("Sales Research");
  expect(slug).toHaveValue("sales-research");
  expect(desc).toHaveValue("Collect leads");
  expect(screen.getByText(/Lowercase letters, numbers/)).toBeVisible();
  expect(
    screen.getByText("Tell Okou when to use this workflow."),
  ).toBeVisible();
  for (const [el, value] of [
    [name, next.displayName],
    [slug, next.name],
    [desc, next.description],
  ] as const) {
    fireEvent.change(el, { target: { value } });
  }
  await screen.findByText("You have unsaved changes");
  click(await findAction("button", "Save"));
  await screen.findByText("Workflow saved");
  expect(screen.getByLabelText("Slug")).toHaveValue(next.name);
});

test("workflows-page-022 settings and instructions tabs navigate within the same workflow", async () => {
  const { base } = directory();
  await setupPage({ context, path: base + "/automations" });
  click(await findAction("tab", "Settings"));
  await screen.findByLabelText("Name");
  expect(location.pathname).toBe(base + "/info");
  click(await findAction("tab", "Instructions"));
  await screen.findByText("Review the pipeline");
  expect(location.pathname).toBe(base + "/instructions");
});

test("workflows-page-024 an automatic-only rejection leaves the schedule runnable on its detail page", async () => {
  const { base, sales } = directory();
  const schedule = weekday();
  sales.automations = [schedule];
  const message = "Official Workflows can only run through automatic triggers";
  context.mocks.api(workflowAutomationsContract.run, ({ params, respond }) => {
    expect(params.id).toBe(schedule.id);
    return respond(409, { error: { code: "CONFLICT", message } });
  });
  await setupPage({ context, path: base + "/automations" });
  click(await findAction("button", "Run now"));
  await screen.findByText(message);
  await expect(findAction("button", "Run now")).resolves.toBeEnabled();
  expect(location.pathname).toBe(base + "/automations");
});

test("workflows-page-012 a deep link centers the Gmail automation and only its switch changes", async () => {
  const { base, sales } = directory();
  const schedule = weekday();
  const mail: WorkflowAutomationSummary = {
    ...schedule,
    kind: "event",
    id: crypto.randomUUID(),
    eventType: "gmail-new-message",
    eventConfig: { provider: "gmail", event: "new_message" },
    schedule: null,
    scheduleSummary: null,
  };
  sales.automations = [schedule, mail];
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
  context.mocks.api(
    workflowAutomationsContract.disable,
    ({ params, respond }) => {
      expect(params.id).toBe(mail.id);
      mail.enabled = false;
      return respond(200, mail);
    },
  );
  await setupPage({
    context,
    path: base + "/automations?automationId=" + mail.id,
  });
  const selected = await screen.findByRole("group", {
    name: "Gmail new message",
  });
  expect(selected).toHaveAttribute("aria-current", "true");
  expect(selected).toHaveFocus();
  expect(
    scroll.mock.calls.some(([options], i) => {
      return (
        scroll.mock.contexts[i] === selected &&
        typeof options === "object" &&
        options.block === "center"
      );
    }),
  ).toBeTruthy();
  const other = document.querySelector(
    '[data-automation-id="' + schedule.id + '"]',
  );
  if (!other) {
    throw new Error("Missing weekday schedule");
  }
  expect(other).not.toHaveAttribute("aria-current");
  click(within(selected).getByRole("switch"));
  await screen.findByRole("switch", { name: "Enable Gmail new message" });
  expect(other.querySelector('[role="switch"]')).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("workflows-page-025 running the weekday schedule opens its chat and promotes Sales Research in the composer", async () => {
  createChatRunFixtures(context).installRunChat();
  const { base, sales } = directory();
  const schedule = weekday();
  sales.automations = [schedule];
  context.mocks.api(workflowsCollectionContract.composer, ({ respond }) => {
    return respond(200, [
      {
        id: crypto.randomUUID(),
        name: "alpha",
        displayName: null,
        description: null,
      },
      sales,
    ]);
  });
  context.mocks.api(workflowAutomationsContract.run, ({ params, respond }) => {
    expect(params.id).toBe(schedule.id);
    return respond(201, {
      runId: crypto.randomUUID(),
      chatThreadId: RUN_THREAD_ID,
    });
  });
  await setupPage({ context, path: base + "/automations" });
  click(await findAction("button", "Run now"));
  const editor = await screen.findByLabelText("Message");
  expect(location.pathname).toBe("/chats/" + RUN_THREAD_ID);
  await fill(editor, "Draft /");
  await slashChoice("sales-research");
  expect(
    slashRows().map((row) => {
      return row.textContent;
    }),
  ).toStrictEqual(["/sales-research", "/alpha"]);
});

async function chooseAutomation(category: string, choice: string) {
  click(await findAction("button", "Add automation"));
  const picker = await screen.findByRole("dialog");
  click(await findAction("button", category, picker));
  click(await within(picker).findByText(choice, { exact: true }));
}

test("workflows-page-026 a Gmail message rule combines sender inclusion with subject exclusion", async () => {
  const { sales, base } = directory();
  context.mocks.api(workflowAutomationsContract.create, ({ body, respond }) => {
    if (!("eventType" in body) || body.eventType !== "gmail-new-message") {
      throw new Error("Expected Gmail trigger");
    }
    expect(body.eventConfig.match).toStrictEqual({
      from: { contains: "@acme.com" },
      subject: { doesNotContain: "newsletter" },
    });
    const created = {
      ...weekday(),
      kind: "event" as const,
      eventType: body.eventType,
      eventConfig: body.eventConfig,
      schedule: null,
      scheduleSummary: null,
    };
    sales.automations = [created];
    return respond(201, created);
  });
  await setupPage({ context, path: base + "/automations" });
  await chooseAutomation("Email", "Gmail new message");
  await fill(await screen.findByLabelText("From contains"), "@acme.com");
  click(await findAction("button", "Add condition"));
  click(await screen.findByLabelText("Condition 2 operator"));
  click(await screen.findByRole("option", { name: "Does not contain" }));
  await fill(
    await screen.findByLabelText("Subject does not contain"),
    "newsletter",
  );
  click(await findAction("button", "Add Gmail automation"));
  await expect(
    screen.findByRole("group", { name: "Gmail new message" }),
  ).resolves.toBeVisible();
});

test("workflows-page-027 an unknown Gmail label keeps its editable value and the corrected label creates the automation", async () => {
  const { sales, base } = directory();
  const logged = vi.spyOn(console, "error");
  context.mocks.api(workflowAutomationsContract.create, ({ body, respond }) => {
    if (!("eventType" in body) || body.eventType !== "gmail-label-applied") {
      throw new Error("Expected Gmail label");
    }
    if (body.eventConfig.labelName === "Missing") {
      return respond(400, {
        error: {
          code: "GMAIL_LABEL_NOT_FOUND",
          message: "Label Missing was not found",
        },
      });
    }
    const saved = {
      ...weekday(),
      kind: "event" as const,
      eventType: body.eventType,
      eventConfig: body.eventConfig,
      schedule: null,
      scheduleSummary: null,
    };
    sales.automations = [saved];
    return respond(201, saved);
  });
  await setupPage({ context, path: base + "/automations" });
  await chooseAutomation("Email", "Gmail label applied");
  const label = await screen.findByLabelText("Label name");
  await fill(label, "Missing");
  const add = await findAction("button", "Add label automation");
  click(add);
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(
    "Label not found in the connected Gmail account",
  );
  expect(label).toHaveAttribute("aria-invalid", "true");
  expect(label).toHaveValue("Missing");
  expect(add).toBeEnabled();
  await fill(label, "Support");
  click(add);
  await screen.findByText(/Label [“"]?Support/);
  expect(logged.mock.calls.flat().map(String).join(" ")).not.toMatch(
    /GMAIL_LABEL_NOT_FOUND|Label Missing was not found/,
  );
});

test("workflows-page-028 an unexpected Gmail service error keeps the entered label and reports the specific API failure", async () => {
  const { base } = directory();
  const logged = vi.spyOn(console, "error");
  const message = "Failed to read Gmail labels.";
  context.mocks.api(workflowAutomationsContract.create, ({ respond }) => {
    return respond(400, { error: { code: "BAD_REQUEST", message } });
  });
  await setupPage({ context, path: base + "/automations" });
  await chooseAutomation("Email", "Gmail label applied");
  const label = await screen.findByLabelText("Label name");
  await fill(label, "Support");
  const add = await findAction("button", "Add label automation");
  click(add);
  await screen.findByText(message);
  expect(label).toHaveValue("Support");
  expect(add).toBeEnabled();
  expect(
    within(await screen.findByRole("dialog")).queryByRole("alert"),
  ).toBeNull();
  await waitFor(() => {
    return expect(logged.mock.calls.flat()).toContainEqual(
      expect.objectContaining({ status: 400, code: "BAD_REQUEST", message }),
    );
  });
});

test("workflows-page-030 a GitHub run automation carries the repository, workflows and selected failure conclusions", async () => {
  const { sales, base } = directory();
  context.mocks.api(
    integrationsGithubContract.getInstallation,
    ({ respond }) => {
      return respond(200, createDefaultMockGithubIntegration());
    },
  );
  context.mocks.api(workflowAutomationsContract.create, ({ body, respond }) => {
    if (
      !("eventType" in body) ||
      body.eventType !== "github-workflow-run-completed"
    ) {
      throw new Error("Expected workflow run trigger");
    }
    expect(body.eventConfig.filters).toStrictEqual({
      repositories: ["okou-ai/okou"],
      workflows: ["Turbo", ".github/workflows/turbo.yml"],
      branches: ["main"],
      events: ["push"],
      actors: ["lancy"],
      conclusions: ["failure", "startup_failure"],
    });
    const saved = {
      ...weekday(),
      kind: "event" as const,
      eventType: body.eventType,
      eventConfig: body.eventConfig,
      schedule: null,
      scheduleSummary: null,
    };
    sales.automations = [saved];
    return respond(201, saved);
  });
  await setupPage({ context, path: base + "/automations" });
  await chooseAutomation("GitHub", "GitHub workflow completed");
  const dialog = await screen.findByRole("dialog");
  for (const [field, value] of Object.entries({
    repositories: "okou-ai/okou",
    workflows: "Turbo, .github/workflows/turbo.yml",
    branches: "main",
    events: "push",
    actors: "lancy",
  })) {
    const input = dialog.querySelector('[name="' + field + '"]');
    if (!input) {
      throw new Error("Missing field " + field);
    }
    await fill(input as HTMLElement, value);
  }
  for (const name of ["Failure", "Startup failure"]) {
    click(await within(dialog).findByLabelText(name));
  }
  click(await findAction("button", "Add workflow automation", dialog));
  await expect(
    screen.findByRole("group", { name: "GitHub workflow completed" }),
  ).resolves.toBeVisible();
});
