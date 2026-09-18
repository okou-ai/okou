import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  assistantEvent,
  installRunChat,
  promptEvent,
  publishRunUpdate,
  thinkingEvent,
} from "./chat-run-test-fixtures.ts";
import {
  context,
  readyChat,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";

const ACTIVE_RUN_ID = "d0000000-0000-4000-a000-000000000841";

function activeRunEvents(): MockChatEventInput[] {
  return [
    promptEvent({
      id: "thinking-capability-prompt",
      runId: ACTIVE_RUN_ID,
      seqId: 1,
      text: "Prepare the current answer",
    }),
  ];
}

test("Keep current thinking progress aligned with the active run", async () => {
  const events = activeRunEvents();
  installRunChat({ chatEvents: events, activeRunIds: [ACTIVE_RUN_ID] });

  // Progress comes from the run's own thinking events only while thread
  // activity summaries are off, which is the producer this test tracks.
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.ThreadActivitySummary]: false },
  });

  await readyChat();
  events.push(
    thinkingEvent({
      id: "thinking-capability-current",
      runId: ACTIVE_RUN_ID,
      seqId: 2,
      text: "Checking the current release evidence",
    }),
  );
  publishRunUpdate();

  const currentProgress = await screen.findByLabelText(
    "Checking the current release evidence",
  );
  expect(currentProgress).toBeVisible();

  events.push(
    assistantEvent({
      id: "thinking-capability-answer",
      runId: ACTIVE_RUN_ID,
      seqId: 3,
      text: "The current release evidence is complete.",
    }),
  );
  publishRunUpdate();

  const answer = await screen.findByText(
    "The current release evidence is complete.",
  );
  expect(answer).toBeVisible();
  await waitFor(() => {
    expect(
      screen.queryByLabelText("Checking the current release evidence"),
    ).not.toBeInTheDocument();
  });
});
