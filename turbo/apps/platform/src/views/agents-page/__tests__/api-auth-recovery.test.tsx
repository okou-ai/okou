import { agentSetupPromptsContract } from "@okouai/api-contracts/contracts/agent-setup-prompts";
import {
  agentsByIdContract,
  agentInstructionsContract,
  agentsMainContract,
  type AgentRequest,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "../../okou-page/__tests__/chat-test-helpers.ts";

const context = testContext();
const CORE_AGENT_ID = "c0000000-0000-4000-a000-000000000030";
const CREATED_AGENT_ID = "c0000000-0000-4000-a000-000000000031";
const RENEWED_TOKEN = "renewed-page-session-token";
function unauthorizedError(): { error: { code: string; message: string } } {
  return { error: { code: "UNAUTHORIZED", message: "Session token expired" } };
}

function agent(agentId: string, displayName: string): AgentResponse {
  return {
    agentId,
    isDefaultAgent: false,
    ownerId: "test-user-123",
    description: null,
    displayName,
    sound: null,
    avatarUrl: null,
    visibility: "public",
  };
}

function buttonByText(
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.replace(/\s+/gu, " ").trim() === name;
  });
  if (!button) {
    throw new Error(`${name} button not found`);
  }
  return button;
}

function agentCard(agentId: string): HTMLElement {
  const card = queryAllByRoleFast("link").find((candidate) => {
    return candidate.getAttribute("href") === `/agents/${agentId}`;
  });
  if (!card) {
    throw new Error(`${agentId} agent card not found`);
  }
  return card;
}

function renewSessionToken(): void {
  // Model Clerk learning the renewed token after the API rejects the old one.
  // A replay that reuses its original token must still be rejected by the API.
  mockedClerk.sessionGetToken.mockImplementation((options) => {
    expect(options).toBeUndefined();
    return Promise.resolve(RENEWED_TOKEN);
  });
}

function expectOrdinaryTokenReads(): void {
  expect(mockedClerk.sessionGetToken).toHaveBeenCalledWith(undefined);
  for (const [options] of mockedClerk.sessionGetToken.mock.calls) {
    expect(options).toBeUndefined();
  }
}

test("The Agents page recovers its list after an expired window API token", async () => {
  context.mocks.clerk();
  context.mocks.data.onboardingStatus({ defaultAgentId: CORE_AGENT_ID });
  let rejected = false;
  let initialAuthorization: string | null = null;
  context.mocks.api(agentsMainContract.list, ({ request, respond }) => {
    if (!rejected) {
      initialAuthorization = request.headers.get("Authorization");
      rejected = true;
      renewSessionToken();
      return respond(401, unauthorizedError());
    }
    if (request.headers.get("Authorization") !== `Bearer ${RENEWED_TOKEN}`) {
      return respond(401, unauthorizedError());
    }
    return respond(200, [agent(CORE_AGENT_ID, "Recovered Research Agent")]);
  });

  await setupPage({ context, path: "/agents" });

  await waitFor(() => {
    expect(agentCard(CORE_AGENT_ID)).toBeInTheDocument();
    expect(agentCard(CORE_AGENT_ID)).toHaveTextContent(
      "Recovered Research Agent",
    );
  });
  expect(initialAuthorization).toBe("Bearer test-token");
  expect(screen.getByRole("heading", { name: "Agents" })).toBeInTheDocument();
  expectOrdinaryTokenReads();
});

test("Creating an agent recovers after 401 without losing the submitted body", async () => {
  context.mocks.clerk();
  const agents = [agent(CORE_AGENT_ID, "Core Agent")];
  context.mocks.data.onboardingStatus({ defaultAgentId: CORE_AGENT_ID });
  context.mocks.api(agentsMainContract.list, ({ respond }) => {
    return respond(200, agents);
  });
  let originalBody: AgentRequest | undefined;
  context.mocks.api(agentsMainContract.create, ({ body, request, respond }) => {
    expect(request.headers.get("Authorization")).toBe(
      originalBody === undefined
        ? "Bearer test-token"
        : `Bearer ${RENEWED_TOKEN}`,
    );
    expect(body).toMatchObject({
      displayName: "Recovered Analyst",
      visibility: "private",
    });
    if (originalBody === undefined) {
      originalBody = body;
      renewSessionToken();
      return respond(401, unauthorizedError());
    }
    if (request.headers.get("Authorization") !== `Bearer ${RENEWED_TOKEN}`) {
      return respond(401, unauthorizedError());
    }
    expect(body).toStrictEqual(originalBody);
    const created: AgentResponse = {
      ...agent(CREATED_AGENT_ID, body.displayName ?? ""),
      description: body.description ?? null,
      avatarUrl: body.avatarUrl ?? null,
      visibility: body.visibility ?? "private",
    };
    agents.push(created);
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
  // The POST uses this test's catalog, not the shared fixture catalog.
  // Complete the normal creation flow's seed-instruction upload for it too.
  context.mocks.api(agentInstructionsContract.update, ({ params, respond }) => {
    expect(params.id).toBe(CREATED_AGENT_ID);
    const created = agents.find((candidate) => {
      return candidate.agentId === params.id;
    });
    if (!created) {
      throw new Error("Created agent missing from catalog");
    }
    return respond(200, created);
  });
  context.mocks.data.availableRunModels([]);
  context.mocks.api(agentSetupPromptsContract.create, ({ body, respond }) => {
    expect(body.responsibility).toBe("Summarize our pipeline every Monday.");
    return respond(200, {
      prompt: `Hi ${body.agentName}, adopt this responsibility: ${body.responsibility}`,
    });
  });
  mockChatLifecycle(context);
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "BROWSER_NOT_FOUND",
        message: "Managed browser not found",
      },
    });
  });

  await setupPage({ context, path: "/agents" });
  await waitFor(() => {
    expect(agentCard(CORE_AGENT_ID)).toHaveTextContent("Core Agent");
  });
  await waitFor(() => {
    expect(buttonByText("New agent")).toBeEnabled();
  });

  click(buttonByText("New agent"));
  const dialog = await screen.findByRole("dialog", {
    name: "Create a new agent",
  });
  await fill(within(dialog).getByLabelText("Name"), "Recovered Analyst");
  await fill(
    within(dialog).getByLabelText(
      "What do you want this agent to help you do?",
    ),
    "Summarize our pipeline every Monday.",
  );
  await waitFor(() => {
    expect(buttonByText("Create", dialog)).toBeEnabled();
  });
  click(buttonByText("Create", dialog));

  await expect(
    screen.findByText("Recovered Analyst created successfully"),
  ).resolves.toBeInTheDocument();
  expect(dialog).not.toBeInTheDocument();
  expect(window.location.pathname).toMatch(/^\/chats\/[^/]+$/u);
  const agentsLink = queryAllByRoleFast("link").find((candidate) => {
    return candidate.getAttribute("href") === "/agents";
  });
  if (!agentsLink) {
    throw new Error("Agents navigation link not found");
  }

  click(agentsLink);

  await waitFor(() => {
    expect(agentCard(CREATED_AGENT_ID)).toBeInTheDocument();
    expect(agentCard(CREATED_AGENT_ID)).toHaveTextContent("Recovered Analyst");
  });
  expect(originalBody).toBeDefined();
  expectOrdinaryTokenReads();
});

test("SharedWorker indicators refresh recovers after 401 over the message port", async () => {
  context.mocks.clerk();
  context.mocks.data.agents([agent(CORE_AGENT_ID, "Research Agent")]);
  context.mocks.data.onboardingStatus({ defaultAgentId: CORE_AGENT_ID });
  let refresh = false;
  let rejected = false;
  let initialAuthorization: string | null = null;
  context.mocks.api(chatThreadsContract.indicators, ({ request, respond }) => {
    if (!refresh) {
      return respond(200, { agents: {}, threads: {}, unreadAt: {} });
    }
    if (!rejected) {
      initialAuthorization = request.headers.get("Authorization");
      rejected = true;
      renewSessionToken();
      return respond(401, unauthorizedError());
    }
    if (request.headers.get("Authorization") !== `Bearer ${RENEWED_TOKEN}`) {
      return respond(401, unauthorizedError());
    }
    return respond(200, {
      agents: { [CORE_AGENT_ID]: "unread" },
      threads: {},
      unreadAt: {},
    });
  });

  await setupPage({
    context,
    path: "/agents",
    sharedWorkerTestTransport: "message-port",
  });
  await waitFor(() => {
    expect(agentCard(CORE_AGENT_ID)).toHaveTextContent("Research Agent");
  });
  expect(
    within(agentCard(CORE_AGENT_ID)).queryByLabelText("Unread"),
  ).not.toBeInTheDocument();

  refresh = true;
  context.mocks.ably.trigger("threadListChanged");

  await waitFor(() => {
    expect(
      within(agentCard(CORE_AGENT_ID)).getByLabelText("Unread"),
    ).toBeVisible();
  });
  expect(initialAuthorization).toBe("Bearer test-token");
  expect(screen.getByRole("heading", { name: "Agents" })).toBeInTheDocument();
  expectOrdinaryTokenReads();
});
