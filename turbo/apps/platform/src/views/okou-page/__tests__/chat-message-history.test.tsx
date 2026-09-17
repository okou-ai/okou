import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  context,
  findFastControl,
  installMessageExperienceChat,
} from "./chat-message-experience-test-helpers.ts";

const CREATED_AT = "2026-08-22T09:00:00.000Z";

test("A claimed queued message restores as the active run after refresh", async () => {
  const activeRunId = "d0000000-0000-4000-a000-000000000071";
  const queuedEventId = "queued-run-immediately-message";
  const prompt = "Run this message immediately";
  installMessageExperienceChat({
    threadId: context.resourceId,
    activeRunIds: [activeRunId],
    chatEvents: [
      {
        id: queuedEventId,
        role: "user",
        content: prompt,
        runId: undefined,
        createdAt: CREATED_AT,
      },
      {
        id: "claimed-run-immediately-message",
        role: "user",
        content: prompt,
        runId: activeRunId,
        revokesEventId: queuedEventId,
        createdAt: "2026-08-22T09:00:01.000Z",
      },
      {
        id: "active-run-thinking",
        role: "assistant",
        content: null,
        runId: activeRunId,
        thinking: "Working on the immediate request",
        createdAt: "2026-08-22T09:00:02.000Z",
      },
    ],
  });

  // The indicator reads its copy from the run's own thinking event only while
  // thread activity summaries are off, which is what this restored run asserts.
  await setupPage({
    context,
    path: `/chats/${context.resourceId}`,
    featureSwitches: { [FeatureSwitchKey.ThreadActivitySummary]: false },
  });

  const prompts = await screen.findAllByText(prompt);
  expect(prompts).toHaveLength(1);
  expect(screen.queryByLabelText("Queued message")).toBeNull();
  await expect(findFastControl("button", "Stop")).resolves.toBeVisible();
  await expect(
    screen.findByLabelText("Working on the immediate request"),
  ).resolves.toBeVisible();
});

test("A chat with no artifacts shows an empty artifact inbox", async () => {
  const runId = "d0000000-0000-4000-a000-000000000072";
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    expect(query.chatThreadId).toBe(context.resourceId);
    return respond(200, { artifacts: [], nextCursor: null });
  });
  installMessageExperienceChat({
    threadId: context.resourceId,
    chatEvents: [
      {
        id: "empty-artifact-user",
        role: "user",
        content: "Create the launch brief without files",
        runId,
        createdAt: CREATED_AT,
      },
      {
        id: "empty-artifact-assistant",
        role: "assistant",
        content: "The launch brief is complete.",
        runId,
        runLifecycleEvent: "completed",
        createdAt: "2026-08-22T09:00:03.000Z",
      },
    ],
  });

  await setupPage({ context, path: `/chats/${context.resourceId}` });

  await expect(
    screen.findByText("The launch brief is complete."),
  ).resolves.toBeVisible();
  click(await findFastControl("button", "Open artifacts"));
  await expect(screen.findByText("No artifacts found")).resolves.toBeVisible();
});

test("Show a migrated brief as ordinary chat history", async () => {
  const request = "Prepare my Morning Brief for the product launch";
  const result =
    "The launch is on schedule, with final creative review due Friday.";
  installMessageExperienceChat({
    threadId: context.resourceId,
    chatEvents: [
      {
        id: "migrated-brief-user",
        role: "user",
        content: request,
        createdAt: CREATED_AT,
      },
      {
        id: "migrated-brief-assistant",
        role: "assistant",
        content: result,
        runLifecycleEvent: "completed",
        createdAt: "2026-08-22T09:00:04.000Z",
      },
    ],
  });

  await setupPage({ context, path: `/chats/${context.resourceId}` });

  const requestElement = await screen.findByText(request);
  const resultElement = screen.getByText(result);
  expect(requestElement.closest('[data-role="user"]')).toBeVisible();
  expect(resultElement.closest('[data-role="assistant"]')).toBeVisible();
  const morningBriefOccurrences = screen.getAllByText(/Morning Brief/u);
  expect(morningBriefOccurrences).toStrictEqual([requestElement]);
  expect(
    document.querySelector(
      '[data-morning-brief], [aria-label="Morning Brief"]',
    ),
  ).toBeNull();
});
