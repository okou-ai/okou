import {
  SKILL_IMPORT_LIMITS,
  SKILL_IMPORT_SESSION_TTL_SECONDS,
  skillImportSessionsContract,
} from "@okouai/api-contracts/contracts/skill-import";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
  workflowsDetailContract,
  type WorkflowImportSource,
  type WorkflowSummary,
} from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { now } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const PROMPT_LABEL = "Skill import prompt";
const DIALOG_TITLE = "Import your skills";

function workflow(entry: {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly importSource?: WorkflowImportSource | null;
}): WorkflowSummary {
  return {
    id: entry.id,
    agentId: DEFAULT_AGENT_ID,
    agentName: null,
    agentDisplayName: null,
    name: entry.name,
    displayName: entry.displayName,
    description: null,
    visibility: "private",
    ownerUserId: "test-user-123",
    createdAt: "2026-09-21T10:00:00.000Z",
    canManage: true,
    canPublish: false,
    official: null,
    importSource: entry.importSource ?? null,
  };
}

/**
 * The workflow list, which the page shows and the dialog polls; the test
 * decides what the user's own Claude Code or Codex session has written.
 */
function mockWorkflows(initial: readonly WorkflowSummary[] = []): {
  readonly write: (workflows: readonly WorkflowSummary[]) => void;
} {
  let workflows = initial;
  context.mocks.api(workflowsCollectionContract.list, ({ respond }) => {
    return respond(200, [...workflows]);
  });
  context.mocks.api(
    workflowAutomationsContract.listWorkspace,
    ({ respond }) => {
      return respond(200, []);
    },
  );
  context.mocks.api(workflowsDetailContract.ownerProfile, ({ respond }) => {
    return respond(200, { displayName: "Test User", imageUrl: null });
  });
  return {
    write: (next) => {
      workflows = next;
    },
  };
}

/** Each session names the tool it was opened for, in the order they opened. */
function mockSessions(): { readonly providers: string[] } {
  const providers: string[] = [];
  context.mocks.api(skillImportSessionsContract.create, ({ body, respond }) => {
    providers.push(body.provider);
    return respond(200, {
      uploadUrl: "https://api.okou.test/api/skill-import/skills",
      token: `vm0_skillimport_${body.provider}-session-token`,
      expiresAt: new Date(
        now() + SKILL_IMPORT_SESSION_TTL_SECONDS * 1000,
      ).toISOString(),
      limits: SKILL_IMPORT_LIMITS,
    });
  });
  return { providers };
}

async function openWorkflowsPage(
  featureSwitches: Partial<Record<FeatureSwitchKey, boolean>> = {},
): Promise<void> {
  await setupPage({ context, path: "/workflows", featureSwitches });
  await screen.findByRole("heading", { name: "Workflows" });
}

function buttonNamed(
  name: string,
  container: ParentNode = document.body,
): HTMLElement | undefined {
  return queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
}

function getButtonNamed(
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = buttonNamed(name, container);
  if (!button) {
    throw new Error(`Expected button named "${name}"`);
  }
  return button;
}

async function findDialog(): Promise<HTMLElement> {
  return await screen.findByRole("dialog", { name: DIALOG_TITLE });
}

/** The prompt's copy button, which appears once its session has opened. */
async function findCopyPrompt(dialog: HTMLElement): Promise<HTMLElement> {
  await waitFor(() => {
    getButtonNamed("Copy prompt", dialog);
  });
  return getButtonNamed("Copy prompt", dialog);
}

/** The dialog keeps the prompt to one line until the user asks for all of it. */
async function showFullPrompt(dialog: HTMLElement): Promise<HTMLElement> {
  await findCopyPrompt(dialog);
  click(getButtonNamed("Show full prompt", dialog));
  return await within(dialog).findByRole("region", { name: PROMPT_LABEL });
}

test("Import skills sits between Browse official and Create in chat", async () => {
  mockWorkflows();
  mockSessions();

  await openWorkflowsPage({ [FeatureSwitchKey.OfficialWorkflows]: true });

  const browse = screen.getByText("Browse Official").closest("a");
  const importSkills = getButtonNamed("Import skills");
  const createInChat = getButtonNamed("Create in chat");
  expect(browse?.nextElementSibling).toBe(importSkills);
  expect(importSkills.nextElementSibling).toBe(createInChat);
});

test("Import skills opens a Claude Code prompt by default", async () => {
  mockWorkflows();
  const sessions = mockSessions();
  await openWorkflowsPage();

  click(getButtonNamed("Import skills"));

  const dialog = await findDialog();
  expect(
    within(dialog).getByText(
      "Run this prompt where your skills live. Each one becomes a private workflow.",
    ),
  ).toBeInTheDocument();
  expect(
    within(dialog).getByRole("radio", { name: "Claude Code" }),
  ).toBeChecked();
  // Copying is the dialog's first step, and the full prompt stays folded.
  await findCopyPrompt(dialog);
  const guide = within(dialog).getByRole("list", {
    name: "Where to run the prompt",
  });
  expect(guide).toHaveTextContent("Copy the prompt");
  expect(guide).toHaveTextContent(
    "Open the Claude app and switch to the Code tab",
  );
  expect(
    within(dialog).queryByRole("region", { name: PROMPT_LABEL }),
  ).toBeNull();
  expect(
    within(dialog).getByText("Imported skills appear here as they arrive."),
  ).toBeVisible();
  const prompt = await showFullPrompt(dialog);
  expect(prompt.textContent).toContain(
    "vm0_skillimport_claudeCode-session-token",
  );
  expect(prompt.textContent).toContain("~/.claude/skills/");
  expect(prompt.textContent).not.toContain("~/.codex/skills/");
  expect(sessions.providers).toStrictEqual(["claudeCode"]);
});

test("Switching the dialog to Codex writes the prompt for Codex", async () => {
  mockWorkflows();
  const sessions = mockSessions();
  await openWorkflowsPage();
  click(getButtonNamed("Import skills"));
  const dialog = await findDialog();
  await showFullPrompt(dialog);

  click(within(dialog).getByRole("radio", { name: "Codex" }));

  await waitFor(() => {
    expect(
      within(dialog).getByRole("region", { name: PROMPT_LABEL }).textContent,
    ).toContain("vm0_skillimport_codex-session-token");
  });
  const guide = within(dialog).getByRole("list", {
    name: "Where to run the prompt",
  });
  expect(guide).toHaveTextContent("Open the Codex app and start a New chat");
  expect(guide).not.toHaveTextContent("Code tab");
  const prompt = within(dialog).getByRole("region", { name: PROMPT_LABEL });
  expect(prompt.textContent).toContain("~/.codex/skills/");
  expect(prompt.textContent).not.toContain("~/.claude/skills/");
  expect(sessions.providers).toStrictEqual(["claudeCode", "codex"]);
});

test("The empty workflow list offers the import", async () => {
  mockWorkflows();
  mockSessions();
  await openWorkflowsPage();

  expect(screen.getByText("No workflows")).toBeInTheDocument();
  click(getButtonNamed("Import from Claude Code or Codex"));

  const dialog = await findDialog();
  await expect(findCopyPrompt(dialog)).resolves.toBeVisible();
});

test("An imported workflow is tagged with the tool it came from", async () => {
  mockWorkflows([
    workflow({
      id: "d0000000-0000-4000-a000-000000000401",
      name: "release-notes",
      displayName: "Release notes",
      importSource: "codex",
    }),
    workflow({
      id: "d0000000-0000-4000-a000-000000000402",
      name: "weekly-report",
      displayName: "Weekly report",
      importSource: "claudeCode",
    }),
    workflow({
      id: "d0000000-0000-4000-a000-000000000403",
      name: "made-in-okou",
      displayName: "Made in Okou",
    }),
  ]);

  await openWorkflowsPage();

  const releaseNotes = (await screen.findByText("Release notes")).closest(
    "article",
  );
  const weeklyReport = screen.getByText("Weekly report").closest("article");
  const madeInOkou = screen.getByText("Made in Okou").closest("article");
  if (!releaseNotes || !weeklyReport || !madeInOkou) {
    throw new Error("Expected a row for each workflow");
  }
  expect(within(releaseNotes).getByText("Imported from Codex")).toBeVisible();
  expect(
    within(weeklyReport).getByText("Imported from Claude Code"),
  ).toBeVisible();
  expect(within(madeInOkou).queryByText(/^Imported from/)).toBeNull();
});

test("The dialog lists only workflows the import tagged", async () => {
  const workflows = mockWorkflows();
  mockSessions();
  await openWorkflowsPage();
  click(getButtonNamed("Import skills"));
  const dialog = await findDialog();
  await findCopyPrompt(dialog);

  // A workflow made in chat arrives alongside the imported one.
  workflows.write([
    workflow({
      id: "d0000000-0000-4000-a000-000000000421",
      name: "made-in-chat",
      displayName: "Made in chat",
    }),
    workflow({
      id: "d0000000-0000-4000-a000-000000000422",
      name: "weekly-report",
      displayName: "Weekly report",
      importSource: "claudeCode",
    }),
  ]);

  await expect(
    within(dialog).findByText("Weekly report"),
  ).resolves.toBeVisible();
  expect(within(dialog).queryByText("Made in chat")).toBeNull();
});

test("Reopening the dialog lists only the skills that opening imports", async () => {
  const workflows = mockWorkflows();
  mockSessions();
  await openWorkflowsPage();
  click(getButtonNamed("Import skills"));
  let dialog = await findDialog();
  await findCopyPrompt(dialog);
  expect(
    within(dialog).getByText("Imported skills appear here as they arrive."),
  ).toBeVisible();

  // The user's Claude Code session writes one skill back.
  const weeklyReport = workflow({
    id: "d0000000-0000-4000-a000-000000000411",
    name: "weekly-report",
    displayName: "Weekly report",
    importSource: "claudeCode",
  });
  workflows.write([weeklyReport]);
  await expect(
    within(dialog).findByText("Weekly report"),
  ).resolves.toBeVisible();
  // The footer counts what arrived and keeps listening for more.
  expect(within(dialog).getByRole("status")).toHaveTextContent(
    "1 imported · listening for more",
  );

  click(getButtonNamed("Close", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  // Closing brings the page's own list up to date with what arrived.
  await expect(
    screen.findByText("Imported from Claude Code"),
  ).resolves.toBeVisible();

  // Reopening starts over: the same steps, and none of the earlier skills.
  click(getButtonNamed("Import skills"));
  dialog = await findDialog();
  await findCopyPrompt(dialog);
  expect(within(dialog).queryByText("Weekly report")).toBeNull();
  expect(within(dialog).getByRole("status")).toHaveTextContent(
    "Imported skills appear here as they arrive.",
  );

  workflows.write([
    weeklyReport,
    workflow({
      id: "d0000000-0000-4000-a000-000000000412",
      name: "launch-checklist",
      displayName: "Launch checklist",
      importSource: "claudeCode",
    }),
  ]);
  await expect(
    within(dialog).findByText("Launch checklist"),
  ).resolves.toBeVisible();
  expect(within(dialog).queryByText("Weekly report")).toBeNull();
});
