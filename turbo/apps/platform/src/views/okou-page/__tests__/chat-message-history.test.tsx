import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createMessageExperienceHelpers,
  findFastControl,
} from "./chat-message-experience-test-helpers.ts";

const context = testContext();
const { installMessageExperienceChat } =
  createMessageExperienceHelpers(context);

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
    ],
  });

  await setupPage({ context, path: `/chats/${context.resourceId}` });

  await expect(findFastControl("button", "Stop")).resolves.toBeVisible();
  await expect(screen.findByText("Thinking...")).resolves.toBeVisible();
  expect(screen.getAllByText(prompt)).toHaveLength(1);
  expect(screen.queryByLabelText("Queued message")).toBeNull();
});

test("A chat with no artifacts shows an empty resources panel", async () => {
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

  click(await findFastControl("button", "Artifacts and chats"));

  await expect(
    screen.findByText("No artifacts yet"),
  ).resolves.toBeInTheDocument();
});
