import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  assistantEvent,
  createChatRunFixtures,
  readyChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);
const PROJECT_ID = "f0000000-0000-4000-a000-000000000e31";
const RUN_ID = "d0000000-0000-4000-a000-000000000e31";

test("future Project references remain readable in a restored conversation and feedback", async () => {
  const project = {
    type: "project" as const,
    projectId: PROJECT_ID,
    nameSnapshot: "Original launch",
  };
  installRunChat({
    chatEvents: [
      {
        id: "project-request",
        role: "user",
        content: "Plan from Original launch",
        runId: RUN_ID,
        seqId: 1,
        createdAt: "2026-11-21T10:00:00.000Z",
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: "Plan from " },
            project,
            {
              type: "feedback",
              quote: "Check the schedule",
              note: [{ type: "text", text: "Compare with " }, project],
            },
          ],
        },
      },
      assistantEvent({
        id: "project-answer",
        runId: RUN_ID,
        seqId: 2,
        text: "The schedule is on track.",
      }),
    ],
  });

  await setupPage({ context, path: RUN_PATH });
  await readyChat();

  const message = (
    await screen.findByText("Check the schedule", {
      selector: "[data-role='user'] *",
    })
  ).closest<HTMLElement>("[data-role='user']") as HTMLElement;
  const references = [...message.querySelectorAll("a")].filter((link) => {
    return link.textContent?.trim() === "Original launch";
  });
  expect(references.length).toBeGreaterThan(0);
  for (const reference of references) {
    expect(reference).toHaveAttribute("href", `/projects/${PROJECT_ID}`);
  }
});
