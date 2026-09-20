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
import { mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../sidebar-breakpoint.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000002";
const NOW = Date.parse("2026-09-20T12:00:00.000Z");

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
  const typed = tagline.querySelector('[data-slot="chat-tagline-text"]');
  if (!fullLine || !typed) {
    throw new Error("Expected the greeting and its displayed text");
  }
  return { tagline, fullLine, typed };
}

test("The greeting pauses before revealing its text and keeps its accessible name", async () => {
  mountedAgent([AGENT_ID]);
  context.mocks.browser.matchMedia(false);
  mockNow(NOW, context.signal);

  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });

  const { tagline, fullLine, typed } = await greeting();
  expect(typed).toBeEmptyDOMElement();
  expect(tagline).toHaveAccessibleName(fullLine);

  mockNow(NOW + 745, context.signal);
  await waitFor(() => {
    const prefix = typed.textContent ?? "";
    expect(prefix.length).toBeGreaterThan(0);
    expect(prefix.length).toBeLessThan(fullLine.length);
    expect(fullLine.startsWith(prefix)).toBeTruthy();
  });
  expect(tagline).toHaveAccessibleName(fullLine);

  mockNow(NOW + 1270, context.signal);
  await waitFor(() => {
    expect(typed.textContent).toBe(fullLine);
  });
  expect(tagline).toHaveAccessibleName(fullLine);
});

test("Reduced motion shows the complete greeting immediately", async () => {
  mountedAgent([AGENT_ID]);
  context.mocks.browser.matchMedia((query) => {
    return query === "(prefers-reduced-motion: reduce)";
  });
  mockNow(NOW, context.signal);

  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });

  const { tagline, fullLine, typed } = await greeting();
  expect(typed.textContent).toBe(fullLine);
  expect(tagline).toHaveAccessibleName(fullLine);
});

test("Switching agents starts a fresh greeting after the previous one finished", async () => {
  const otherAgentId = "c0000000-0000-4000-a000-000000000003";
  mountedAgent([AGENT_ID, otherAgentId]);
  context.mocks.data.userPreferences({ pinnedAgentIds: [otherAgentId] });
  context.mocks.browser.matchMedia((query) => {
    return query === SIDEBAR_DESKTOP_MEDIA_QUERY;
  });
  mockNow(NOW, context.signal);

  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });

  const previous = await greeting();
  mockNow(NOW + 1270, context.signal);
  await waitFor(() => {
    expect(previous.typed.textContent).toBe(previous.fullLine);
  });
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
  expect(current.typed).toBeEmptyDOMElement();

  mockNow(NOW + 2015, context.signal);
  await waitFor(() => {
    const prefix = current.typed.textContent ?? "";
    expect(prefix.length).toBeGreaterThan(0);
    expect(prefix.length).toBeLessThan(current.fullLine.length);
    expect(current.fullLine.startsWith(prefix)).toBeTruthy();
  });
  mockNow(NOW + 2540, context.signal);
  await waitFor(() => {
    expect(current.typed.textContent).toBe(current.fullLine);
  });
  expect(current.tagline).toHaveAccessibleName(current.fullLine);
});
