import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createChatRunFixtures,
  findEnabledButton,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
test("chat-capability-model-recovery-001 opens model subscription settings from a failed chat", async () => {
  createChatRunFixtures(context).installRunChat({
    chatEvents: [
      {
        role: "user",
        content: "Review the launch outline",
        runId: "870a4aa7-6d56-4caf-b571-322f54b59e65",
        createdAt: "2026-09-20T08:00:00Z",
      },
      {
        role: "assistant",
        content: null,
        error: "No model provider is available for this run",
        runId: "870a4aa7-6d56-4caf-b571-322f54b59e65",
        createdAt: "2026-09-20T08:00:03Z",
      },
      {
        role: "assistant",
        content: null,
        runLifecycleEvent: "failed",
        runId: "870a4aa7-6d56-4caf-b571-322f54b59e65",
        createdAt: "2026-09-20T08:00:04Z",
      },
    ],
  });
  await setupPage({ context, path: RUN_PATH });
  await screen.findByText(/connect a personal subscription/i);
  click(await findEnabledButton("Manage subscriptions"));
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  await expect(
    within(settings).findByRole("heading", { name: "Use more models" }),
  ).resolves.toBeInTheDocument();
});
