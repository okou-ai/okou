import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  context,
  findButton,
  FIRST_CAPABILITY_RUN_ID,
  installCapabilityChat,
  readyChat,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";
import { promptEvent } from "./chat-run-test-fixtures.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";

function installProviderFailure(error: string): void {
  const events: MockChatEventInput[] = [
    promptEvent({
      id: "provider-failure-user",
      runId: FIRST_CAPABILITY_RUN_ID,
      seqId: 1,
      text: "Continue this conversation",
    }),
    {
      id: "provider-failure-assistant",
      eventType: "output.error",
      content: null,
      createdAt: "2026-08-01T10:00:02.000Z",
      error,
      runId: FIRST_CAPABILITY_RUN_ID,
      seqId: 2,
    },
  ];
  installCapabilityChat({ events });
}

function normalizedText(element: HTMLElement): string {
  return element.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}

function findLink(name: string): Promise<HTMLElement> {
  return waitFor(() => {
    const link = queryAllByRoleFast("link").find((candidate) => {
      return (
        candidate.getAttribute("aria-label") === name ||
        normalizedText(candidate) === name
      );
    });
    if (!link) {
      throw new Error(`${name} link was not visible`);
    }
    return link;
  });
}

test("Match model-provider recovery guidance to the failure", async () => {
  installProviderFailure(
    "No model provider configured. Configure a model provider to start running agents.",
  );

  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });

  await readyChat();
  const card = await screen.findByTestId("assistant-error-card-shell");
  expect(card).toHaveTextContent("No model provider configured yet.");
  const configureProvider = await findButton(
    "Set one up in Workspace Settings",
  );
  click(configureProvider);

  const settings = await screen.findByRole("dialog", { name: "Settings" });
  expect(settings).toBeVisible();
  await expect(
    screen.findByRole("heading", { name: "Models" }),
  ).resolves.toBeVisible();
});

test("Start a compatible session after a model-provider mismatch", async () => {
  installProviderFailure(
    "Provider not compatible. This session was created with a different provider type.",
  );

  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });

  await readyChat();
  await expect(
    screen.findByText(
      "This session was started with a different model provider and can't be continued with the current one.",
    ),
  ).resolves.toBeVisible();
  await expect(findLink("Start a new session")).resolves.toHaveAttribute(
    "href",
    "/",
  );
});

test("Start a new conversation after a model provider disappears", async () => {
  installProviderFailure(
    "Model provider unavailable. The model provider used by this thread has been deleted.",
  );

  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });

  await readyChat();
  const card = await screen.findByTestId("assistant-error-card-shell");
  expect(card).toHaveTextContent(
    "The model provider used by this thread has been deleted.",
  );
  const startNewChat = await findLink("Start a new chat thread");
  expect(startNewChat).toHaveAttribute("href", "/");
});
