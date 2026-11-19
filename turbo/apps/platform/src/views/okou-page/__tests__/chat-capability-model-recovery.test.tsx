import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createChatCapabilityHelpers,
  FIRST_CAPABILITY_RUN_ID,
  findButton,
  readyChat,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";
import { promptEvent } from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installCapabilityChat } = createChatCapabilityHelpers(context);

test("Match model-provider recovery guidance to the failure", async () => {
  installCapabilityChat({
    events: [
      promptEvent({
        id: "model-recovery-user",
        runId: FIRST_CAPABILITY_RUN_ID,
        seqId: 1,
        text: "Summarize the launch notes",
      }),
      {
        id: "model-recovery-error",
        role: "assistant",
        eventType: "output.error",
        content: null,
        error:
          "No model provider is available for this run. Try again shortly, or connect a personal Claude Code or Codex subscription in Settings.",
        runId: FIRST_CAPABILITY_RUN_ID,
        seqId: 2,
        createdAt: "2026-08-01T10:00:02.000Z",
      },
      {
        id: "model-recovery-failed",
        role: "assistant",
        content: null,
        runId: FIRST_CAPABILITY_RUN_ID,
        runLifecycleEvent: "failed",
        seqId: 3,
        createdAt: "2026-08-01T10:00:03.000Z",
      },
    ],
  });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();

  await expect(
    screen.findByText(
      "No model provider is available for this run. Connect a personal subscription.",
    ),
  ).resolves.toBeVisible();
  click(await findButton("Manage subscriptions"));

  const settings = await screen.findByRole("dialog", { name: "Settings" });
  await expect(
    screen.findByRole("heading", { name: "Use more models" }),
  ).resolves.toBeVisible();
  expect(settings).toContainElement(
    screen.getByRole("heading", { name: "Use more models" }),
  );
});
