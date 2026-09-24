import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
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

test("Match model-provider recovery guidance to the failure", async () => {
  installProviderFailure(
    "No model provider configured. Configure a model provider to start running agents.",
  );

  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });

  await readyChat();
  const card = await screen.findByRole("status");
  expect(card).toHaveTextContent("No model provider configured yet.");
  const configureProvider = await findButton(
    "Set one up in Workspace Settings",
  );
  expect(card).toContainElement(configureProvider);
  click(configureProvider);

  const settings = await screen.findByRole("dialog", { name: "Settings" });
  expect(settings).toBeVisible();
  await expect(
    screen.findByRole("heading", { name: "Models" }),
  ).resolves.toBeVisible();
});
