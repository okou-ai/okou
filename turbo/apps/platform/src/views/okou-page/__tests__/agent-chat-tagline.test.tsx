import {
  agentsByIdContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000002";

function mountedAgent(agentIds: string[]): void {
  const agents = agentIds.map((agentId): AgentResponse => {
    return {
      agentId,
      isDefaultAgent: false,
      ownerId: "test-user-123",
      displayName: agentId === AGENT_ID ? "Nova" : "Orion",
      description: null,
      sound: null,
      avatarUrl: null,
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
      visibility: "public",
    };
  });
  context.mocks.data.agents(agents);
  context.mocks.api(agentsByIdContract.get, ({ params, respond }) => {
    const agent = agents.find((candidate) => {
      return candidate.agentId === params.id;
    });
    if (!agent) {
      throw new Error(`Unexpected agent requested: ${params.id}`);
    }
    return respond(200, agent);
  });
}

async function greeting() {
  const tagline = await screen.findByTestId("chat-tagline");
  const fullLine = tagline.getAttribute("aria-label");
  const text = tagline.querySelector('[data-slot="chat-tagline-text"]');
  if (!fullLine || !text) {
    throw new Error("Expected the greeting and its displayed text");
  }
  return { tagline, fullLine, text };
}

/** Every word box that carries the entrance, in reading order. */
function tokens(text: Element): HTMLElement[] {
  return Array.from(
    text.querySelectorAll<HTMLElement>('[data-slot="chat-tagline-word"]'),
  );
}

test("The greeting shows its complete sentence, one box per word", async () => {
  mountedAgent([AGENT_ID]);
  context.mocks.browser.matchMedia(false);

  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });

  const { tagline, fullLine, text } = await greeting();
  // The sentence is complete from the first frame. Each word arrives on its
  // own, so a reader never sees a partial line and the row it sits in never
  // has to move; how a word arrives is a stylesheet decision, and the deployed
  // greeting test owns it.
  expect(text.textContent).toBe(fullLine);
  expect(tagline).toHaveAccessibleName(fullLine);
  expect(
    tokens(text).map((box) => {
      return box.textContent;
    }),
  ).toStrictEqual(fullLine.split(" "));
});

test("The avatar leads the sentence", async () => {
  mountedAgent([AGENT_ID]);
  context.mocks.browser.matchMedia(false);

  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });

  const row = await screen.findByTestId("chat-greeting");
  const avatarBox = row.querySelector('[data-slot="chat-greeting-avatar"]');
  const tagline = await screen.findByTestId("chat-tagline");
  if (!avatarBox) {
    throw new Error("Expected the avatar to lead the greeting row");
  }
  expect(row.firstElementChild).toBe(avatarBox);
  expect(
    avatarBox.compareDocumentPosition(tagline) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});
