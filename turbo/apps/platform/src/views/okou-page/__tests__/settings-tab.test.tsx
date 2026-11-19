import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  agentInstructionsContract,
  agentsByIdContract,
  type AgentMetadataRequest,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import {
  workflowsCollectionContract,
  workflowsDetailContract,
  type WorkflowSummary,
} from "@okouai/api-contracts/contracts/workflows";
import { DEFAULT_AGENT_AVATAR_URL } from "@okouai/core/agent-avatar";

import {
  click,
  setupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const AGENT_ID = "a0000000-0000-4000-a000-000000000020";
function renderedAvatarSvgLayerSrcs(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll<HTMLImageElement>("img"), (img) => {
    return img.src;
  }).filter((src) => {
    return src.includes("/platform/views/zero-page/assets/avatar-svg");
  });
}

function findCreateCustomAvatarButton(): Promise<HTMLElement> {
  return screen.findByLabelText("Create custom avatar");
}

async function findAvatarRow(): Promise<HTMLElement> {
  const avatarLabel = await screen.findByText("Avatar", { selector: "p" });
  const row = avatarLabel.parentElement?.parentElement;
  if (!row) {
    throw new Error("Avatar profile row not found");
  }
  return row;
}

// The agent header carries its own "Customize avatar" shortcut, so the profile
// entry point has to be looked up inside the avatar row.
async function findCustomizeAvatarButton(): Promise<HTMLElement> {
  return within(await findAvatarRow()).findByLabelText("Customize avatar");
}

function findAgentNameInput(): Promise<HTMLElement> {
  return screen.findByDisplayValue("Research Agent");
}

function tabByText(text: string): HTMLElement {
  const tab = queryAllByRoleFast("tab").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!tab) {
    throw new Error(`${text} tab not found`);
  }
  return tab;
}

function prepareAgentProfile(
  avatarUrl: string | null = "preset:0",
  ownerId = "test-user-123",
): {
  readonly lastUpdate: () => AgentMetadataRequest | null;
  readonly lastSavedProfile: () => AgentResponse | null;
} {
  let lastUpdate: AgentMetadataRequest | null = null;
  let lastSavedProfile: AgentResponse | null = null;
  let detail: AgentResponse = {
    agentId: AGENT_ID,
    isDefaultAgent: false,
    ownerId,
    description: "A helpful agent",
    displayName: "Research Agent",
    sound: "professional",
    avatarUrl,
    visibility: "public",
  };

  context.mocks.data.agents([
    {
      agentId: DEFAULT_AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Nova",
      description: null,
      sound: null,
      avatarUrl: null,
      visibility: "public",
    },
    {
      agentId: AGENT_ID,
      ownerId,
      displayName: detail.displayName,
      description: detail.description,
      sound: detail.sound,
      avatarUrl: detail.avatarUrl,
      visibility: "public",
    },
  ]);
  context.mocks.api(agentsByIdContract.get, ({ respond }) => {
    return respond(200, detail);
  });
  context.mocks.api(agentsByIdContract.updateMetadata, ({ body, respond }) => {
    lastUpdate = body;
    detail = { ...detail, ...body };
    lastSavedProfile = detail;
    return respond(200, detail);
  });
  context.mocks.api(agentInstructionsContract.get, ({ respond }) => {
    return respond(200, { content: null, filename: null });
  });
  return {
    lastUpdate: () => {
      return lastUpdate;
    },
    lastSavedProfile: () => {
      return lastSavedProfile;
    },
  };
}

test("Offer avatar creation instead of editing when the agent has no avatar", async () => {
  prepareAgentProfile(null);
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}?tab=profile`,
  });

  await findAgentNameInput();
  expect(
    within(await findAvatarRow()).queryByLabelText("Customize avatar"),
  ).not.toBeInTheDocument();

  click(await findCreateCustomAvatarButton());

  await expect(
    screen.findByRole("dialog", { name: "Give your agent a face" }),
  ).resolves.toBeVisible();
});

test("Keep every composer step and its edge options usable in one dialog", async () => {
  prepareAgentProfile(null);
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}?tab=profile`,
  });

  click(await findCreateCustomAvatarButton());

  const dialog = await screen.findByRole("dialog", {
    name: "Give your agent a face",
  });
  const steps = [
    { label: "Face", first: "Round", last: "Oval" },
    { label: "Hair", first: "High bun", last: "Ribbon updo" },
    { label: "Mood", first: "Neutral smile", last: "Stubble smile" },
    { label: "Skin", first: "Gold", last: "Brown" },
    { label: "Color", first: "Blue", last: "Brown" },
    { label: "Sweater", first: "Lime", last: "Orange" },
  ] as const;

  for (const [index, step] of steps.entries()) {
    expect(dialog).toBeVisible();
    expect(within(dialog).getByText(step.label)).toBeVisible();
    expect(within(dialog).getByLabelText(step.first)).toBeVisible();
    expect(within(dialog).getByLabelText(step.last)).toBeVisible();
    expect(within(dialog).getByText("Use this avatar")).toBeVisible();
    if (index + 1 < steps.length) {
      click(within(dialog).getByLabelText("Next step"));
    }
  }
});

async function openNewComposerAvatar(): Promise<HTMLElement> {
  prepareAgentProfile(null);
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}?tab=profile`,
  });

  click(await findCreateCustomAvatarButton());

  const dialog = await screen.findByRole("dialog", {
    name: "Give your agent a face",
  });
  expect(within(dialog).getByText("Face")).toBeVisible();
  return dialog;
}

test("Create, save, and reopen a composed avatar from the profile page", async () => {
  const dialog = await openNewComposerAvatar();
  click(within(dialog).getByLabelText("Oval"));
  expect(within(dialog).getByLabelText("Oval")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  for (const step of ["Hair", "Mood", "Skin", "Color"]) {
    click(within(dialog).getByLabelText("Next step"));
    await expect(within(dialog).findByText(step)).resolves.toBeVisible();
  }
  click(within(dialog).getByLabelText("Green"));
  click(within(dialog).getByLabelText("Blue"));
  expect(within(dialog).getByText("Color")).toBeVisible();
  expect(within(dialog).getByLabelText("Blue")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  click(within(dialog).getByLabelText("Next step"));
  await expect(within(dialog).findByText("Sweater")).resolves.toBeVisible();
  click(within(dialog).getByLabelText("Pink"));
  click(within(dialog).getByLabelText("Previous step"));
  expect(within(dialog).getByLabelText("Blue")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  click(within(dialog).getByLabelText("Next step"));
  expect(within(dialog).getByLabelText("Pink")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  click(within(dialog).getByText("Use this avatar"));

  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
    expect(screen.getByText("Profile saved")).toBeInTheDocument();
  });

  const savedLayerSrcs = renderedAvatarSvgLayerSrcs(await findAvatarRow());
  expect(savedLayerSrcs).toStrictEqual([
    expect.stringMatching(/\/avatar-svg-v2\/.*\/neck\//u),
    expect.stringMatching(/\/avatar-svg-v2\/.*\/hairs\/.*-blue-rear\.svg$/u),
    expect.stringMatching(/\/avatar-svg-v2\/.*\/faces\/oval-/u),
    expect.stringMatching(/\/avatar-svg-v2\/.*\/hairs\/.*-blue-front\.svg$/u),
    expect.stringMatching(/\/avatar-svg-v2\/.*\/expressions\//u),
    expect.stringMatching(/\/avatar-svg-v2\/.*\/sweater\/pink\.svg$/u),
  ]);

  // Reopening the maker must reload the saved avatar, not roll a new one.
  click(await findCustomizeAvatarButton());

  const editDialog = await screen.findByRole("dialog", { name: "Edit avatar" });
  expect(
    renderedAvatarSvgLayerSrcs(editDialog).slice(0, savedLayerSrcs.length),
  ).toStrictEqual(savedLayerSrcs);
});

function prepareDefaultAgentProfile(): void {
  let defaultAgent: AgentResponse = {
    agentId: DEFAULT_AGENT_ID,
    isDefaultAgent: true,
    ownerId: "test-user-123",
    description: "The default assistant",
    displayName: "Okou",
    sound: "professional",
    avatarUrl: DEFAULT_AGENT_AVATAR_URL,
    visibility: "public",
  };
  context.mocks.data.agents([defaultAgent]);
  context.mocks.api(agentsByIdContract.get, ({ respond }) => {
    return respond(200, defaultAgent);
  });
  context.mocks.api(agentsByIdContract.updateMetadata, ({ body, respond }) => {
    defaultAgent = { ...defaultAgent, ...body };
    return respond(200, defaultAgent);
  });
  let content = "Original team instructions";
  context.mocks.api(agentInstructionsContract.get, ({ respond }) => {
    return respond(200, { content, filename: "AGENTS.md" });
  });
  context.mocks.api(agentInstructionsContract.update, ({ body, respond }) => {
    content = body.content;
    return respond(200, defaultAgent);
  });
  context.mocks.data.onboardingStatus({ defaultAgentId: DEFAULT_AGENT_ID });
}

test("Edit and reopen default Okou instructions through the deep link", async () => {
  prepareDefaultAgentProfile();
  await setupPage({
    context,
    path: `/agents/${DEFAULT_AGENT_ID}?tab=instructions`,
  });

  const editor = await screen.findByLabelText("Instructions editor");
  expect(tabByText("Instructions")).toHaveAttribute("aria-selected", "true");
  await fill(editor, "Updated shared instructions");
  click(await screen.findByText("Save"));
  await expect(
    screen.findByText("Instructions saved"),
  ).resolves.toBeInTheDocument();

  click(tabByText("Profile"));
  await screen.findByLabelText("Name");
  click(tabByText("Instructions"));
  const savedEditor = await screen.findByLabelText("Instructions editor");
  expect(savedEditor).toHaveTextContent("Updated shared instructions");
});

test("Edit and save an agent profile", async () => {
  const profile = prepareAgentProfile();

  await setupPage({ context, path: `/agents/${AGENT_ID}?tab=profile` });

  const nameInput = await findAgentNameInput();
  await fill(nameInput, "Research Lead");
  await fill(
    screen.getByLabelText("Description"),
    "Helps with release research",
  );
  click(screen.getByText("Friendly"));
  click(screen.getByLabelText("Make public"));

  await waitFor(() => {
    expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
    expect(screen.getByText("Warm and approachable")).toBeInTheDocument();
    expect(screen.getByLabelText("Make public")).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  click(screen.getByText("Save"));

  // Demoting the agent from public to private now requires confirmation.
  await waitFor(() => {
    expect(
      screen.getByText("Make Research Agent private?"),
    ).toBeInTheDocument();
  });
  click(screen.getByText("Make private"));

  await waitFor(() => {
    expect(profile.lastSavedProfile()).toMatchObject({
      displayName: "Research Lead",
      description: "Helps with release research",
      sound: "friendly",
      visibility: "private",
    });
    expect(
      screen.queryByText("You have unsaved changes"),
    ).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("Research Lead")).toBeInTheDocument();
    expect(
      screen.getByDisplayValue("Helps with release research"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Make public")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByText("Warm and approachable")).toBeInTheDocument();
  });

  click(tabByText("Instructions"));
  await waitFor(() => {
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });
  click(tabByText("Profile"));
  await expect(
    screen.findByDisplayValue("Research Lead"),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByDisplayValue("Helps with release research"),
  ).toBeInTheDocument();
  expect(screen.getByText("Warm and approachable")).toBeInTheDocument();
  expect(screen.getByLabelText("Make public")).toHaveAttribute(
    "aria-checked",
    "false",
  );
});

test("Discard unsaved agent profile edits", async () => {
  const profile = prepareAgentProfile();

  await setupPage({ context, path: `/agents/${AGENT_ID}?tab=profile` });

  const nameInput = await findAgentNameInput();
  await fill(nameInput, "Research Lead");
  await fill(
    screen.getByLabelText("Description"),
    "Helps with release research",
  );
  click(screen.getByText("Friendly"));
  click(screen.getByLabelText("Make public"));

  await waitFor(() => {
    expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
    expect(screen.getByText("Warm and approachable")).toBeInTheDocument();
    expect(screen.getByLabelText("Make public")).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  click(screen.getByText("Discard"));

  await waitFor(() => {
    expect(
      screen.queryByText("You have unsaved changes"),
    ).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("Research Agent")).toBeInTheDocument();
    expect(screen.getByDisplayValue("A helpful agent")).toBeInTheDocument();
    expect(screen.getByText("Clear and polished")).toBeInTheDocument();
    expect(screen.getByLabelText("Make public")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(profile.lastSavedProfile()).toBeNull();
  });
});

test("Explain the impact before deleting an agent", async () => {
  const profile = prepareAgentProfile();

  await setupPage({ context, path: `/agents/${AGENT_ID}?tab=profile` });

  await findAgentNameInput();

  click(screen.getByText("Delete agent"));

  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Deletes the agent, its workflows, automations, and everyone.s chat history/u,
      ),
    ).toBeInTheDocument();
  });

  click(screen.getByText("Cancel"));

  await waitFor(() => {
    expect(
      screen.queryByText(
        /Deletes the agent, its workflows, automations, and everyone.s chat history/u,
      ),
    ).not.toBeInTheDocument();
  });
  expect(screen.getByDisplayValue("Research Agent")).toBeInTheDocument();
  expect(profile.lastSavedProfile()).toBeNull();
});

function prepareDeleteWorkflow(): WorkflowSummary {
  const workflow: WorkflowSummary = {
    id: "d0000000-0000-4000-a000-000000000201",
    agentId: AGENT_ID,
    agentName: "research-agent",
    agentDisplayName: "Research Agent",
    name: "daily-research",
    displayName: "Daily research",
    description: null,
    visibility: "private",
    ownerUserId: "test-user-123",
    createdAt: "2026-09-10T00:00:00.000Z",
    canManage: true,
    canPublish: true,
    importSource: null,
    official: null,
  };
  context.mocks.api(workflowsCollectionContract.list, ({ respond }) => {
    return respond(200, [workflow]);
  });
  return workflow;
}

function linkTo(path: string): HTMLElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.getAttribute("href") === path;
  });
  if (!link) {
    throw new Error(`Link to ${path} not found`);
  }
  return link;
}

async function chooseBothWorkflowCopies(dialog: HTMLElement) {
  for (const title of ["Daily research", "Weekly research"]) {
    const selects = queryAllByRoleFast("combobox", dialog).filter((select) => {
      return select.getAttribute("aria-label") === `Handle workflow ${title}`;
    });
    const [select] = selects;
    if (selects.length !== 1 || !select) {
      throw new Error(`Expected one workflow destination for ${title}`);
    }
    click(select);
    const option = await waitFor(() => {
      const options = queryAllByRoleFast("option").filter((option) => {
        return option.textContent?.trim() === "Copy to Nova";
      });
      const [option] = options;
      if (options.length !== 1 || !option) {
        throw new Error("Expected one Copy to Nova option");
      }
      return option;
    });
    click(option);
  }
}

async function prepareWorkflowCopyDeletion(failSecondCopy: boolean) {
  prepareAgentProfile();
  const first = prepareDeleteWorkflow();
  const second: WorkflowSummary = {
    ...first,
    id: "d0000000-0000-4000-a000-000000000203",
    name: "weekly-research",
    displayName: "Weekly research",
  };
  let workflows = [first, second];
  context.mocks.api(workflowsCollectionContract.list, ({ query, respond }) => {
    return respond(
      200,
      workflows.filter((workflow) => {
        return !query.agentId || workflow.agentId === query.agentId;
      }),
    );
  });
  context.mocks.api(
    workflowsDetailContract.copy,
    ({ params, body, respond }) => {
      if (params.workflowId === second.id && failSecondCopy) {
        return respond(403, {
          error: { code: "FORBIDDEN", message: "Second copy failed" },
        });
      }
      const source = params.workflowId === first.id ? first : second;
      if (
        workflows.some((workflow) => {
          return (
            workflow.agentId === body.toAgentId && workflow.name === source.name
          );
        })
      ) {
        return respond(409, {
          error: {
            code: "CONFLICT",
            message: "A workflow with this name already exists",
          },
        });
      }
      const copied: WorkflowSummary = {
        ...source,
        id: crypto.randomUUID(),
        agentId: body.toAgentId,
        agentName: "nova",
        agentDisplayName: "Nova",
      };
      workflows.push(copied);
      return respond(201, copied);
    },
  );
  context.mocks.api(agentsByIdContract.delete, ({ params, respond }) => {
    workflows = workflows.filter((workflow) => {
      return workflow.agentId !== params.id;
    });
    return respond(204);
  });

  await setupPage({ context, path: `/agents/${AGENT_ID}?tab=profile` });
  await findAgentNameInput();
  click(screen.getByText("Delete agent"));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText("Weekly research");
  await chooseBothWorkflowCopies(dialog);
  return dialog;
}

test("Copy selected workflows before deleting their source agent", async () => {
  const dialog = await prepareWorkflowCopyDeletion(false);
  click(within(dialog).getByText("Delete agent"));
  await screen.findByText("Agent deleted");
  click(linkTo("/workflows"));
  await screen.findByText("Weekly research");
  expect(screen.getAllByText("Daily research")).toHaveLength(1);
  expect(screen.getAllByText("Weekly research")).toHaveLength(1);
});

test("Keep the source agent when its workflow refresh fails after copying", async () => {
  prepareAgentProfile();
  const workflow = prepareDeleteWorkflow();
  let copySucceeded = false;
  context.mocks.api(workflowsCollectionContract.list, ({ respond }) => {
    return copySucceeded
      ? respond(403, {
          error: { code: "FORBIDDEN", message: "Refresh failed" },
        })
      : respond(200, [workflow]);
  });
  context.mocks.api(workflowsDetailContract.copy, ({ respond }) => {
    copySucceeded = true;
    return respond(201, {
      ...workflow,
      id: "d0000000-0000-4000-a000-000000000202",
      agentId: DEFAULT_AGENT_ID,
    });
  });
  context.mocks.api(agentsByIdContract.delete, ({ respond }) => {
    return respond(204);
  });

  await setupPage({ context, path: `/agents/${AGENT_ID}?tab=profile` });
  await findAgentNameInput();
  click(screen.getByText("Delete agent"));
  const dialog = await screen.findByRole("dialog");
  click(await within(dialog).findByRole("combobox"));
  click(await screen.findByRole("option", { name: "Copy to Nova" }));
  click(within(dialog).getByText("Delete agent"));

  await expect(within(dialog).findByRole("alert")).resolves.toHaveTextContent(
    "Could not load workflows.",
  );
  await waitFor(() => {
    expect(within(dialog).getByText("Delete agent")).toBeDisabled();
  });
  expect(within(dialog).getByRole("combobox")).toHaveTextContent(
    "Copy to Nova",
  );
  expect(within(dialog).getByRole("combobox")).toBeDisabled();
  click(within(dialog).getByText("Cancel"));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  const nameInput = await findAgentNameInput();
  expect(nameInput).toBeInTheDocument();
  click(screen.getByText("Delete agent"));
  const reopened = await screen.findByRole("dialog");
  expect(within(reopened).getByText("Delete agent")).toBeDisabled();
  expect(within(reopened).getByText("Cancel")).toBeEnabled();
  expect(within(reopened).getByRole("combobox")).toHaveTextContent(
    "Delete with agent",
  );
});
