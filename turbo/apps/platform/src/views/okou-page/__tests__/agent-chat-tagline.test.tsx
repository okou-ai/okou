import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000002";
const NOW = Date.parse("2026-09-20T12:00:00.000Z");

function mountedAgent(): void {
  context.mocks.data.agents([
    {
      agentId: AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Nova",
      description: null,
      sound: null,
      avatarUrl: null,
      visibility: "public",
    },
  ]);
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
  mountedAgent();
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
  mountedAgent();
  context.mocks.browser.matchMedia((query) => {
    return query === "(prefers-reduced-motion: reduce)";
  });
  mockNow(NOW, context.signal);

  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });

  const { tagline, fullLine, typed } = await greeting();
  expect(typed.textContent).toBe(fullLine);
  expect(tagline).toHaveAccessibleName(fullLine);
});
