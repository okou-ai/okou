// @vitest-environment-options {"url":"https://app.okou.ai"}
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { RUN_PATH, RUN_THREAD_ID } from "./chat-run-test-fixtures.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

// @vitest-environment-options {"url":"https://app.okou.ai"}

const context = testContext();

test("chat-engagement-telemetry-002 expanding the completed twenty-second history reports its status", async () => {
  const analytics = context.mocks.posthog();
  const runId = "f82f0aba-40a8-4f18-891e-1a9d5525f804";
  mockChatLifecycle(context, {
    threadId: RUN_THREAD_ID,
    chatEvents: [
      {
        role: "user",
        runId,
        content: "Review the milestones",
        createdAt: "2026-10-01T10:00:00Z",
      },
      {
        role: "assistant",
        runId,
        content: "Checking the milestones",
        createdAt: "2026-10-01T10:00:05Z",
      },
      {
        role: "assistant",
        runId,
        content: "Review complete",
        runLifecycleEvent: "completed",
        createdAt: "2026-10-01T10:00:20Z",
      },
    ],
  });
  await setupPage({ context, host: "app.okou.ai", path: RUN_PATH });
  await screen.findByText("Review complete");
  const toggle = await findFastControl("button", "Expand work history");
  expect(toggle).toHaveTextContent(/20s|20 sec/);
  expect(screen.queryByText("Checking the milestones")).toBeNull();
  click(toggle);
  await screen.findByText("Checking the milestones");
  expect(
    analytics.events
      .filter((e) => {
        return e.name === "chat_work_history_expanded";
      })
      .map((e) => {
        return e.properties;
      }),
  ).toStrictEqual([expect.objectContaining({ work_status: "completed" })]);
});
test("chat-engagement-telemetry-003 row impressions and selections retain each recommendation's kind and position", async () => {
  const analytics = context.mocks.posthog();
  const runId = "d0000000-0000-4000-a000-000000076901";
  const followups = [
    {
      kind: "generate" as const,
      prompt: "Draft the presentation",
      generationType: "presentation" as const,
    },
    { kind: "workflow" as const, prompt: "Automate the report" },
    { kind: "email" as const, prompt: "Mail the summary" },
  ];
  mockChatLifecycle(context, {
    threadId: RUN_THREAD_ID,
    chatEvents: [
      {
        role: "user",
        runId,
        content: "Review options",
        createdAt: "2026-10-01T10:00:00Z",
      },
      {
        role: "assistant",
        runId,
        content: "Three next steps",
        followups,
        runLifecycleEvent: "completed",
        createdAt: "2026-10-01T10:00:20Z",
      },
    ],
  });
  await setupPage({ context, host: "app.okou.ai", path: RUN_PATH });
  const order = [0, 1, 2, 1];
  for (const i of order) {
    click(await findFastControl("button", new RegExp(followups[i]!.prompt)));
  }
  const shown = analytics.events
    .filter((e) => {
      return e.name === "chat_recommended_followups_shown";
    })
    .map((e) => {
      return e.properties;
    });
  expect(shown).toStrictEqual([
    expect.objectContaining({
      followup_layout: "rows",
      followup_count: 3,
      workflow_followup_count: 1,
      email_followup_count: 1,
      followup_kinds: ["generate", "workflow", "email"],
      generation_types: ["presentation"],
    }),
  ]);
  expect(
    analytics.events
      .filter((e) => {
        return e.name === "chat_recommended_followup_selected";
      })
      .map((e) => {
        return [
          e.properties?.followup_index,
          e.properties?.followup_kind,
          e.properties?.generation_type,
        ];
      }),
  ).toStrictEqual(
    order.map((i) => {
      return [i, followups[i]!.kind, i === 0 ? "presentation" : undefined];
    }),
  );
});
