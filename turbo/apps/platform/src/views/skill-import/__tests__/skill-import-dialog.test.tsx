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
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { now } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname, search } from "../../../signals/location.ts";

const context = testContext();

const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const PROMPT_LABEL = "Skill import prompt";
const DIALOG_TITLE = "Import your skills";
const CLAUDE_SESSION_ID = "b0000000-0000-4000-a000-000000000001";
const CODEX_SESSION_ID = "b0000000-0000-4000-a000-000000000002";

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
 * The page workflow list and the session results read; the test
 * decides what the user's own Claude Code or Codex session has written.
 */
function mockWorkflows(initial: readonly WorkflowSummary[] = []): {
  readonly write: (
    workflows: readonly WorkflowSummary[],
    notify?: boolean,
  ) => void;
} {
  let workflows = initial;
  context.mocks.api(
    skillImportSessionsContract.listSkills,
    ({ params, respond }) => {
      const provider =
        params.sessionId === CODEX_SESSION_ID ? "codex" : "claudeCode";
      return respond(
        200,
        workflows.filter((entry) => {
          return entry.importSource === provider;
        }),
      );
    },
  );
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
    write: (next, notify = true) => {
      workflows = next;
      if (notify) {
        context.mocks.ably.trigger("skillImportChanged");
      }
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
      token: `vm0_skillimport_${body.provider}-session-token-${String(providers.length)}`,
      sessionId:
        body.provider === "codex" ? CODEX_SESSION_ID : CLAUDE_SESSION_ID,
      expiresAt: new Date(
        now() + SKILL_IMPORT_SESSION_TTL_SECONDS * 1000,
      ).toISOString(),
      limits: SKILL_IMPORT_LIMITS,
    });
  });
  return { providers };
}

async function openWorkflowsPage(messagePort = false): Promise<void> {
  await setupPage({
    context,
    path: "/workflows",
    sharedWorkerTestTransport: messagePort ? "message-port" : "direct",
  });
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

test("Import skills sits before Create in chat", async () => {
  mockWorkflows();
  mockSessions();

  await openWorkflowsPage();

  const importSkills = getButtonNamed("Import skills");
  const createInChat = getButtonNamed("Create in chat");
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

test("Browser-owned View workflows activations keep the dialog listening for imports", async () => {
  const workflows = mockWorkflows();
  mockSessions();
  // Happy DOM cannot choose native tabs/windows; keep its anchor default
  // isolated while observing the original dialog and arriving skills.
  context.mocks.browser.open();
  const user = userEvent.setup({ delay: null });
  await openWorkflowsPage();
  click(getButtonNamed("Import skills"));
  const dialog = await findDialog();
  await findCopyPrompt(dialog);
  const link = within(dialog).getByText("View workflows");
  expect(link).toHaveAttribute("href", "/workflows");

  for (const modifier of ["Control", "Meta", "Shift", "Alt"]) {
    await user.keyboard(`{${modifier}>}`);
    await user.click(link);
    await user.keyboard(`{/${modifier}}`);
    expect(screen.getByRole("dialog", { name: DIALOG_TITLE })).toBeVisible();
  }
  for (const keys of ["[MouseMiddle]", "[MouseRight]"]) {
    await user.pointer({ target: link, keys });
    expect(screen.getByRole("dialog", { name: DIALOG_TITLE })).toBeVisible();
  }

  workflows.write([
    workflow({
      id: "d0000000-0000-4000-a000-000000000431",
      name: "weekly-report",
      displayName: "Weekly report",
      importSource: "claudeCode",
    }),
  ]);
  await expect(
    within(dialog).findByText("Weekly report"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).getByRole("status")).toHaveTextContent(
    "1 imported · listening for more",
  );
});

test.each(["click", "Enter"])(
  "View workflows %s closes the import dialog and navigates in the current tab",
  async (activation) => {
    mockWorkflows();
    mockSessions();
    const user = userEvent.setup({ delay: null });
    await setupPage({ context, path: "/workflows?source=skill-import" });
    await screen.findByRole("heading", { name: "Workflows" });
    click(getButtonNamed("Import skills"));
    const dialog = await findDialog();
    await findCopyPrompt(dialog);
    const link = within(dialog).getByText("View workflows");

    if (activation === "Enter") {
      link.focus();
      await user.keyboard("{Enter}");
    } else {
      click(link);
    }

    await waitFor(() => {
      expect(pathname()).toBe("/workflows");
      expect(search()).toBe("");
      expect(screen.queryByRole("dialog", { name: DIALOG_TITLE })).toBeNull();
    });
  },
);

test("Reopening retains the prompt and resyncs the whole session including closed-window uploads", async () => {
  const workflows = mockWorkflows();
  mockSessions();
  await openWorkflowsPage();
  click(getButtonNamed("Import skills"));
  let dialog = await findDialog();
  const originalPrompt = (await showFullPrompt(dialog)).textContent;
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

  expect(context.mocks.ably.hasSubscription("skillImportChanged")).toBeFalsy();
  // The user's agent continues uploading with the already-copied prompt.
  workflows.write(
    [
      weeklyReport,
      workflow({
        id: "d0000000-0000-4000-a000-000000000412",
        name: "launch-checklist",
        displayName: "Launch checklist",
        importSource: "claudeCode",
      }),
    ],
    false,
  );
  click(getButtonNamed("Import skills"));
  dialog = await findDialog();
  await expect(
    within(dialog).findByText("Launch checklist"),
  ).resolves.toBeVisible();
  expect(within(dialog).getByText("Weekly report")).toBeInTheDocument();
  expect((await showFullPrompt(dialog)).textContent).toBe(originalPrompt);
});

test("Escape closes the import, releases realtime, and returns keyboard focus", async () => {
  mockWorkflows();
  mockSessions();
  const user = userEvent.setup({ delay: null });
  await openWorkflowsPage();
  const trigger = getButtonNamed("Import skills");
  trigger.focus();
  await user.keyboard("{Enter}");
  const dialog = await findDialog();
  await findCopyPrompt(dialog);
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscription("skillImportChanged"),
    ).toBeTruthy();
  });
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: DIALOG_TITLE })).toBeNull();
    expect(trigger).toHaveFocus();
  });
  expect(context.mocks.ably.hasSubscription("skillImportChanged")).toBeFalsy();
});
