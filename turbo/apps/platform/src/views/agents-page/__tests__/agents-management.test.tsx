import {
  agentInstructionsContract,
  agentsByIdContract,
  agentsMainContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import { parseAvatarComposerUrl } from "@okouai/core/agent-avatar";
import {
  screen,
  waitFor,
  waitForElementToBeRemoved,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const CORE_AGENT_ID = "c0000000-0000-4000-a000-000000000020";
const RESEARCH_AGENT_ID = "c0000000-0000-4000-a000-000000000021";
const PRIVATE_AGENT_ID = "c0000000-0000-4000-a000-000000000022";
const CREATED_AGENT_ID = "c0000000-0000-4000-a000-000000000023";

interface AgentOptions {
  readonly avatarUrl?: string | null;
  readonly description?: string | null;
  readonly displayName?: string | null;
  readonly ownerId?: string;
  readonly visibility?: "private" | "public";
}

function agent(agentId: string, options: AgentOptions = {}): AgentResponse {
  return {
    isDefaultAgent: false,
    agentId,
    ownerId: options.ownerId ?? "test-user-123",
    description: options.description ?? null,
    displayName: options.displayName ?? null,
    sound: null,
    avatarUrl: options.avatarUrl ?? null,
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
    visibility: options.visibility ?? "public",
  };
}

function buttonByText(
  text: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.replace(/\s+/gu, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

function buttonByLabel(
  label: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!button) {
    throw new Error(`${label} button not found`);
  }
  return button;
}

function visibilityTab(name: string): HTMLElement {
  const tab = queryAllByRoleFast("radio").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!tab) {
    throw new Error(`${name} visibility tab not found`);
  }
  return tab;
}

function detailTab(name: string): HTMLElement {
  const tab = queryAllByRoleFast("tab").find((candidate) => {
    return candidate.textContent?.replace(/\s+/gu, " ").trim() === name;
  });
  if (!tab) {
    throw new Error(`${name} detail tab not found`);
  }
  return tab;
}

function queryAgentCard(agentId: string): HTMLAnchorElement | undefined {
  return queryAllByRoleFast("link").find((candidate) => {
    return candidate.getAttribute("href") === `/agents/${agentId}`;
  }) as HTMLAnchorElement | undefined;
}

function agentCard(agentId: string): HTMLAnchorElement {
  const card = queryAgentCard(agentId);
  if (!card) {
    throw new Error(`${agentId} agent card not found`);
  }
  return card;
}

async function waitForAgentCard(agentId: string): Promise<HTMLAnchorElement> {
  return await waitFor(() => {
    const card = agentCard(agentId);
    expect(card).toBeVisible();
    return card;
  });
}

function configureCatalog(
  initialAgents: readonly AgentResponse[],
  options: {
    readonly defaultAgentId?: string;
    readonly instructions?: Readonly<Record<string, string>>;
    readonly createResponse?: Promise<void>;
  } = {},
): { readonly lastCreatedAgent: () => AgentResponse | null } {
  let agents = [...initialAgents];
  let lastCreatedAgent: AgentResponse | null = null;
  const instructions = new Map(Object.entries(options.instructions ?? {}));
  context.mocks.data.onboardingStatus({
    defaultAgentId: options.defaultAgentId ?? initialAgents[0]?.agentId ?? null,
  });
  context.mocks.api(agentsMainContract.list, ({ respond }) => {
    return respond(200, agents);
  });
  context.mocks.api(
    agentsMainContract.create,
    async ({ body, respond, withSignal }) => {
      if (options.createResponse) {
        await withSignal(options.createResponse);
      }
      const created = agent(CREATED_AGENT_ID, {
        avatarUrl: body.avatarUrl ?? null,
        description: body.description ?? null,
        displayName: body.displayName ?? null,
        visibility: body.visibility ?? "private",
      });
      lastCreatedAgent = created;
      agents = [...agents, created];
      return respond(201, created);
    },
  );
  context.mocks.api(agentsByIdContract.get, ({ params, respond }) => {
    const selected = agents.find((candidate) => {
      return candidate.agentId === params.id;
    });
    return selected
      ? respond(200, selected)
      : respond(404, {
          error: { code: "AGENT_NOT_FOUND", message: "Agent not found" },
        });
  });
  context.mocks.api(agentInstructionsContract.get, ({ params, respond }) => {
    return respond(200, {
      content: instructions.get(params.id) ?? null,
      filename: instructions.has(params.id) ? "AGENTS.md" : null,
    });
  });
  context.mocks.api(
    agentInstructionsContract.update,
    ({ params, body, respond }) => {
      instructions.set(params.id, body.content);
      const selected = agents.find((candidate) => {
        return candidate.agentId === params.id;
      });
      if (!selected) {
        return respond(404, {
          error: { code: "AGENT_NOT_FOUND", message: "Agent not found" },
        });
      }
      return respond(200, selected);
    },
  );
  return {
    lastCreatedAgent: () => {
      return lastCreatedAgent;
    },
  };
}

function configureResearchAgent(): void {
  configureCatalog(
    [
      agent(CORE_AGENT_ID, {
        displayName: "Okou",
        visibility: "public",
      }),
      agent(RESEARCH_AGENT_ID, {
        description: "Collects and verifies evidence",
        displayName: "Research Agent",
        visibility: "public",
      }),
    ],
    {
      defaultAgentId: CORE_AGENT_ID,
      instructions: {
        [RESEARCH_AGENT_ID]:
          "# Research guidance\n\nVerify every source before writing conclusions.",
      },
    },
  );
}

async function openCreateDialog(
  visibility: "Private" | "Public",
  locale: "en-US" | "pt-BR" = "en-US",
): Promise<HTMLElement> {
  const tabLabel =
    locale === "pt-BR"
      ? visibility === "Public"
        ? "Públicos"
        : "Privados"
      : visibility;
  const actionLabel = locale === "pt-BR" ? "Novo agente" : "New agent";
  await waitFor(() => {
    expect(visibilityTab(tabLabel)).toBeInTheDocument();
    expect(buttonByText(actionLabel)).toBeEnabled();
  });
  if (visibility === "Private") {
    click(visibilityTab(tabLabel));
  }
  await waitFor(() => {
    expect(visibilityTab(tabLabel)).toHaveAttribute("aria-checked", "true");
  });
  click(buttonByText(actionLabel));
  return await screen.findByRole("dialog", {
    name: locale === "pt-BR" ? "Criar um novo agente" : "Create a new agent",
  });
}

test("Cancel creating a private agent", async () => {
  configureCatalog([
    agent(PRIVATE_AGENT_ID, {
      displayName: "Existing Private",
      visibility: "private",
    }),
  ]);
  await setupPage({ context, path: "/agents" });
  const dialog = await openCreateDialog("Private");

  click(buttonByText("Cancel", dialog));

  await waitFor(() => {
    expect(buttonByText("New agent")).toBeEnabled();
  });
  expect(dialog).not.toBeInTheDocument();
  expect(agentCard(PRIVATE_AGENT_ID)).toBeVisible();
  const main = screen.getByRole("main");
  const visibleAgentCards = queryAllByRoleFast("link", main).filter((link) => {
    return /^\/agents\/[^/]+$/u.test(link.getAttribute("href") ?? "");
  });
  expect(visibleAgentCards).toHaveLength(1);
});

test("Pressing Enter creates a named private agent", async () => {
  const user = userEvent.setup({ delay: null });
  configureCatalog([
    agent(CORE_AGENT_ID, { displayName: "Core Agent", visibility: "public" }),
  ]);
  await setupPage({ context, path: "/agents" });
  const dialog = await openCreateDialog("Private");
  const name = within(dialog).getByLabelText("Name");

  await fill(name, "Private Analyst");
  await user.keyboard("{Enter}");

  const createdCard = await waitForAgentCard(CREATED_AGENT_ID);
  expect(createdCard).toHaveTextContent("Private Analyst");
  expect(
    screen.queryByRole("dialog", { name: "Create a new agent" }),
  ).not.toBeInTheDocument();
});

test("Create a public agent with a customized avatar", async () => {
  const catalog = configureCatalog([
    agent(CORE_AGENT_ID, { displayName: "Core Agent", visibility: "public" }),
  ]);
  await setupPage({
    context,
    path: "/agents",
  });
  const creationDialog = await openCreateDialog("Public");
  await fill(within(creationDialog).getByLabelText("Name"), "Marketing Bot");

  click(buttonByLabel("Customize avatar", creationDialog));

  const avatarDialog = await screen.findByRole("dialog", {
    name: "Give your agent a face",
  });
  expect(within(avatarDialog).getByText("Face")).toBeVisible();
  click(buttonByLabel("Randomize avatar", avatarDialog));
  for (const step of ["Hair", "Mood", "Skin", "Color"]) {
    click(buttonByLabel("Next step", avatarDialog));
    await expect(within(avatarDialog).findByText(step)).resolves.toBeVisible();
  }
  click(buttonByLabel("Blue", avatarDialog));

  click(buttonByText("Use this avatar", avatarDialog));

  await waitForElementToBeRemoved(avatarDialog);
  click(buttonByText("Create", creationDialog));

  const createdCard = await waitForAgentCard(CREATED_AGENT_ID);
  expect(createdCard).toHaveTextContent("Marketing Bot");
  expect(
    parseAvatarComposerUrl(catalog.lastCreatedAgent()?.avatarUrl),
  ).not.toBeNull();
  expect(
    within(createdCard).getByRole("img", { name: "Marketing Bot" }),
  ).toBeVisible();
});

test("Closing the avatar dialog preserves the agent draft and returns focus", async () => {
  const user = userEvent.setup({ delay: null });
  configureCatalog([
    agent(CORE_AGENT_ID, { displayName: "Core Agent", visibility: "public" }),
  ]);
  await setupPage({ context, path: "/agents" });
  const creationDialog = await openCreateDialog("Private");
  const name = within(creationDialog).getByLabelText("Name");
  await fill(name, "Private Analyst");
  const customize = buttonByLabel("Customize avatar", creationDialog);
  click(customize);

  const avatarDialog = await screen.findByRole("dialog", {
    name: "Give your agent a face",
  });
  await user.keyboard("{Escape}");

  await waitForElementToBeRemoved(avatarDialog);
  expect(creationDialog).toBeInTheDocument();
  expect(name).toHaveValue("Private Analyst");
  expect(customize).toHaveFocus();
});

test("Release avatar editing when the parent agent creation finishes", async () => {
  const createResponse = context.mocks.deferred<void>();
  configureCatalog(
    [agent(CORE_AGENT_ID, { displayName: "Core Agent", visibility: "public" })],
    { createResponse: createResponse.promise },
  );
  await setupPage({ context, path: "/agents" });
  const creationDialog = await openCreateDialog("Private");
  await fill(within(creationDialog).getByLabelText("Name"), "Private Analyst");
  click(buttonByText("Create", creationDialog));
  click(buttonByLabel("Customize avatar", creationDialog));
  const avatarDialog = await screen.findByRole("dialog", {
    name: "Give your agent a face",
  });
  click(buttonByLabel("Randomize avatar", avatarDialog));

  createResponse.resolve(undefined);

  await waitForAgentCard(CREATED_AGENT_ID);
  const nextCreationDialog = await openCreateDialog("Private");
  expect(within(nextCreationDialog).getByLabelText("Name")).toHaveValue("");
  expect(
    screen.queryByRole("dialog", { name: "Give your agent a face" }),
  ).not.toBeInTheDocument();
  click(buttonByLabel("Customize avatar", nextCreationDialog));
  const nextAvatarDialog = await screen.findByRole("dialog", {
    name: "Give your agent a face",
  });
  expect(buttonByLabel("Randomize avatar", nextAvatarDialog)).toBeEnabled();
});

test("Open an agent's management page from its card", async () => {
  configureCatalog([
    agent(RESEARCH_AGENT_ID, {
      description: "Coordinates campaigns",
      displayName: "Marketing Bot",
      visibility: "public",
    }),
  ]);
  await setupPage({ context, path: "/agents" });
  const marketingBot = await waitForAgentCard(RESEARCH_AGENT_ID);

  click(marketingBot);

  await screen.findByRole("heading", { name: "Marketing Bot" });
  expect(document.title).toBe("Marketing Bot | Okou");
});

test("Review an agent's profile and instructions", async () => {
  configureResearchAgent();
  await setupPage({ context, path: `/agents/${RESEARCH_AGENT_ID}` });
  await screen.findByRole("heading", { name: "Research Agent" });
  expect(buttonByText("Chat with Research Agent")).toBeVisible();

  click(detailTab("Profile"));

  await expect(screen.findByLabelText("Name")).resolves.toHaveValue(
    "Research Agent",
  );
  expect(screen.getByLabelText("Description")).toHaveValue(
    "Collects and verifies evidence",
  );

  click(detailTab("Instructions"));

  const editor = await screen.findByLabelText("Instructions editor");
  expect(editor).toHaveTextContent(
    "Verify every source before writing conclusions.",
  );
});

test("Review agent details with the named section select", async () => {
  const user = userEvent.setup({ delay: null });
  configureResearchAgent();
  await setupPage({ context, path: `/agents/${RESEARCH_AGENT_ID}` });
  await screen.findByRole("heading", { name: "Research Agent" });
  const section = screen.getByRole("combobox", {
    name: "Agent details section",
  });
  expect(section).toHaveTextContent("Authorization");

  section.focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("option", { name: "Authorization", selected: true });
  await user.keyboard("{ArrowDown}{Enter}");

  await expect(screen.findByLabelText("Name")).resolves.toHaveValue(
    "Research Agent",
  );
  expect(screen.getByLabelText("Description")).toHaveValue(
    "Collects and verifies evidence",
  );
  expect(window.location.pathname).toBe(`/agents/${RESEARCH_AGENT_ID}`);
  expect(window.location.search).toBe("?tab=profile");
  const profileSection = screen.getByRole("combobox", {
    name: "Agent details section",
  });
  expect(profileSection).toHaveTextContent("Profile");
  await waitFor(() => {
    expect(profileSection).toHaveFocus();
  });

  await user.keyboard("{Enter}");
  await screen.findByRole("option", { name: "Profile", selected: true });
  await user.keyboard("{ArrowDown}{Enter}");

  const editor = await screen.findByLabelText("Instructions editor");
  expect(editor).toHaveTextContent(
    "Verify every source before writing conclusions.",
  );
  expect(window.location.pathname).toBe(`/agents/${RESEARCH_AGENT_ID}`);
  expect(window.location.search).toBe("?tab=instructions");
  const instructionsSection = screen.getByRole("combobox", {
    name: "Agent details section",
  });
  expect(instructionsSection).toHaveTextContent("Instructions");
  await waitFor(() => {
    expect(instructionsSection).toHaveFocus();
  });

  await user.keyboard("{Enter}");
  await screen.findByRole("option", { name: "Instructions", selected: true });
  await user.keyboard("{Escape}");

  await waitFor(() => {
    expect(instructionsSection).toHaveFocus();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
  expect(window.location.search).toBe("?tab=instructions");
});

test("Switch between public and private agent lists", async () => {
  configureCatalog([
    agent(RESEARCH_AGENT_ID, {
      description: "Summarizes market research",
      displayName: "Research Agent",
      visibility: "public",
    }),
    agent(PRIVATE_AGENT_ID, {
      description: "Handles confidential operations",
      displayName: null,
      visibility: "private",
    }),
  ]);
  await setupPage({ context, path: "/agents" });
  const publicCard = await waitForAgentCard(RESEARCH_AGENT_ID);
  await waitFor(() => {
    expect(buttonByText("New agent")).toBeEnabled();
  });

  expect(publicCard).toHaveTextContent("Research Agent");
  expect(publicCard).toHaveTextContent("Summarizes market research");
  expect(queryAgentCard(PRIVATE_AGENT_ID)).toBeUndefined();

  click(visibilityTab("Private"));

  const privateCard = await waitForAgentCard(PRIVATE_AGENT_ID);
  expect(privateCard).toHaveTextContent(PRIVATE_AGENT_ID);
  expect(privateCard).toHaveTextContent("Handles confidential operations");
  expect(queryAgentCard(RESEARCH_AGENT_ID)).toBeUndefined();
  expect(buttonByText("New agent")).toBeEnabled();
});
