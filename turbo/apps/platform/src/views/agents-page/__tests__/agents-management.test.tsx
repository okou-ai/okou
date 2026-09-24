import {
  agentSetupPromptsContract,
  type AgentSetupPromptRequest,
} from "@okouai/api-contracts/contracts/agent-setup-prompts";
import {
  agentInstructionsContract,
  agentsByIdContract,
  agentsMainContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { parseAvatarComposerUrl } from "@okouai/core/agent-avatar";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  fireEvent,
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
import { pathname } from "../../../signals/location.ts";
import { mockChatLifecycle } from "../../okou-page/__tests__/chat-test-helpers.ts";

const context = testContext();

const CORE_AGENT_ID = "c0000000-0000-4000-a000-000000000020";
const RESEARCH_AGENT_ID = "c0000000-0000-4000-a000-000000000021";
const PRIVATE_AGENT_ID = "c0000000-0000-4000-a000-000000000022";
const CREATED_AGENT_ID = "c0000000-0000-4000-a000-000000000023";
const RESPONSIBILITY_LABEL = "What do you want this agent to help you do?";

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

function pinnedAgentCard(agentId: string): HTMLElement {
  const card = queryAllByRoleFast(
    "link",
    screen.getByTestId("pinned-agents-grid"),
  ).find((candidate) => {
    return candidate.getAttribute("href") === `/agents/${agentId}/chat`;
  });
  if (!card) {
    throw new Error(`${agentId} pinned agent card not found`);
  }
  return card;
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

function agentCardsNamed(name: string): HTMLElement[] {
  return queryAllByRoleFast("link", screen.getByRole("main")).filter((card) => {
    return within(card).queryByText(name, { exact: true }) !== null;
  });
}

function configureCatalog(
  initialAgents: readonly AgentResponse[],
  options: {
    readonly defaultAgentId?: string;
    readonly instructions?: Readonly<Record<string, string>>;
    readonly beforeCreate?: () => Promise<void>;
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
  context.mocks.api(agentsMainContract.create, async ({ body, respond }) => {
    await options.beforeCreate?.();
    const created = agent(
      lastCreatedAgent === null ? CREATED_AGENT_ID : crypto.randomUUID(),
      {
        avatarUrl: body.avatarUrl ?? null,
        description: body.description ?? null,
        displayName: body.displayName ?? null,
        visibility: body.visibility ?? "private",
      },
    );
    lastCreatedAgent = created;
    agents = [...agents, created];
    return respond(201, created);
  });
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

test.each([
  { tab: "Private" as const, publicAgentCount: 1 },
  { tab: "Public" as const, publicAgentCount: 1 },
  { tab: "Public" as const, publicAgentCount: 7 },
])(
  "Pressing Enter defaults to a private agent from $tab with $publicAgentCount public agents",
  async ({ tab, publicAgentCount }) => {
    const user = userEvent.setup({ delay: null });
    configureCatalog(
      Array.from({ length: publicAgentCount }, (_, index) => {
        return agent(index === 0 ? CORE_AGENT_ID : crypto.randomUUID(), {
          displayName: `Public Agent ${index + 1}`,
          visibility: "public",
        });
      }),
    );
    await setupPage({ context, path: "/agents" });
    const dialog = await openCreateDialog(tab);
    expect(
      within(dialog).getByRole("combobox", { name: "Visibility" }),
    ).toHaveTextContent("Private");
    const name = within(dialog).getByLabelText("Name");

    await fill(name, "  Private Analyst  ");
    await user.keyboard("{Enter}");

    const createdCard = await waitForAgentCard(CREATED_AGENT_ID);
    expect(createdCard).toHaveTextContent("Private Analyst");
    expect(agentCardsNamed("Private Analyst")).toHaveLength(1);
    expect(visibilityTab("Private")).toHaveAttribute("aria-checked", "true");
    expect(
      screen.queryByRole("dialog", { name: "Create a new agent" }),
    ).not.toBeInTheDocument();

    click(visibilityTab("Public"));
    await waitForAgentCard(CORE_AGENT_ID);
    expect(queryAgentCard(CREATED_AGENT_ID)).toBeUndefined();
  },
);

test.each([
  { mode: "composing", isComposing: true, keyCode: 13, name: "中文助手" },
  {
    mode: "Safari final Enter",
    isComposing: false,
    keyCode: 229,
    name: "日本語助手",
  },
])(
  "Confirming an IME candidate ($mode) keeps agent creation open",
  async ({ isComposing, keyCode, name: candidate }) => {
    const user = userEvent.setup({ delay: null });
    configureCatalog([
      agent(CORE_AGENT_ID, { displayName: "Core Agent", visibility: "public" }),
    ]);
    await setupPage({ context, path: "/agents" });
    const dialog = await openCreateDialog("Private");
    const name = within(dialog).getByLabelText("Name");

    fireEvent.compositionStart(name);
    await fill(name, candidate);
    // Safari may dispatch compositionend before the candidate-confirming Enter.
    if (!isComposing) {
      fireEvent.compositionEnd(name, { data: candidate });
    }
    fireEvent.keyDown(name, {
      key: "Enter",
      code: "Enter",
      isComposing,
      keyCode,
    });

    expect(name).toHaveFocus();
    expect(name).toBeEnabled();
    expect(name).toHaveValue(candidate);
    expect(dialog).toBeInTheDocument();

    if (isComposing) {
      fireEvent.compositionEnd(name, { data: candidate });
    }
    await user.keyboard("{Enter}");

    await expect(waitForAgentCard(CREATED_AGENT_ID)).resolves.toHaveTextContent(
      candidate,
    );
    expect(agentCardsNamed(candidate)).toHaveLength(1);
    expect(dialog).not.toBeInTheDocument();
  },
);

test("Blank Enter and cancelling a named draft do not create an agent", async () => {
  const user = userEvent.setup({ delay: null });
  configureCatalog([
    agent(CORE_AGENT_ID, { displayName: "Core Agent", visibility: "public" }),
  ]);
  await setupPage({ context, path: "/agents" });
  const dialog = await openCreateDialog("Private");
  const name = within(dialog).getByLabelText("Name");

  await fill(name, "   ");
  await user.keyboard("{Enter}");
  expect(buttonByText("Create", dialog)).toBeDisabled();
  expect(name).toHaveFocus();

  await fill(name, "Discard this draft");
  await user.click(
    within(dialog).getByRole("combobox", { name: "Visibility" }),
  );
  await user.click(await screen.findByRole("option", { name: /Public/u }));
  click(buttonByText("Cancel", dialog));
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
  expect(agentCardsNamed("Discard this draft")).toHaveLength(0);
  const reopened = await openCreateDialog("Private");
  expect(within(reopened).getByLabelText("Name")).toHaveValue("");
  expect(
    within(reopened).getByRole("combobox", { name: "Visibility" }),
  ).toHaveTextContent("Private");
});

test("A pending create disables submission and adds only one agent card", async () => {
  const user = userEvent.setup({ delay: null });
  const response = context.mocks.deferred<void>();
  configureCatalog(
    [agent(CORE_AGENT_ID, { displayName: "Core Agent", visibility: "public" })],
    {
      beforeCreate: () => {
        return response.promise;
      },
    },
  );
  await setupPage({ context, path: "/agents" });
  const dialog = await openCreateDialog("Private");
  const name = within(dialog).getByLabelText("Name");

  await fill(name, "Pending analyst");
  click(buttonByText("Create", dialog));
  const pending = await within(dialog).findByText("Creating…");
  expect(name).toBeDisabled();
  expect(buttonByText("Cancel", dialog)).toBeDisabled();
  expect(pending.closest("button")).toBeDisabled();
  await user.keyboard("{Enter}");
  click(pending);
  response.resolve(undefined);

  await expect(waitForAgentCard(CREATED_AGENT_ID)).resolves.toHaveTextContent(
    "Pending analyst",
  );
  expect(agentCardsNamed("Pending analyst")).toHaveLength(1);
});

test("Create a public agent with a customized avatar", async () => {
  const user = userEvent.setup({ delay: null });
  const catalog = configureCatalog([
    agent(CORE_AGENT_ID, { displayName: "Core Agent", visibility: "public" }),
  ]);
  await setupPage({
    context,
    path: "/agents",
  });
  const creationDialog = await openCreateDialog("Public");
  await fill(within(creationDialog).getByLabelText("Name"), "Marketing Bot");
  await user.click(
    within(creationDialog).getByRole("combobox", { name: "Visibility" }),
  );
  await user.click(await screen.findByRole("option", { name: /Public/u }));

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
  expect(agentCardsNamed("Marketing Bot")).toHaveLength(1);
  expect(
    parseAvatarComposerUrl(catalog.lastCreatedAgent()?.avatarUrl),
  ).not.toBeNull();
  expect(
    within(createdCard).getByRole("img", { name: "Marketing Bot" }),
  ).toBeVisible();
});

test("Creating an agent with setup requires a multi-line responsibility", async () => {
  const user = userEvent.setup({ delay: null });
  configureCatalog([
    agent(CORE_AGENT_ID, { displayName: "Core Agent", visibility: "public" }),
  ]);
  await setupPage({
    context,
    path: "/agents",
    featureSwitches: { [FeatureSwitchKey.AgentResponsibilitySetup]: true },
  });
  const dialog = await openCreateDialog("Private");
  const responsibility =
    await within(dialog).findByLabelText(RESPONSIBILITY_LABEL);
  expect(responsibility).toBeRequired();

  await fill(within(dialog).getByLabelText("Name"), "Pipeline Analyst");
  await user.keyboard("{Enter}");

  expect(buttonByText("Create", dialog)).toBeDisabled();

  await fill(responsibility, "   ");

  expect(buttonByText("Create", dialog)).toBeDisabled();

  await user.type(
    responsibility,
    "Summarize the pipeline every Monday.{Enter}Flag stalled deals.",
  );

  expect(responsibility).toHaveValue(
    "   Summarize the pipeline every Monday.\nFlag stalled deals.",
  );
  expect(buttonByText("Create", dialog)).toBeEnabled();
  expect(dialog).toBeInTheDocument();
});

test("Creating an agent with setup pins it and sends its setup prompt in a new thread", async () => {
  const user = userEvent.setup({ delay: null });
  const setupPrompt =
    "Please adopt this responsibility: every Monday, summarize last week's pipeline and flag stalled deals. Update your description and instructions to match.";
  const setupRequests: AgentSetupPromptRequest[] = [];
  const sentPrompts: string[] = [];
  configureCatalog(
    [agent(CORE_AGENT_ID, { displayName: "Core Agent", visibility: "public" })],
    { defaultAgentId: CORE_AGENT_ID },
  );
  context.mocks.api(agentSetupPromptsContract.create, ({ body, respond }) => {
    setupRequests.push(body);
    return respond(200, { prompt: setupPrompt });
  });
  mockChatLifecycle(context, {
    onSendRequest: ({ prompt }) => {
      sentPrompts.push(prompt);
    },
  });
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "BROWSER_NOT_FOUND",
        message: "Managed browser not found",
      },
    });
  });
  await setupPage({
    context,
    path: "/agents",
    featureSwitches: { [FeatureSwitchKey.AgentResponsibilitySetup]: true },
  });
  const dialog = await openCreateDialog("Private");
  await fill(within(dialog).getByLabelText("Name"), "  Pipeline Analyst ");
  await fill(
    within(dialog).getByLabelText(RESPONSIBILITY_LABEL),
    "  Every Monday, summarize last week's pipeline.\nFlag stalled deals.\n",
  );

  await user.click(within(dialog).getByLabelText("Name"));
  await user.keyboard("{Enter}");

  await expect(
    screen.findByText("Pipeline Analyst created successfully"),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toMatch(/^\/chats\/[^/]+$/u);
  expect(sentPrompts).toStrictEqual([setupPrompt]);
  expect(setupRequests).toStrictEqual([
    {
      agentName: "Pipeline Analyst",
      responsibility:
        "Every Monday, summarize last week's pipeline.\nFlag stalled deals.",
    },
  ]);
  await waitFor(() => {
    expect(pinnedAgentCard(CREATED_AGENT_ID)).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
  expect(pinnedAgentCard(CREATED_AGENT_ID)).toHaveTextContent(
    "Pipeline Analyst",
  );
});

test("A failed setup request after creation leaves the Agent visible without a retryable dialog", async () => {
  configureCatalog([
    agent(CORE_AGENT_ID, { displayName: "Core Agent", visibility: "public" }),
  ]);
  context.mocks.api(agentSetupPromptsContract.create, ({ respond }) => {
    return respond(403, {
      error: { code: "FORBIDDEN", message: "Setup temporarily unavailable" },
    });
  });
  await setupPage({
    context,
    path: "/agents",
    featureSwitches: { [FeatureSwitchKey.AgentResponsibilitySetup]: true },
  });
  const dialog = await openCreateDialog("Private");
  await fill(within(dialog).getByLabelText("Name"), "Pipeline Analyst");
  await fill(
    within(dialog).getByLabelText(RESPONSIBILITY_LABEL),
    "Summarize our pipeline every Monday.",
  );

  click(buttonByText("Create", dialog));

  const createdCard = await waitForAgentCard(CREATED_AGENT_ID);
  expect(createdCard).toHaveTextContent("Pipeline Analyst");
  await expect(
    screen.findByText(
      "Agent setup did not finish. Check the agent list before trying again.",
    ),
  ).resolves.toBeInTheDocument();
  expect(dialog).not.toBeInTheDocument();
  expect(pathname()).toBe("/agents");
  expect(
    queryAllByRoleFast("link", screen.getByRole("main")).filter((link) => {
      return /^\/agents\/[^/]+$/u.test(link.getAttribute("href") ?? "");
    }),
  ).toHaveLength(1);
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
