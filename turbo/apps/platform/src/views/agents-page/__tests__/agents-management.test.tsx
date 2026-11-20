import {
  agentInstructionsContract,
  agentsByIdContract,
  agentsMainContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const CORE_AGENT_ID = "c0000000-0000-4000-a000-000000000020";
const RESEARCH_AGENT_ID = "c0000000-0000-4000-a000-000000000021";
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
    visibility: options.visibility ?? "public",
  };
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

test("Review an agent's profile and instructions", async () => {
  configureResearchAgent();
  await setupPage({ context, path: `/agents/${RESEARCH_AGENT_ID}` });
  await screen.findByRole("heading", { name: "Research Agent" });
  expect(screen.getByLabelText("Chat with Research Agent")).toHaveAttribute(
    "href",
    `/agents/${RESEARCH_AGENT_ID}/chat`,
  );

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
