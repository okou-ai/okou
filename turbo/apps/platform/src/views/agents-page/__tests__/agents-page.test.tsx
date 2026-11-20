import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { orgMembersContract } from "@okouai/api-contracts/contracts/org-member-routes";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { changeChatIndicators } from "../../../mocks/mock-helpers.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const RESEARCH_AGENT = "c0000000-0000-4000-a000-000000000a01";
const PRIVATE_AGENT = "c0000000-0000-4000-a000-000000000a02";

async function chooseVisibility(name: "Private" | "Public"): Promise<void> {
  const option = queryAllByRoleFast("radio").find((radio) => {
    return radio.textContent?.trim() === name;
  });
  await userEvent.click(option as HTMLElement);
  await waitFor(() => {
    expect(option).toHaveAttribute("aria-checked", "true");
  });
}

function agentList(): HTMLElement {
  const main = document.querySelector<HTMLElement>("main");
  if (!main) {
    throw new Error("Expected the agents list");
  }
  return main;
}

/** The agent's card link in the list, located by its visible name. */
async function findAgentCard(name: string): Promise<HTMLElement> {
  const label = await within(agentList()).findByText(name);
  const card = label.closest<HTMLElement>("a");
  if (!card) {
    throw new Error(`Expected the ${name} card`);
  }
  return card;
}

function unreadIndicator(card: HTMLElement): Element | null {
  return card.querySelector('[aria-label="Unread"]');
}

test("Unread indicators update after an indicator change (message-port)", async () => {
  context.mocks.data.agents([
    {
      agentId: RESEARCH_AGENT,
      displayName: "Research Agent",
      visibility: "public",
    },
    {
      agentId: PRIVATE_AGENT,
      displayName: "Planning Agent",
      visibility: "private",
    },
  ]);
  const server = { unread: false };
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      agents: server.unread
        ? { [RESEARCH_AGENT]: "unread", [PRIVATE_AGENT]: "unread" }
        : {},
      threads: {},
      unreadAt: {},
    });
  });
  await setupPage({
    context,
    path: "/agents",
    sharedWorkerTestTransport: "message-port",
  });
  await findAgentCard("Research Agent");
  await chooseVisibility("Private");
  const planning = await findAgentCard("Planning Agent");
  expect(unreadIndicator(planning)).toBeNull();

  server.unread = true;
  changeChatIndicators();

  await waitFor(() => {
    expect(unreadIndicator(planning)).toBeInTheDocument();
  });
  await chooseVisibility("Public");
  const research = await findAgentCard("Research Agent");
  expect(unreadIndicator(research)).toBeInTheDocument();
});

test("Agent visibility tabs show public creators without management data", async () => {
  const aliceImage = "https://images.example.test/alice.png";
  context.mocks.data.agents([
    {
      agentId: RESEARCH_AGENT,
      displayName: "Research Agent",
      visibility: "public",
      ownerId: "user_alice",
    },
    {
      agentId: PRIVATE_AGENT,
      displayName: "Private Ops",
      visibility: "private",
      ownerId: "user_bob",
    },
  ]);
  const managementFailure = "Only workspace admins can manage members";
  context.mocks.api(orgMembersContract.members, ({ query, respond }) => {
    if (query.view !== "members") {
      return respond(403, {
        error: { code: "FORBIDDEN", message: managementFailure },
      });
    }
    return respond(200, {
      name: "Acme",
      role: "member",
      createdAt: "2026-01-01T00:00:00.000Z",
      members: [
        {
          userId: "user_alice",
          email: "alice@example.test",
          firstName: "Alice",
          lastName: "Admin",
          imageUrl: aliceImage,
          role: "admin",
          joinedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          userId: "user_bob",
          email: "bob@example.test",
          firstName: "Bob",
          lastName: "Builder",
          imageUrl: "https://images.example.test/bob.png",
          role: "member",
          joinedAt: "2026-01-02T00:00:00.000Z",
        },
      ],
    });
  });
  await setupPage({ context, path: "/agents" });
  await findAgentCard("Research Agent");

  await chooseVisibility("Private");

  await findAgentCard("Private Ops");
  expect(within(agentList()).queryByText("Research Agent")).toBeNull();
  expect(screen.queryByText(/Bob Builder/u)).not.toBeInTheDocument();

  await chooseVisibility("Public");

  const research = await findAgentCard("Research Agent");
  expect(within(agentList()).queryByText("Private Ops")).toBeNull();
  await userEvent.hover(within(research).getByText("Research Agent"));
  const creator = await screen.findByText("Created by Alice Admin");
  // The creator's profile image sits beside the attribution.
  expect(creator.parentElement?.querySelector("img")).toHaveAttribute(
    "src",
    aliceImage,
  );
  expect(screen.queryByText(managementFailure)).not.toBeInTheDocument();
});
