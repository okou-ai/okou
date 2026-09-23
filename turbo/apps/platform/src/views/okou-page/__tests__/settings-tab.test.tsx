import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { updateAgentSettings$ } from "../../../signals/okou-page/job-detail/settings.ts";
import { deleteAgent$ } from "../../../signals/okou-page/job-detail/delete.ts";

import {
  agentInstructionsContract,
  agentsMainContract,
  agentsByIdContract,
  type AgentMetadataRequest,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import {
  workflowsCollectionContract,
  workflowsDetailContract,
  type WorkflowSummary,
} from "@okouai/api-contracts/contracts/workflows";
import {
  AVATAR_PRESET_COUNT,
  DEFAULT_AGENT_AVATAR_URL,
} from "@okouai/core/agent-avatar";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

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

function isNeckOrSweaterLayer(src: string): boolean {
  return src.includes("/neck/") || src.includes("/sweater/");
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
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
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

test("Keep rendering the highest legacy avatar preset", async () => {
  prepareAgentProfile(`preset:${AVATAR_PRESET_COUNT - 1}`);
  await setupPage({ context, path: `/agents/${AGENT_ID}?tab=profile` });

  await findAgentNameInput();

  expect(renderedAvatarSvgLayerSrcs(await findAvatarRow())).toStrictEqual([
    expect.stringContaining("/head-r5-s4.svg"),
    expect.stringContaining("/face-r5-f5-m.svg"),
    expect.stringContaining("/hair-r5-h2-c2.svg"),
  ]);
});

test("Keep rendering a legacy custom SVG avatar", async () => {
  prepareAgentProfile("svg:r3s2h4c1f5h");
  await setupPage({ context, path: `/agents/${AGENT_ID}?tab=profile` });

  await findAgentNameInput();

  expect(renderedAvatarSvgLayerSrcs(await findAvatarRow())).toStrictEqual([
    expect.stringContaining("/head-r3-s2.svg"),
    expect.stringContaining("/face-r3-f5-h.svg"),
    expect.stringContaining("/hair-r3-h4-c1.svg"),
  ]);
});

async function prepareLegacyAvatarPreview(avatarUrl: string) {
  const profile = prepareAgentProfile(avatarUrl);
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}?tab=profile`,
  });
  const legacyLayerSrcs = renderedAvatarSvgLayerSrcs(await findAvatarRow());
  expect(legacyLayerSrcs).toHaveLength(3);
  click(await findCustomizeAvatarButton());
  const dialog = await screen.findByRole("dialog", { name: "Edit avatar" });
  expect(within(dialog).getByText("Face")).toBeVisible();
  expect(profile.lastSavedProfile()).toBeNull();
  return { profile, legacyLayerSrcs, dialog };
}

test.each(["svg:r3s2h4c1f5h"])(
  "Cancel avatar composition without converting legacy avatar %s",
  async (avatarUrl) => {
    const { profile, legacyLayerSrcs, dialog } =
      await prepareLegacyAvatarPreview(avatarUrl);
    click(within(dialog).getByText("Cancel"));
    await waitFor(() => {
      expect(dialog).not.toBeInTheDocument();
    });
    expect(renderedAvatarSvgLayerSrcs(await findAvatarRow())).toStrictEqual(
      legacyLayerSrcs,
    );
    expect(profile.lastSavedProfile()).toBeNull();
    await fill(await findAgentNameInput(), "Research Lead");
    click(screen.getByText("Save"));
    await waitFor(() => {
      expect(screen.getByText("Profile saved")).toBeInTheDocument();
      expect(profile.lastSavedProfile()).toMatchObject({
        displayName: "Research Lead",
        avatarUrl,
      });
    });
  },
);

test.each(["svg:r3s2h4c1f5h"])(
  "Confirm conversion of legacy avatar %s to a composed avatar",
  async (avatarUrl) => {
    const { profile, dialog } = await prepareLegacyAvatarPreview(avatarUrl);
    expect(renderedAvatarSvgLayerSrcs(dialog).slice(0, 6)).toStrictEqual([
      expect.stringContaining("/avatar-svg-v2/"),
      expect.stringContaining("/avatar-svg-v2/"),
      expect.stringContaining("/avatar-svg-v2/"),
      expect.stringContaining("/avatar-svg-v2/"),
      expect.stringContaining("/avatar-svg-v2/"),
      expect.stringContaining("/avatar-svg-v2/"),
    ]);
    click(within(dialog).getByLabelText("Randomize avatar"));
    const composerLayerSrcs = renderedAvatarSvgLayerSrcs(dialog).slice(0, 6);
    expect(composerLayerSrcs).toStrictEqual([
      expect.stringContaining("/avatar-svg-v2/"),
      expect.stringContaining("/avatar-svg-v2/"),
      expect.stringContaining("/avatar-svg-v2/"),
      expect.stringContaining("/avatar-svg-v2/"),
      expect.stringContaining("/avatar-svg-v2/"),
      expect.stringContaining("/avatar-svg-v2/"),
    ]);
    click(within(dialog).getByText("Use this avatar"));
    await waitFor(() => {
      expect(dialog).not.toBeInTheDocument();
    });
    expect(profile.lastSavedProfile()?.avatarUrl).toContain("/avatar-svg-v2/");
    expect(renderedAvatarSvgLayerSrcs(await findAvatarRow())).toStrictEqual(
      composerLayerSrcs,
    );
  },
);

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

test("Load only the four head layers when neck and sweater are disabled", async () => {
  prepareAgentProfile(null);
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}?tab=profile`,
    featureSwitches: {
      [FeatureSwitchKey.AvatarNeckSweater]: false,
    },
  });

  click(await findCreateCustomAvatarButton());

  const dialog = await screen.findByRole("dialog", {
    name: "Give your agent a face",
  });
  const layerSrcs = renderedAvatarSvgLayerSrcs(dialog);

  // Four head layers across the preview and the six face options.
  expect(layerSrcs).toHaveLength(28);
  expect(new Set(layerSrcs).size).toBe(24);
  expect(layerSrcs.filter(isNeckOrSweaterLayer)).toStrictEqual([]);
});

test("Load the released neck and sweater layers by default", async () => {
  prepareAgentProfile(null);
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}?tab=profile`,
  });

  click(await findCreateCustomAvatarButton());

  const dialog = await screen.findByRole("dialog", {
    name: "Give your agent a face",
  });
  const layerSrcs = renderedAvatarSvgLayerSrcs(dialog);

  // Two more layers per avatar, but the shared neck and sweater are one
  // request each no matter how many avatars wear them.
  expect(layerSrcs).toHaveLength(42);
  expect(new Set(layerSrcs).size).toBe(26);
  expect(new Set(layerSrcs.filter(isNeckOrSweaterLayer)).size).toBe(2);
});

test("Keep every composer step and its edge options usable in one dialog", async () => {
  prepareAgentProfile(null);
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}?tab=profile`,
    featureSwitches: {
      [FeatureSwitchKey.AvatarNeckSweater]: true,
    },
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
    featureSwitches: {
      [FeatureSwitchKey.AvatarNeckSweater]: true,
    },
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

test("Allow an org admin to update another user's public agent avatar", async () => {
  const profile = prepareAgentProfile("preset:0", "agent-owner");
  context.mocks.data.org({
    id: "org_default",
    name: "Default Org",
    role: "admin",
  });
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}?tab=profile`,
  });

  click(await findCustomizeAvatarButton());

  const dialog = await screen.findByRole("dialog", { name: "Edit avatar" });
  click(within(dialog).getByLabelText("Randomize avatar"));
  click(within(dialog).getByText("Use this avatar"));

  await waitFor(() => {
    expect(profile.lastSavedProfile()).not.toBeNull();
  });
  const savedProfile = profile.lastSavedProfile();
  if (!savedProfile) {
    throw new Error("Expected the avatar update to finish");
  }
  const update = profile.lastUpdate();
  if (!update) {
    throw new Error("Expected an avatar update request");
  }
  expect(savedProfile.avatarUrl).not.toBe("preset:0");
  expect(savedProfile.visibility).toBe("public");
  expect(update).not.toHaveProperty("visibility");
});

test("Keep the default agent’s canonical identity read-only", async () => {
  const defaultAgent: AgentResponse = {
    agentId: DEFAULT_AGENT_ID,
    isDefaultAgent: true,
    ownerId: "test-user-123",
    description: "The default assistant",
    displayName: "Okou",
    sound: "professional",
    avatarUrl: DEFAULT_AGENT_AVATAR_URL,
    visibility: "public",
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
  };
  let saved: AgentMetadataRequest | undefined;
  context.mocks.api(agentsByIdContract.updateMetadata, ({ body, respond }) => {
    saved = body;
    return respond(200, { ...defaultAgent, ...body });
  });
  context.mocks.data.agents([defaultAgent]);
  context.mocks.api(agentsByIdContract.get, ({ respond }) => {
    return respond(200, defaultAgent);
  });
  context.mocks.api(agentInstructionsContract.get, ({ respond }) => {
    return respond(200, { content: null, filename: null });
  });
  context.mocks.data.onboardingStatus({ defaultAgentId: DEFAULT_AGENT_ID });

  await setupPage({
    context,
    path: `/agents/${DEFAULT_AGENT_ID}?tab=profile`,
  });

  const avatarLabel = await screen.findByText("Avatar", { selector: "p" });
  const avatarRow = avatarLabel.parentElement?.parentElement;
  if (!avatarRow) {
    throw new Error("Avatar profile row not found");
  }
  expect(within(avatarRow).getByRole("img", { name: "Okou" })).toHaveAttribute(
    "src",
    DEFAULT_AGENT_AVATAR_URL,
  );
  expect(screen.queryByLabelText("Customize avatar")).not.toBeInTheDocument();
  expect(
    within(avatarRow).queryByLabelText("Create custom avatar"),
  ).not.toBeInTheDocument();

  const nameLabel = screen.getByText("Name", { selector: "p" });
  const nameRow = nameLabel.parentElement?.parentElement;
  if (!nameRow) {
    throw new Error("Name profile row not found");
  }
  expect(within(nameRow).getByText("Okou")).toBeVisible();
  expect(within(nameRow).queryByLabelText("Name")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("switch", { name: "Make public" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("Public", { selector: "p" })).toBeVisible();
  expect(screen.queryByText("Delete agent")).not.toBeInTheDocument();
  await fill(
    screen.getByDisplayValue("The default assistant"),
    "Workspace helper",
  );
  click(screen.getByText("Save"));
  await waitFor(() => {
    return expect(saved).toMatchObject({ description: "Workspace helper" });
  });
  expect(saved).not.toHaveProperty("displayName");
  expect(saved).not.toHaveProperty("avatarUrl");
  expect(saved).not.toHaveProperty("visibility");
});

test.each([true])(
  "Reject queued protected actions for default identity %s",
  async (identity) => {
    const agent: AgentResponse = {
      agentId: AGENT_ID,
      isDefaultAgent: identity,
      ownerId: "test-user-123",
      displayName: "Okou",
      description: "Workspace helper",
      sound: "professional",
      avatarUrl: DEFAULT_AGENT_AVATAR_URL,
      visibility: "public",
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
    };
    // The optional identity models a previous API during the rollout window.
    context.mocks.api(agentsByIdContract.get, ({ respond }) => {
      return respond(200, agent);
    });
    context.mocks.api(agentsByIdContract.updateMetadata, ({ respond }) => {
      return respond(400, {
        error: { code: "UNEXPECTED_WRITE", message: "Unexpected write" },
      });
    });
    context.mocks.api(agentsByIdContract.delete, ({ respond }) => {
      return respond(204);
    });
    await setupPage({ context, path: `/agents/${AGENT_ID}?tab=profile` });
    await screen.findByText("Avatar", { selector: "p" });
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Customize avatar")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: "Make public" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Delete agent")).not.toBeInTheDocument();
    // Locked controls cannot produce these inputs through the current page.
    // Exercise the queued-command boundary explicitly for stale editor submissions.
    for (const update of [
      { displayName: "Renamed" },
      { avatarUrl: "preset:2" },
      { visibility: "private" as const },
    ]) {
      await expect(
        context.store.set(
          updateAgentSettings$,
          { ...update, description: "Must not be saved" },
          context.signal,
        ),
      ).rejects.toThrow("workspace default");
    }
    await expect(
      context.store.set(deleteAgent$, context.signal),
    ).rejects.toThrow("cannot be deleted");
  },
);

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

function copyTarget(
  agentId: string,
  displayName: string,
  ownerId = "test-user-123",
): AgentResponse {
  return {
    agentId,
    isDefaultAgent: agentId === DEFAULT_AGENT_ID,
    displayName,
    ownerId,
    description: null,
    sound: null,
    avatarUrl: null,
    visibility: "public",
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
  };
}

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
    official: null,
  };
  context.mocks.api(workflowsCollectionContract.list, ({ respond }) => {
    return respond(200, [workflow]);
  });
  return workflow;
}

test("Refresh only owned workflow copy targets whenever the delete dropdown opens", async () => {
  prepareAgentProfile();
  prepareDeleteWorkflow();
  const source = copyTarget(AGENT_ID, "Research Agent");
  const shared = copyTarget(DEFAULT_AGENT_ID, "Shared Agent", "another-user");
  const firstTarget = copyTarget(
    "a0000000-0000-4000-a000-000000000021",
    "New Personal Agent",
  );
  const secondTarget = copyTarget(
    "a0000000-0000-4000-a000-000000000022",
    "Latest Personal Agent",
  );
  let availableAgents = [source, shared];
  context.mocks.api(agentsMainContract.list, ({ respond }) => {
    return respond(200, availableAgents);
  });

  await setupPage({ context, path: `/agents/${AGENT_ID}?tab=profile` });
  await findAgentNameInput();
  click(screen.getByText("Delete agent"));
  const dialog = await screen.findByRole("dialog");
  const select = await within(dialog).findByRole("combobox");

  availableAgents = [source, shared, firstTarget];
  click(select);
  const firstOption = await screen.findByRole("option", {
    name: "Copy to New Personal Agent",
  });
  expect(
    screen.queryByRole("option", { name: "Copy to Shared Agent" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("option", { name: "Copy to Research Agent" }),
  ).not.toBeInTheDocument();
  click(firstOption);
  expect(select).toHaveTextContent("Copy to New Personal Agent");

  availableAgents = [source, shared, secondTarget];
  click(select);
  const secondOption = await screen.findByRole("option", {
    name: "Copy to Latest Personal Agent",
  });
  expect(
    screen.queryByRole("option", { name: "Copy to New Personal Agent" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("option", { name: "Copy to Shared Agent" }),
  ).not.toBeInTheDocument();
  click(secondOption);
  expect(select).toHaveTextContent("Copy to Latest Personal Agent");
});

function linkTo(path: string): HTMLElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.getAttribute("href") === path;
  });
  if (!link) {
    throw new Error(`Link to ${path} not found`);
  }
  return link;
}

async function chooseWorkflowCopy(
  dialog: HTMLElement,
  title = "Daily research",
) {
  const user = userEvent.setup({ delay: null });
  await user.click(
    within(dialog).getByRole("combobox", { name: `Handle workflow ${title}` }),
  );
  await user.click(await screen.findByRole("option", { name: "Copy to Nova" }));
}

test("Retry unfinished rescues without duplicating completed workflows", async () => {
  async function chooseBothWorkflowCopies(dialog: HTMLElement) {
    for (const title of ["Daily research", "Weekly research"]) {
      click(
        within(dialog).getByRole("combobox", {
          name: `Handle workflow ${title}`,
        }),
      );
      click(await screen.findByRole("option", { name: "Copy to Nova" }));
    }
  }

  prepareAgentProfile();
  const first = prepareDeleteWorkflow();
  const second: WorkflowSummary = {
    ...first,
    id: "d0000000-0000-4000-a000-000000000203",
    name: "weekly-research",
    displayName: "Weekly research",
  };
  let workflows = [first, second];
  let allowSecondCopy = false;
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
      if (params.workflowId === second.id && !allowSecondCopy) {
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
  click(within(dialog).getByText("Delete agent"));
  await expect(within(dialog).findByRole("alert")).resolves.toHaveTextContent(
    "Second copy failed",
  );
  expect(within(dialog).getByText("Delete agent")).toBeEnabled();
  expect(screen.getByDisplayValue("Research Agent")).toBeInTheDocument();
  expect(
    within(dialog).getByText("Daily research copied to Nova"),
  ).toBeInTheDocument();
  expect(
    within(dialog).queryByText("Weekly research copied to Nova"),
  ).not.toBeInTheDocument();
  for (const select of within(dialog).getAllByRole("combobox")) {
    expect(select).toHaveTextContent("Delete with agent");
  }

  for (const select of within(dialog).getAllByRole("combobox")) {
    expect(select).toHaveTextContent("Delete with agent");
  }
  expect(
    within(dialog).getByText("Daily research copied to Nova"),
  ).toBeInTheDocument();
  await chooseBothWorkflowCopies(dialog);
  allowSecondCopy = true;
  click(within(dialog).getByText("Delete agent"));
  await screen.findByText("Agent deleted");
  await waitFor(() => {
    expect(linkTo("/workflows")).toBeInTheDocument();
  });
  click(linkTo("/workflows"));
  await screen.findByText("Weekly research");
  expect(screen.getAllByText("Daily research")).toHaveLength(1);
  expect(screen.getAllByText("Weekly research")).toHaveLength(1);
});

test("Keep the source agent when its workflow refresh fails after copying", async () => {
  prepareAgentProfile();
  const workflow = prepareDeleteWorkflow();
  let copySucceeded = false;
  let refreshRecovered = false;
  context.mocks.api(workflowsCollectionContract.list, ({ respond }) => {
    return copySucceeded && !refreshRecovered
      ? respond(403, {
          error: { code: "FORBIDDEN", message: "Refresh failed" },
        })
      : respond(200, [workflow]);
  });
  context.mocks.api(workflowsDetailContract.copy, ({ respond }) => {
    if (copySucceeded) {
      return respond(409, {
        error: { code: "CONFLICT", message: "The workflow was already copied" },
      });
    }
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
    "Could not load workflows. Retry before deleting this agent.",
  );
  await waitFor(() => {
    expect(within(dialog).getByText("Delete agent")).toBeDisabled();
  });
  expect(within(dialog).getByRole("combobox")).toHaveTextContent(
    "Delete with agent",
  );
  expect(within(dialog).getByRole("combobox")).toBeDisabled();
  expect(
    within(dialog).getByText("Daily research copied to Nova"),
  ).toBeInTheDocument();
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
  refreshRecovered = true;
  click(within(reopened).getByText("Retry"));
  await waitFor(() => {
    expect(within(reopened).getByText("Delete agent")).toBeEnabled();
  });
  expect(within(reopened).queryByRole("alert")).not.toBeInTheDocument();
  await chooseWorkflowCopy(reopened);
  click(within(reopened).getByText("Delete agent"));
  await screen.findByText("Agent deleted");
});

test("Load the agent's workflows before enabling deletion after an initial list failure", async () => {
  prepareAgentProfile();
  const workflow = prepareDeleteWorkflow();
  const recoveredList = context.mocks.deferred<void>();
  let canLoad = false;
  context.mocks.api(workflowsCollectionContract.list, async ({ respond }) => {
    if (!canLoad) {
      return respond(403, {
        error: { code: "FORBIDDEN", message: "Workflows unavailable" },
      });
    }
    await recoveredList.promise;
    return respond(200, [workflow]);
  });

  await setupPage({ context, path: `/agents/${AGENT_ID}?tab=profile` });
  await findAgentNameInput();
  click(screen.getByText("Delete agent"));
  const dialog = await screen.findByRole("dialog");
  const alert = await within(dialog).findByRole("alert");
  expect(alert).toHaveTextContent(
    "Could not load workflows. Retry before deleting this agent.",
  );
  expect(within(dialog).getByText("Delete agent")).toBeDisabled();
  expect(within(dialog).getByText("Cancel")).toBeEnabled();

  canLoad = true;
  click(within(dialog).getByText("Retry"));
  await within(dialog).findByText("Loading workflows…");
  expect(within(dialog).getByText("Delete agent")).toBeDisabled();
  recoveredList.resolve();
  const select = await within(dialog).findByRole("combobox");
  expect(select).toHaveTextContent("Delete with agent");
  expect(select).toBeEnabled();
  expect(within(dialog).getByText("Delete agent")).toBeEnabled();
  expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  await chooseWorkflowCopy(dialog);
  expect(select).toHaveTextContent("Copy to Nova");
});
