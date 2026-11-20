import { avatarComposerUrl } from "@okouai/core/agent-avatar";
import {
  agentsByIdContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
const context = testContext();
const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const AVATAR = {
  face: "round",
  hair: "geometric-long",
  expression: "neutral-smile",
  skin: "gold",
  hairColor: "black",
  sweater: "blue",
} as const;

test("Greet with Okou's own animated avatar under My Okou", async () => {
  // My Okou draws Okou on the home greeting whatever the default agent's own
  // avatar is, through the shared avatar: textured, framed, and moving.
  const agent: AgentResponse = {
    agentId: DEFAULT_AGENT_ID,
    isDefaultAgent: true,
    ownerId: "test-user-123",
    displayName: "Okou",
    description: null,
    sound: null,
    avatarUrl: avatarComposerUrl(AVATAR),
    visibility: "public",
  };
  context.mocks.data.agents([agent]);
  context.mocks.api(agentsByIdContract.get, ({ respond }) => {
    return respond(200, agent);
  });
  context.mocks.browser.matchMedia(false);
  await setupPage({
    context,
    path: `/agents/${DEFAULT_AGENT_ID}/chat?compose=1`,
  });
  const greeting = await screen.findByTestId("chat-greeting");

  const avatar = greeting.querySelector("[data-okou-avatar]");
  expect(avatar).toHaveAttribute("data-okou-avatar", "animated");
});
