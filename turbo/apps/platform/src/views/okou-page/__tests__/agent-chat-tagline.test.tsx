import {
  agentsByIdContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../sidebar-breakpoint.ts";

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

test("The greeting renders its complete sentence and staggers one word at a time", async () => {
  mountedAgent([AGENT_ID]);
  context.mocks.browser.matchMedia(false);

  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });

  const { tagline, fullLine, text } = await greeting();
  // The line is complete from the first frame: the entrance changes each
  // word's own ink, never the sentence that is laid out.
  expect(text.textContent).toBe(fullLine);
  expect(tagline).toHaveAccessibleName(fullLine);

  const words = fullLine.split(" ");
  const wordBoxes = tokens(text);
  expect(
    wordBoxes.map((box) => {
      return box.textContent;
    }),
  ).toEqual(words);
  expect(
    wordBoxes.map((box) => {
      return box.style.animationDelay;
    }),
  ).toEqual(
    words.map((_word, index) => {
      return `${String((index + 1) * 70)}ms`;
    }),
  );
});

test("The avatar leads the sentence with the same entrance and no delay", async () => {
  mountedAgent([AGENT_ID]);
  context.mocks.browser.matchMedia(false);

  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });

  const row = await screen.findByTestId("chat-greeting");
  const avatarBox = row.querySelector('[data-slot="chat-greeting-avatar"]');
  if (!(avatarBox instanceof HTMLElement)) {
    throw new Error("Expected the avatar to lead the greeting row");
  }
  expect(row.firstElementChild).toBe(avatarBox);
  expect(avatarBox.className).toContain(
    "motion-safe:animate-chat-greeting-token",
  );
  expect(avatarBox.style.animationDelay).toBe("");
});

test("Reduced motion shows the complete greeting immediately", async () => {
  mountedAgent([AGENT_ID]);
  context.mocks.browser.matchMedia((query) => {
    return query === "(prefers-reduced-motion: reduce)";
  });

  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });

  const { tagline, fullLine, text } = await greeting();
  expect(text.textContent).toBe(fullLine);
  expect(tagline).toHaveAccessibleName(fullLine);
});

test("Switching agents starts a fresh greeting", async () => {
  const otherAgentId = "c0000000-0000-4000-a000-000000000003";
  mountedAgent([AGENT_ID, otherAgentId]);
  context.mocks.data.userPreferences({ pinnedAgentIds: [otherAgentId] });
  context.mocks.browser.matchMedia((query) => {
    return query === SIDEBAR_DESKTOP_MEDIA_QUERY;
  });

  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });

  const previous = await greeting();
  expect(previous.text.textContent).toBe(previous.fullLine);

  const pinnedAgents = await screen.findByTestId("pinned-agents-grid");
  const otherAgent = queryAllByRoleFast("link", pinnedAgents).find((link) => {
    return link.textContent?.trim() === "Orion";
  });
  if (!otherAgent) {
    throw new Error("Expected the pinned Orion agent");
  }

  click(otherAgent);
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/agents/${otherAgentId}/chat`);
    expect(screen.getByLabelText("View agent profile")).toHaveAttribute(
      "href",
      `/agents/${otherAgentId}`,
    );
  });

  const current = await greeting();
  expect(current.text.textContent).toBe(current.fullLine);
  expect(current.tagline).toHaveAccessibleName(current.fullLine);
  expect(tokens(current.text).length).toBe(current.fullLine.split(" ").length);
});
