import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { connectorAccountFixture } from "../../../mocks/handlers/connector-account-fixtures.ts";
import {
  mockPublicConnectorStatus,
  mockSavedConnectorAccounts,
} from "../../okou-page/__tests__/connector-page-test-helpers.ts";
import {
  browserAuthMethod,
  catalogConnector,
} from "../../okou-page/__tests__/chat-capability-connector-test-helpers.ts";
import userEvent from "@testing-library/user-event";
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
import {
  setupPage,
  click,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findAction,
  queryAction,
} from "../../okou-page/__tests__/connector-integrations-test-helpers.ts";
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
      name: "ops-playbook",
      displayName: "Ops Playbook",
    });
  const entries = [sales, ops];
  serveWorkflows(context, () => {
    return entries;
  });
  return { sales, entries, base: "/workflows/" + sales.id };
}

function weekday(): Extract<WorkflowAutomationSummary, { kind: "schedule" }> {
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

function matchingMenuItems(role: "menuitem" | "menuitemradio", name: string) {
  return queryAllByRoleFast(role).filter((item) => {
    return (
      item.getAttribute("aria-label") === name ||
      !!item.textContent?.trim().startsWith(name)
    );
  });
}

function findMenuItem(role: "menuitem" | "menuitemradio", name: string) {
  return waitFor(() => {
    const item = matchingMenuItems(role, name)[0];
    if (!item) {
      throw new Error("Menu item unavailable: " + name);
    }
    return item;
  });
}

function editableFiles() {
  const { sales, base } = directory();
  const documents = [
    { path: "config/settings.json", content: '{"region":"West"}' },
    { path: "examples/prompt.md", content: "Draft the field report" },
  ];
  function persist(files: typeof documents) {
    sales.fileContents = files;
    sales.files = files.map((f) => {
      return { path: f.path, size: f.content.length };
    });
  }
  persist(documents);
  context.mocks.api(workflowsDetailContract.update, ({ body, respond }) => {
    if (body.files) {
      persist(body.files);
    }
    return respond(200, sales);
  });
  return { sales, path: base + "/instructions", documents };
}

test("workflows-page-058 the file picker commits Enter and Space selections and cancels an uncommitted choice", async () => {
  const { path, documents } = editableFiles();
  await setupPage({ context, path: path + "?file=config/settings.json" });
  await screen.findByText(documents[0].content);
  const picker = await screen.findByLabelText("Workflow files");
  const user = userEvent.setup({ delay: null });
  await user.click(picker);
  const instructions = await findMenuItem("menuitemradio", "instructions");
  for (
    let step = 0;
    step < 5 && document.activeElement !== instructions;
    step++
  ) {
    await user.keyboard("{ArrowDown}");
  }
  expect(instructions).toHaveFocus();
  await user.keyboard("{Enter}");
  await screen.findByText("Review the pipeline");
  expect(location.search).toBe("");
  expect(picker).toHaveFocus();
  expect(screen.queryByRole("menu")).toBeNull();
  await user.click(picker);
  const example = await findMenuItem("menuitemradio", "examples/prompt.md");
  for (let step = 0; step < 5 && document.activeElement !== example; step++) {
    await user.keyboard("{ArrowDown}");
  }
  expect(example).toHaveFocus();
  await user.keyboard("[Space]");
  await screen.findByText(documents[1].content);
  expect(new URLSearchParams(location.search).get("file")).toBe(
    documents[1].path,
  );
  await user.click(picker);
  await user.keyboard("{Home}{Escape}");
  expect(picker).toHaveFocus();
  expect(picker).toHaveTextContent(documents[1].path);
  expect(screen.queryByRole("menu")).toBeNull();
});

test("workflows-page-060 keyboard file actions delete the chosen JSON and retain its sibling", async () => {
  const { path, documents, sales } = editableFiles();
  await setupPage({ context, path });
  await screen.findByText("Review the pipeline");
  const picker = screen.getByLabelText("Workflow files");
  const user = userEvent.setup({ delay: null });
  await user.click(picker);
  await user.keyboard("{Home}{ArrowDown}");
  const config = await findMenuItem("menuitemradio", "config/settings.json");
  await user.keyboard("config");
  await waitFor(() => {
    return expect(config).toHaveFocus();
  });
  await user.keyboard("{Enter}");
  await screen.findByText(documents[0].content);
  await user.click(picker);
  await user.keyboard("del");
  await waitFor(() => {
    return expect(document.activeElement).toHaveAccessibleName(/Delete config/);
  });
  await user.keyboard("{Enter}");
  await screen.findByText("Review the pipeline");
  expect(picker).toHaveTextContent("instructions");
  expect(sales.fileContents).toStrictEqual([documents[1]]);
});

test("workflows-page-061 a failed upload leaves the selected JSON open and allows another upload", async () => {
  const { path, documents } = editableFiles();
  context.mocks.api(workflowsDetailContract.update, ({ respond }) => {
    return respond(409, {
      error: { code: "CONFLICT", message: "File revision changed" },
    });
  });
  await setupPage({ context, path: path + "?file=config/settings.json" });
  await screen.findByText(documents[0].content);
  const input = screen.getByLabelText("Upload workflow files");
  await userEvent.upload(
    input,
    new File(["brief"], "notes.md", { type: "text/markdown" }),
  );
  await screen.findByText("File revision changed");
  expect(screen.getByLabelText("Workflow files")).toHaveTextContent(
    documents[0].path,
  );
  expect(screen.getByLabelText("Workflow file content")).toHaveTextContent(
    documents[0].content,
  );
  expect(new URLSearchParams(location.search).get("file")).toBe(
    documents[0].path,
  );
  click(screen.getByLabelText("Workflow files"));
  const upload = await findMenuItem("menuitem", "Upload text files");
  expect(upload).toBeVisible();
  expect(upload).not.toHaveAttribute("aria-disabled", "true");
});

test("workflows-page-063 cancelling the file chooser and uploading revised notes preserve the selection and existing files", async () => {
  const { path, sales, documents } = editableFiles();
  await setupPage({ context, path });
  const picker = await screen.findByLabelText("Workflow files");
  const user = userEvent.setup({ delay: null });
  await user.click(picker);
  await user.keyboard("{Escape}");
  const input = screen.getByLabelText("Upload workflow files");
  await user.upload(input, new File(["First edition"], "notes.md"));
  await screen.findByText("First edition");
  expect(sales.fileContents).toContainEqual(documents[0]);
  fireEvent.change(input, { target: { files: [] } });
  expect(picker).toHaveTextContent("notes.md");
  await user.click(picker);
  click(await findMenuItem("menuitemradio", "instructions"));
  await screen.findByText("Review the pipeline");
  await user.upload(input, new File(["Second edition"], "notes.md"));
  await screen.findByText("Second edition");
  expect(picker).toHaveTextContent("notes.md");
  expect(new URLSearchParams(location.search).get("file")).toBe("notes.md");
});

test("workflows-page-064 a nested upload replaces one path and leaves the other file readable", async () => {
  const { path, documents, sales } = editableFiles();
  await setupPage({ context, path });
  const input = await screen.findByLabelText("Upload workflow files");
  const file = new File(["Updated outline"], "prompt.md");
  Object.defineProperty(file, "webkitRelativePath", {
    value: documents[1].path,
  });
  await userEvent.upload(input, file);
  await screen.findByText("Updated outline");
  expect(new URLSearchParams(location.search).get("file")).toBe(
    documents[1].path,
  );
  expect(sales.fileContents).toStrictEqual([
    documents[0],
    { path: documents[1].path, content: "Updated outline" },
  ]);
  click(screen.getByLabelText("Workflow files"));
  expect(matchingMenuItems("menuitemradio", "examples/prompt.md")).toHaveLength(
    1,
  );
});

test("workflows-page-031 the GitHub form links to the installation supplied for this workspace", async () => {
  const { base } = directory();
  const installUrl =
    "https://github.com/apps/research-workspace/installations/new";
  context.mocks.api(
    integrationsGithubContract.getInstallation,
    ({ respond }) => {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Installation unavailable" },
        installUrl,
      });
    },
  );
  await setupPage({ context, path: base + "/automations" });
  await chooseAutomation("GitHub", "GitHub workflow completed");
  await expect(
    findAction("link", "Install GitHub App"),
  ).resolves.toHaveAttribute("href", installUrl);
});

function calendarIssue(
  warning: "calendar_not_found" | "reconnect_required" = "calendar_not_found",
) {
  return {
    ...weekday(),
    kind: "event" as const,
    eventType: "google-calendar-event-created" as const,
    eventConfig: {
      provider: "google-calendar" as const,
      event: "event_created" as const,
      calendarId: "missing-created@example.com",
    },
    schedule: null,
    scheduleSummary: null,
    warning,
  };
}

test("workflows-page-035 replacing a missing calendar restores delivery without changing its trigger", async () => {
  const { base, sales } = directory();
  const calendar = calendarIssue();
  sales.automations = [calendar];
  const replacement = "replacement@example.com";
  context.mocks.api(
    workflowAutomationsContract.update,
    ({ body, params, respond }) => {
      expect(params.id).toBe(calendar.id);
      expect(body).toStrictEqual({
        eventConfig: { ...calendar.eventConfig, calendarId: replacement },
      });
      const restored = {
        ...calendar,
        warning: undefined,
        eventConfig: { ...calendar.eventConfig, calendarId: replacement },
      };
      sales.automations = [restored];
      return respond(200, restored);
    },
  );
  await setupPage({ context, path: base + "/automations" });
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("This calendar is no longer available");
  const row = alert.closest("[data-automation-id]")!;
  expect(row).not.toHaveClass("opacity-75");
  expect(within(row as HTMLElement).getByRole("switch")).toBeChecked();
  click(await findAction("button", "Change calendar", alert));
  const field = await screen.findByLabelText("Calendar ID");
  expect(field).toHaveValue(calendar.eventConfig.calendarId);
  await fill(field, replacement);
  click(await findAction("button", "Save calendar"));
  await screen.findByText(new RegExp(replacement));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByLabelText("Calendar ID")).toBeNull();
  expect(screen.getByRole("switch")).toBeChecked();
});

test("workflows-page-036 a different owner's paused Calendar rule stays enabled and read-only", async () => {
  const { base, sales } = directory();
  sales.canManage = false;
  const rule = calendarIssue("reconnect_required");
  rule.ownerUserId = "calendar-owner";
  sales.automations = [rule];
  await setupPage({ context, path: base + "/automations" });
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Action required — delivery paused");
  const toggle = screen.getByRole("switch");
  expect(toggle).toBeChecked();
  expect(toggle).toHaveAttribute("aria-disabled", "true");
  expect(queryAction("button", "Change calendar")).toBeNull();
  expect(queryAction("button", "Reconnect Google Calendar")).toBeNull();
});

test("workflows-page-037 a directory warning opens and centers its precise Calendar rule", async () => {
  const { base, sales } = directory();
  const rule = calendarIssue();
  sales.automations = [weekday(), rule];
  context.mocks.api(
    workflowAutomationsContract.listWorkspace,
    ({ respond }) => {
      return respond(200, [{ workflow: sales, automation: rule }]);
    },
  );
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
  await setupPage({ context, path: "/workflows" });
  const badge = await screen.findByText("Action required", { exact: true });
  click(badge);
  click(await findAction("link", "Open Sales Research recovery"));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Action required — delivery paused");
  const row = alert.closest("[data-automation-id]");
  expect(row).toHaveAttribute("data-automation-id", rule.id);
  expect(row).toHaveAttribute("aria-current", "true");
  expect(
    scroll.mock.calls.some(([o], i) => {
      return (
        scroll.mock.contexts[i] === row &&
        typeof o === "object" &&
        o.block === "center"
      );
    }),
  ).toBeTruthy();
  expect(location.pathname).toBe(base + "/automations");
});

test("workflows-page-039 a submitted Google Forms link creates a visibly paused form rule", async () => {
  const { base, sales } = directory();
  const formUrl = "https://docs.google.com/forms/d/field-research/edit";
  const warning = "The form is not accepting responses.";
  context.mocks.api(workflowAutomationsContract.create, ({ body, respond }) => {
    expect(body).toMatchObject({
      eventType: "google-forms-response-submitted",
      eventConfig: { formUrl },
    });
    const rule = {
      ...weekday(),
      kind: "event" as const,
      eventType: "google-forms-response-submitted" as const,
      eventConfig: {
        provider: "google-forms" as const,
        event: "response_submitted" as const,
        connectorId: crypto.randomUUID(),
        form: { id: "field-research", title: "Field research", url: formUrl },
      },
      warning,
      schedule: null,
      scheduleSummary: null,
    };
    sales.automations = [rule];
    return respond(201, rule);
  });
  await setupPage({ context, path: base + "/automations" });
  await chooseAutomation("Google Forms", "Google Forms response submitted");
  await fill(await screen.findByLabelText("Form link"), formUrl);
  click(await findAction("button", "Add Google Forms automation"));
  await screen.findByText(warning);
});

test("workflows-page-050 a one-time schedule submits the chosen July time in UTC", async () => {
  const { base, sales } = directory();
  context.mocks.api(workflowAutomationsContract.create, ({ body, respond }) => {
    expect(body).toMatchObject({
      schedule: {
        type: "once",
        atTime: new Date(2026, 6, 1, 10, 30).toISOString(),
        timezone: "UTC",
      },
    });
    const saved = {
      ...weekday(),
      schedule: {
        type: "once" as const,
        atTime: new Date(2026, 6, 1, 10, 30).toISOString(),
        timezone: "UTC",
      },
      scheduleSummary: "July review",
    };
    sales.automations = [saved];
    return respond(201, saved);
  });
  await setupPage({ context, path: base + "/automations" });
  await chooseAutomation("Schedule", "One-time run");
  fireEvent.change(await screen.findByLabelText("Run at"), {
    target: { value: "2026-07-01T10:30" },
  });
  click(await findAction("button", "Add one-time run"));
  await screen.findByRole("switch");
});

function copies() {
  const { sales, entries } = directory();
  const shared = salesWorkflow(context, {
    id: crypto.randomUUID(),
    visibility: "public",
    instruction: "Shared handbook",
    shadowedBy: {
      id: sales.id,
      name: sales.name,
      displayName: sales.displayName,
    },
  });
  sales.instruction = "Keep the regional handbook";
  entries.push(shared);
  return { shared, sales, entries };
}

test("A member sees the shared workflow and the private definition that overrides it", async () => {
  const { shared, sales } = copies();
  await setupPage({ context, path: "/workflows" });
  const badge = await screen.findByText("Overridden for you");
  expect(badge.closest("a")).toHaveAttribute(
    "href",
    "/workflows/" + shared.id + "/automations",
  );
  const own = await screen.findByText("Used for /sales-research");
  expect(own.closest("a")).toHaveAttribute(
    "href",
    "/workflows/" + sales.id + "/automations",
  );
  await expect(
    screen.findAllByText("Sales Research", { exact: true }),
  ).resolves.toHaveLength(2);
});

test("workflows-page-073 an existing private copy opens with its retained instructions", async () => {
  const { shared, sales } = copies();
  await setupPage({ context, path: "/workflows/" + shared.id + "/info" });
  click(await findAction("button", "Make private copy"));
  const dialog = await screen.findByRole("dialog");
  const link = await findAction("link", "Open private copy", dialog);
  click(link);
  await screen.findByText("Keep the regional handbook");
  expect(location.pathname).toBe("/workflows/" + sales.id + "/instructions");
  expect(sales.instruction).toBe("Keep the regional handbook");
});

test("Creating a workspace workflow opens the member’s chat composer", async () => {
  directory();
  createChatRunFixtures(context).installRunChat();
  await setupPage({ context, path: "/workflows" });
  click(await findAction("button", "Create in chat"));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).queryByRole("combobox")).toBeNull();
  click(await findAction("button", "Create workflow", dialog));
  await screen.findByLabelText("Message");
  expect(location.pathname).toBe("/");
});

test("workflows-page-056 a label edit can recover without replacing the saved label on rejection", async () => {
  const { base, sales } = directory();
  const original = {
    ...weekday(),
    kind: "event" as const,
    eventType: "gmail-label-applied" as const,
    schedule: null,
    scheduleSummary: null,
    eventConfig: {
      provider: "gmail" as const,
      event: "label_applied" as const,
      labelName: "Support",
    },
  };
  sales.automations = [original];
  context.mocks.api(
    workflowAutomationsContract.update,
    ({ params, body, respond }) => {
      expect(params.id).toBe(original.id);
      if (
        !("eventConfig" in body) ||
        !body.eventConfig ||
        !("labelName" in body.eventConfig)
      ) {
        throw new Error("Missing Gmail label");
      }
      if (body.eventConfig.labelName === "Missing") {
        return respond(400, {
          error: {
            code: "GMAIL_LABEL_NOT_FOUND",
            message: "Transport label detail",
          },
        });
      }
      const saved = {
        ...original,
        eventConfig: {
          ...original.eventConfig,
          labelName: body.eventConfig.labelName,
        },
      };
      sales.automations = [saved];
      return respond(200, saved);
    },
  );
  await setupPage({ context, path: base + "/automations" });
  await screen.findByText(/Label .*Support/);
  click(await findAction("button", "Edit automation"));
  const label = await screen.findByLabelText("Label name");
  await fill(label, "Missing");
  click(await findAction("button", "Save label"));
  await screen.findByRole("alert");
  expect(screen.getByRole("alert")).toHaveTextContent("Label not found");
  expect(label).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByText(/Label .*Support/)).toBeVisible();
  expect(screen.queryByText("Transport label detail")).toBeNull();
  await fill(label, "Escalated");
  click(await findAction("button", "Save label"));
  await screen.findByText(/Label .*Escalated/);
  expect(screen.queryByLabelText("Label name")).toBeNull();
});

test("workflows-page-047 revealed webhook fields copy their own values and are hidden on the next opening", async () => {
  const { base, sales } = directory();
  const rule = {
    ...weekday(),
    kind: "event" as const,
    eventType: "webhook-received" as const,
    eventConfig: {
      provider: "webhook" as const,
      event: "received" as const,
      auth: { mode: "hmac-sha256" as const },
    },
    schedule: null,
    scheduleSummary: null,
    secretLastFour: "8f01",
    lastReceivedAt: null,
  };
  sales.automations = [rule];
  const url = "https://hooks.example.org/field/weekly",
    secret = "test-signature-8f01";
  const clipboard = context.mocks.browser.clipboardWriteText();
  context.mocks.api(
    workflowAutomationsContract.revealWebhookSecret,
    ({ params, respond }) => {
      expect(params.id).toBe(rule.id);
      return respond(200, { webhookUrl: url, webhookSecret: secret });
    },
  );
  await setupPage({ context, path: base + "/automations" });
  for (let opening = 0; opening < 2; opening++) {
    click(await findAction("button", "More actions"));
    click(await findMenuItem("menuitem", "View webhook secret"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByDisplayValue(url)).toBeNull();
    click(await findAction("button", "Reveal secret", dialog));
    const address = await within(dialog).findByDisplayValue(url);
    const key = within(dialog).getByDisplayValue(secret);
    expect(address).toHaveAttribute("readonly");
    expect(key).toHaveAttribute("readonly");
    for (const field of [address, key]) {
      await userEvent.click(field);
      await userEvent.keyboard("{Control>}a{/Control}x");
      expect(field).toHaveValue(field === address ? url : secret);
      await userEvent.keyboard("{Tab}");
      const copy = await findAction("button", "Copy", field.parentElement!);
      expect(copy).toHaveFocus();
      await userEvent.keyboard("{Enter}");
    }
    const command = dialog.querySelector("pre")?.textContent;
    expect(command).toContain(url);
    expect(command).toContain(secret);
    const buttons = queryAllByRoleFast("button", dialog).filter((button) => {
      return button.textContent?.trim() === "Copy";
    });
    click(buttons[buttons.length - 1]);
    expect(clipboard.writes).toStrictEqual(
      expect.arrayContaining([url, secret, command]),
    );
    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      return expect(screen.queryByRole("dialog")).toBeNull();
    });
  }
});

function intervalRule(seconds: number) {
  return {
    ...weekday(),
    schedule: { type: "loop" as const, intervalSeconds: seconds },
    scheduleSummary: seconds === 3600 ? "Every hour" : "Every five hours",
  };
}

test("workflows-page-051 an older update changes the saved interval without dismissing the reopened draft", async () => {
  const { base, sales } = directory();
  const rule = intervalRule(3600);
  sales.automations = [rule];
  const gate = context.mocks.deferred<void>(),
    started = context.mocks.deferred<void>();
  context.mocks.api(
    workflowAutomationsContract.update,
    async ({ body, respond }) => {
      expect(body).toMatchObject({
        schedule: { type: "loop", intervalSeconds: 900 },
      });
      started.resolve();
      await gate.promise;
      const saved = {
        ...rule,
        schedule: { type: "loop" as const, intervalSeconds: 18_000 },
        scheduleSummary: "Every five hours",
      };
      sales.automations = [saved];
      return respond(200, saved);
    },
  );
  await setupPage({ context, path: base + "/automations" });
  click(await findAction("button", "Edit automation"));
  click(await screen.findByRole("combobox", { name: "Every" }));
  click(await screen.findByRole("option", { name: /15 min/i }));
  click(await findAction("button", "Save schedule"));
  try {
    await started.promise;
    await userEvent.keyboard("{Escape}");
    click(await findAction("button", "Edit automation"));
    const field = await screen.findByRole("combobox", { name: "Every" });
    click(field);
    click(await screen.findByRole("option", { name: /30 min/i }));
    gate.resolve();
    await screen.findByText(/Every (five|5) hours/i);
    expect(field).toHaveTextContent(/30 min/i);
    expect(screen.getByRole("dialog")).toBeVisible();
  } finally {
    if (!gate.settled()) {
      gate.resolve();
    }
  }
});

test("workflows-page-070 a delayed interval creation leaves the new scheduled-time editor on hour 16", async () => {
  const { base, sales } = directory();
  const gate = context.mocks.deferred<void>(),
    started = context.mocks.deferred<void>();
  context.mocks.api(
    workflowAutomationsContract.create,
    async ({ body, respond }) => {
      expect(body).toMatchObject({
        schedule: { type: "loop", intervalSeconds: 900 },
      });
      started.resolve();
      await gate.promise;
      const saved = intervalRule(18_000);
      sales.automations = [saved];
      return respond(201, saved);
    },
  );
  await setupPage({ context, path: base + "/automations" });
  await chooseAutomation("Schedule", "Interval");
  click(await screen.findByRole("combobox", { name: "Every" }));
  click(await screen.findByRole("option", { name: /15 min/i }));
  click(await findAction("button", "Add interval"));
  try {
    await started.promise;
    await userEvent.keyboard("{Escape}");
    await chooseAutomation("Schedule", "Scheduled time");
    const hour = await screen.findByLabelText("Hour");
    click(hour);
    click(await screen.findByRole("option", { name: "16" }));
    gate.resolve();
    await screen.findByText(/Every (five|5) hours/i);
    expect(hour).toHaveTextContent("16");
    expect(screen.getByRole("dialog")).toBeVisible();
  } finally {
    if (!gate.settled()) {
      gate.resolve();
    }
  }
});

test("workflows-page-038 a completed reconnection clears the selected Calendar rule's warning", async () => {
  const { base, sales } = directory();
  const rule = calendarIssue("reconnect_required");
  sales.automations = [rule];
  const account = connectorAccountFixture(
    { kind: "builtin", connectorSlug: "google-calendar" },
    {
      displayName: "Events account",
      authMethod: "oauth",
      connectionStatus: "reconnect-required",
      reconnectReason: "authorization_expired_or_revoked",
    },
  );
  mockSavedConnectorAccounts(context, () => {
    return [account];
  });
  context.mocks.api(
    connectorAccountsContract.connection,
    ({ params, query, respond }) => {
      expect(params.connectionId).toBe(account.id);
      expect(query).toStrictEqual(account.target);
      return respond(200, account);
    },
  );
  mockPublicConnectorStatus(context, [
    catalogConnector({
      slug: "google-calendar",
      label: "Google Calendar",
      method: browserAuthMethod(),
      hasAccount: true,
      reconnectRequired: true,
      connectionId: account.id,
    }),
  ]);
  const popup = context.mocks.browser.authWindow();
  Object.defineProperty(popup, "location", { value: { href: "about:blank" } });
  context.mocks.browser.open(popup);
  const attempt = crypto.randomUUID();
  const receipt = context.mocks.deferred<string>();
  context.mocks.api(
    builtinConnectorOauthStartContract.start,
    ({ body, respond }) => {
      expect(body.account).toStrictEqual({
        intent: "reconnect",
        connectionId: account.id,
      });
      return respond(200, {
        authorizationUrl: "https://calendar.example.org/sign-in",
        oauthAttemptId: attempt,
      });
    },
  );
  context.mocks.api(
    connectorAccountsContract.oauthCompletion,
    ({ params, respond }) => {
      expect(params.attemptId).toBe(attempt);
      account.connectionStatus = "connected";
      account.reconnectReason = null;
      receipt.resolve(account.id);
      sales.automations = [{ ...rule, warning: undefined }];
      return respond(200, { connectionId: account.id });
    },
  );
  await setupPage({ context, path: base + "/automations" });
  await screen.findByRole("alert");
  click(await findAction("button", "Reconnect Google Calendar"));
  const row = await screen.findByRole("group", { name: "Events account" });
  click(await findAction("button", "Reconnect", row));
  const dialog = await screen.findByRole("dialog");
  click(await findAction("button", "Reconnect", dialog));
  await expect(receipt.promise).resolves.toBe(account.id);
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(screen.getByRole("alert")).toHaveTextContent("Action required");
  context.mocks.ably.trigger("connector:changed", {
    connectorSlug: "google-calendar",
  });
  await waitFor(() => {
    return expect(screen.queryByRole("alert")).toBeNull();
  });
  expect(screen.getByRole("switch")).toBeChecked();
});
