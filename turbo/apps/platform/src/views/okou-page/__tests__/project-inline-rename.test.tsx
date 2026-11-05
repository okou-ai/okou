import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import type { ProjectEvent } from "@okouai/api-contracts/validators/projects";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";

const context = testContext();
const projectId = "30000000-0000-4000-8000-000000000071";
const otherProjectId = "30000000-0000-4000-8000-000000000072";
const at = "2026-11-02T00:00:00.000Z";

// A Project's own row holds its trigger, actions and rename field.
function projectRow(id = projectId) {
  const element = document.querySelector<HTMLElement>(
    `[data-project-row-id="${id}"]`,
  );
  if (!element) {
    throw new Error("Project not found");
  }
  return element;
}

// The Project's name links to its page; the folder icon folds its chats.
function projectName(name: string, id = projectId) {
  const element = queryAllByRoleFast("link", projectRow(id)).find((link) => {
    return link.textContent?.trim() === name;
  });
  if (!element) {
    throw new Error(`Project link ${name} not found`);
  }
  return element;
}

function projectToggle(name: string, id = projectId) {
  const element = queryAllByRoleFast("button", projectRow(id)).find(
    (button) => {
      return (
        button.getAttribute("aria-label") === `Show or hide chats in ${name}`
      );
    },
  );
  if (!element) {
    throw new Error(`Project toggle ${name} not found`);
  }
  return element;
}

async function setupProjects({
  confirmedName,
}: { confirmedName?: string } = {}) {
  const current = {
    ...continuityThread(171, 1, "Launch planning"),
    projectId,
  };
  const other = continuityThread(171, 2, "Other conversation");
  const workspace = installContinuityWorkspace(context, {
    caseId: 171,
    threads: [current, other],
  });
  // A double-click first opens the Project page, which lists the default
  // Agent's chats.
  context.mocks.data.onboardingStatus({ defaultAgentId: current.agentId });
  const projects = [
    { id: projectId, name: "Launch", createdAt: at, updatedAt: at },
    { id: otherProjectId, name: "Research", createdAt: at, updatedAt: at },
  ];
  const events: ProjectEvent[] = [];
  context.mocks.api(projectsContract.snapshot, ({ respond }) => {
    return respond(200, {
      projects,
      latestEventId: null,
      latestSeqId: 1,
    });
  });
  context.mocks.api(projectsContract.events, ({ query, respond }) => {
    return respond(200, {
      events: events.filter((event) => {
        return event.seqId > query.sinceSeqId;
      }),
      hasMore: false,
    });
  });
  context.mocks.api(projectsContract.update, ({ params, body, respond }) => {
    events.push({
      id: body.eventId,
      seqId: events.length + 2,
      projectId: params.id,
      kind: "renamed",
      name: body.name,
      createdAt: at,
    });
    if (confirmedName) {
      events.push({
        id: crypto.randomUUID(),
        seqId: events.length + 2,
        projectId: params.id,
        kind: "renamed",
        name: confirmedName,
        createdAt: at,
      });
    }
    return respond(200, {
      id: params.id,
      name: body.name,
      createdAt: at,
      updatedAt: at,
    });
  });
  await setupPage({
    context,
    path: `/chats/${current.id}`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  expect(projectName("Launch")).toBeInTheDocument();
  return { current, other };
}

function findNameField() {
  return within(projectRow()).findByRole("textbox", { name: "Project name" });
}

test("Double-click a Project to select its name and save it in place with Enter", async () => {
  const user = userEvent.setup();
  await setupProjects();
  expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "true");

  await user.dblClick(projectName("Launch"));

  const input = await findNameField();
  expect(input).toHaveValue("Launch");
  expect(input).toHaveFocus();
  await user.keyboard("  Launch plan  {Enter}");

  await waitFor(() => {
    expect(projectName("Launch plan")).toHaveFocus();
  });
  expect(projectToggle("Launch plan")).toHaveAttribute("aria-expanded", "true");
  expect(
    document.querySelector(
      `[data-project-row-id="${projectId}"] [data-sidebar-chat-thread-id]`,
    ),
  ).toHaveTextContent("Launch planning");
  expect(within(projectRow()).queryByRole("textbox")).not.toBeInTheDocument();

  // The folder still folds the Project after focus returns from the editor.
  click(projectToggle("Launch plan"));
  expect(projectToggle("Launch plan")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

test("Leaving a Project's name to open another conversation still saves it", async () => {
  const user = userEvent.setup();
  const { other } = await setupProjects({ confirmedName: "Launch confirmed" });
  await user.dblClick(projectName("Launch"));
  await findNameField();
  await user.keyboard("Launch revised");

  const tokenRequested = context.mocks.deferred<void>();
  const releaseToken = context.mocks.deferred<void>();
  mockedClerk.sessionGetToken.mockImplementationOnce(async () => {
    tokenRequested.resolve();
    await releaseToken.promise;
    return "project-inline-rename-token";
  });
  const otherLink = document.querySelector<HTMLAnchorElement>(
    `[data-sidebar-chat-thread-id="${other.id}"]`,
  );
  if (!otherLink) {
    throw new Error("Other conversation not found");
  }
  await user.click(otherLink);
  await tokenRequested.promise;
  await waitFor(() => {
    expect(location.pathname).toBe(`/chats/${other.id}`);
  });
  releaseToken.resolve();

  await waitFor(() => {
    expect(projectName("Launch confirmed")).toBeInTheDocument();
  });
  expect(within(projectRow()).queryByRole("textbox")).not.toBeInTheDocument();
});

test("Hiding the chat list from the name field saves it without reopening the editor", async () => {
  const user = userEvent.setup();
  context.mocks.browser.userAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  );
  await setupProjects({ confirmedName: "Hidden launch confirmed" });
  await user.dblClick(projectName("Launch"));
  await findNameField();
  await user.keyboard("Hidden launch{Meta>}b{/Meta}");

  await waitFor(() => {
    expect(screen.queryByTestId("chat-list-column")).not.toBeInTheDocument();
  });
  click(await screen.findByLabelText("Show chat list"));

  await waitFor(() => {
    expect(projectName("Hidden launch confirmed")).toBeInTheDocument();
  });
  expect(within(projectRow()).queryByRole("textbox")).not.toBeInTheDocument();
});

test("Escape and an empty Project name retain its previous name and return focus", async () => {
  const user = userEvent.setup();
  await setupProjects();
  await user.dblClick(projectName("Launch"));
  await findNameField();
  await user.keyboard("Discarded{Escape}");

  await waitFor(() => {
    expect(projectName("Launch")).toHaveFocus();
  });
  await user.dblClick(projectName("Launch"));
  await findNameField();
  await user.keyboard("   {Enter}");

  await waitFor(() => {
    expect(projectName("Launch")).toHaveFocus();
  });
  expect(within(projectRow()).queryByRole("textbox")).not.toBeInTheDocument();
});

test("Project names keep Enter and Escape with the input method while composing", async () => {
  const user = userEvent.setup();
  await setupProjects();
  await user.dblClick(projectName("Launch"));
  const input = await findNameField();

  expect(fireEvent.keyDown(input, { key: "Enter", keyCode: 229 })).toBeFalsy();
  fireEvent.keyDown(input, { key: "Escape", isComposing: true });
  expect(input).toHaveFocus();

  await user.keyboard("发布计划{Enter}");
  await waitFor(() => {
    expect(projectName("发布计划")).toHaveFocus();
  });
});

test("Renaming another Project saves the previous edit without changing its target", async () => {
  const user = userEvent.setup();
  await setupProjects();
  await user.dblClick(projectName("Launch"));
  await findNameField();
  await user.keyboard("Launch plan");

  await user.dblClick(projectName("Research", otherProjectId));
  const input = await within(projectRow(otherProjectId)).findByRole("textbox", {
    name: "Project name",
  });
  expect(input).toHaveValue("Research");
  expect(input).toHaveFocus();
  await user.keyboard("Research plan{Enter}");

  await waitFor(() => {
    expect(projectName("Research plan", otherProjectId)).toHaveFocus();
    expect(projectName("Launch plan")).toBeInTheDocument();
  });
});

test("Modified double-clicks retain Project activation without starting a rename", async () => {
  const user = userEvent.setup();
  await setupProjects();

  for (const modifier of ["Alt", "Control", "Meta", "Shift"]) {
    await user.keyboard(`{${modifier}>}`);
    await user.dblClick(projectName("Launch"));
    await user.keyboard(`{/${modifier}}`);
    expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "true");
    expect(within(projectRow()).queryByRole("textbox")).not.toBeInTheDocument();
  }

  await user.dblClick(projectName("Launch"));
  await expect(findNameField()).resolves.toHaveValue("Launch");
});
