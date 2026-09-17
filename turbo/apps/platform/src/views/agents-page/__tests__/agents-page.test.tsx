import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { orgMembersContract } from "@okouai/api-contracts/contracts/org-member-routes";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const RESEARCH_AGENT_ID = "c0000000-0000-4000-a000-000000000011";
const PRIVATE_AGENT_ID = "c0000000-0000-4000-a000-000000000012";

function agent(
  agentId: string,
  options: {
    readonly description?: string;
    readonly displayName?: string | null;
    readonly ownerId?: string;
    readonly visibility?: "private" | "public";
  },
): AgentResponse {
  return {
    isDefaultAgent: false,
    agentId,
    ownerId: options.ownerId ?? "test-user-123",
    description: options.description ?? null,
    displayName: options.displayName ?? null,
    sound: null,
    avatarUrl: null,
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
    visibility: options.visibility ?? "public",
  };
}

function visibilityTab(name: "Private" | "Public"): HTMLElement {
  const control = queryAllByRoleFast("radio").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!control) {
    throw new Error(`${name} visibility tab not found`);
  }
  return control;
}

async function waitForVisibilityTabs(): Promise<void> {
  await waitFor(() => {
    expect(visibilityTab("Public")).toBeInTheDocument();
    expect(visibilityTab("Private")).toBeInTheDocument();
  });
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

function configureAgentList(
  targetContext: typeof context,
  agents: readonly AgentResponse[],
): void {
  targetContext.mocks.data.agents([...agents]);
  targetContext.mocks.data.onboardingStatus({
    defaultAgentId: agents[0]?.agentId ?? null,
  });
}

async function creatorPopup(creatorName: string): Promise<HTMLElement> {
  const label = await screen.findByText(`Created by ${creatorName}`);
  const popup = label.closest<HTMLElement>("[data-slot='tooltip-content']");
  if (!popup) {
    throw new Error(`Creator details for ${creatorName} were not found`);
  }
  return popup;
}

test("The Agents document title uses the Okou brand on a trusted host", async () => {
  const agents = [
    agent(RESEARCH_AGENT_ID, {
      displayName: "Research Agent",
      visibility: "public",
    }),
  ];
  configureAgentList(context, agents);

  await setupPage({
    context,
    host: "app.okou.ai",
    path: "/agents",
  });
  await screen.findByRole("heading", { name: "Agents" });
  expect(document.title).toBe("Agents | Okou");
});

test("The Agents document title rejects a look-alike Okou host", async () => {
  configureAgentList(context, [
    agent(RESEARCH_AGENT_ID, {
      displayName: "Research Agent",
      visibility: "public",
    }),
  ]);

  await setupPage({
    context,
    host: "okou.ai.evil.example",
    path: "/agents",
  });
  await screen.findByRole("heading", { name: "Agents" });
  expect(document.title).toBe("Agents | Okou");
});

test("Unread indicators update after a thread-list event", async () => {
  let showUnread = false;
  const refreshed = context.mocks.deferred<void>();
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    if (showUnread && !refreshed.settled()) {
      refreshed.resolve(undefined);
    }
    return respond(200, {
      agents: showUnread
        ? {
            [PRIVATE_AGENT_ID]: "unread",
            [RESEARCH_AGENT_ID]: "unread",
          }
        : {},
      threads: {},
    });
  });
  configureAgentList(context, [
    agent(RESEARCH_AGENT_ID, {
      displayName: "Research Agent",
      visibility: "public",
    }),
    agent(PRIVATE_AGENT_ID, {
      displayName: "Private Ops",
      visibility: "private",
    }),
  ]);
  await setupPage({ context, path: "/agents" });
  await waitForVisibilityTabs();

  click(visibilityTab("Private"));

  await screen.findByText("Private Ops");
  const privateCard = agentCard(PRIVATE_AGENT_ID);
  expect(
    within(privateCard).queryByLabelText("Unread"),
  ).not.toBeInTheDocument();

  showUnread = true;
  context.mocks.ably.trigger("threadListChanged");
  await refreshed.promise;

  await waitFor(() => {
    expect(
      within(agentCard(PRIVATE_AGENT_ID)).getByLabelText("Unread"),
    ).toBeVisible();
  });

  click(visibilityTab("Public"));

  await waitFor(() => {
    expect(agentCard(RESEARCH_AGENT_ID)).toBeVisible();
  });
  expect(
    within(agentCard(RESEARCH_AGENT_ID)).getByLabelText("Unread"),
  ).toBeVisible();
});

test("Agent visibility tabs show public creators without management data", async () => {
  const user = userEvent.setup({ delay: null });
  context.mocks.api(orgMembersContract.members, ({ query, respond }) => {
    if (query.view !== "members") {
      return respond(503, {
        error: {
          code: "PROVIDER_UNAVAILABLE",
          message: "Organization management data is unavailable",
        },
      });
    }
    return respond(200, {
      name: "Test Org",
      role: "admin",
      createdAt: "2026-08-01T00:00:00.000Z",
      members: [
        {
          userId: "alice",
          email: "alice@example.com",
          firstName: "Alice",
          lastName: "Admin",
          imageUrl: "https://example.com/alice.png",
          role: "admin",
          joinedAt: "2026-08-01T00:00:00.000Z",
        },
        {
          userId: "bob",
          email: "bob@example.com",
          firstName: "Bob",
          lastName: "Builder",
          imageUrl: "https://example.com/bob.png",
          role: "member",
          joinedAt: "2026-08-02T00:00:00.000Z",
        },
      ],
    });
  });
  configureAgentList(context, [
    agent(RESEARCH_AGENT_ID, {
      description: "Finds and summarizes evidence",
      displayName: "Research Agent",
      ownerId: "alice",
      visibility: "public",
    }),
    agent(PRIVATE_AGENT_ID, {
      description: "Runs private operations",
      displayName: "Private Ops",
      ownerId: "bob",
      visibility: "private",
    }),
  ]);
  await setupPage({ context, path: "/agents" });
  await waitForVisibilityTabs();

  click(visibilityTab("Private"));

  await waitFor(() => {
    expect(agentCard(PRIVATE_AGENT_ID)).toBeVisible();
  });
  expect(queryAgentCard(RESEARCH_AGENT_ID)).toBeUndefined();
  expect(document.body).not.toHaveTextContent("Bob Builder");

  click(visibilityTab("Public"));

  await waitFor(() => {
    expect(agentCard(RESEARCH_AGENT_ID)).toBeVisible();
  });
  const researchAgent = within(agentCard(RESEARCH_AGENT_ID)).getByText(
    "Research Agent",
  );
  expect(queryAgentCard(PRIVATE_AGENT_ID)).toBeUndefined();

  await user.hover(researchAgent);

  const popup = await creatorPopup("Alice Admin");
  expect(within(popup).getByAltText("")).toHaveAttribute(
    "src",
    "https://example.com/alice.png",
  );
  expect(document.body).not.toHaveTextContent(
    "Organization management data is unavailable",
  );
});

test("Creator tooltips preserve fallbacks for incomplete and missing profiles", async () => {
  const user = userEvent.setup({ delay: null });
  context.mocks.data.orgMembers({
    members: [
      {
        userId: "email-only",
        email: "creator@example.com",
        firstName: null,
        lastName: null,
        imageUrl: "",
        role: "member",
        joinedAt: "2026-08-01T00:00:00.000Z",
      },
      {
        userId: "deleted-profile",
        email: "",
        firstName: null,
        lastName: null,
        imageUrl: "",
        role: "member",
        joinedAt: "2026-08-01T00:00:00.000Z",
      },
    ],
  });
  const creators = [
    {
      agentId: RESEARCH_AGENT_ID,
      displayName: "Email Creator",
      ownerId: "email-only",
      expectedName: "creator@example.com",
      expectedInitial: "C",
    },
    {
      agentId: PRIVATE_AGENT_ID,
      displayName: "Deleted Profile Creator",
      ownerId: "deleted-profile",
      expectedName: "deleted-profile",
      expectedInitial: "D",
    },
    {
      agentId: "c0000000-0000-4000-a000-000000000013",
      displayName: "Departed Creator",
      ownerId: "departed-owner",
      expectedName: "departed-owner",
      expectedInitial: "D",
    },
    {
      agentId: "c0000000-0000-4000-a000-000000000014",
      displayName: "Unknown Creator",
      ownerId: "",
      expectedName: "Unknown",
      expectedInitial: "U",
    },
  ];
  configureAgentList(
    context,
    creators.map((creator) => {
      return agent(creator.agentId, creator);
    }),
  );
  await setupPage({ context, path: "/agents" });

  for (const creator of creators) {
    await waitFor(() => {
      expect(agentCard(creator.agentId)).toBeInTheDocument();
    });
    const title = within(agentCard(creator.agentId)).getByText(
      creator.displayName,
    );
    await user.hover(title);

    const popup = await creatorPopup(creator.expectedName);
    expect(
      within(popup).getByText(creator.expectedInitial),
    ).toBeInTheDocument();
    expect(within(popup).queryByAltText("")).not.toBeInTheDocument();

    await user.unhover(title);
    await waitFor(() => {
      expect(popup).not.toBeInTheDocument();
    });
  }
});

test("Creator profiles work when an older API returns the full members response", async () => {
  const user = userEvent.setup({ delay: null });
  context.mocks.api(orgMembersContract.members, ({ respond }) => {
    return respond(200, {
      name: "Test Org",
      role: "admin",
      createdAt: "2026-08-01T00:00:00.000Z",
      members: [
        {
          userId: "legacy-creator",
          email: "legacy@example.com",
          firstName: "Legacy",
          lastName: "Creator",
          imageUrl: "https://example.com/legacy-creator.png",
          role: "member",
          joinedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
      pendingInvitations: [
        {
          id: "pending-invitation",
          email: "invited@example.com",
          role: "member",
          createdAt: "2026-08-01T00:00:00.000Z",
        },
      ],
      membershipRequests: [],
    });
  });
  configureAgentList(context, [
    agent(RESEARCH_AGENT_ID, {
      displayName: "Research Agent",
      ownerId: "legacy-creator",
    }),
  ]);
  await setupPage({ context, path: "/agents" });
  await waitFor(() => {
    expect(agentCard(RESEARCH_AGENT_ID)).toBeInTheDocument();
  });

  const researchAgent = within(agentCard(RESEARCH_AGENT_ID)).getByText(
    "Research Agent",
  );
  await user.hover(researchAgent);

  const popup = await creatorPopup("Legacy Creator");
  expect(within(popup).getByAltText("")).toHaveAttribute(
    "src",
    "https://example.com/legacy-creator.png",
  );
});
