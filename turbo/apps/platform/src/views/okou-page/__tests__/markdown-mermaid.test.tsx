import { sessionOutputChannelName } from "@okouai/api-contracts/contracts/realtime";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createMarkdownChatFixture } from "./markdown-page-test-helpers.ts";

const context = testContext();
const flow = "```mermaid\nflowchart LR\n  Draft --> Review\n```";
const sequence = "```mermaid\nsequenceDiagram\n Alice->>Bob: Approve";
test("markdown-mermaid-003 closing the live fence replaces readable source with an expandable diagram", async () => {
  const chat = createMarkdownChatFixture(context),
    runId = crypto.randomUUID(),
    eventId = crypto.randomUUID();
  const prompt = chat.inputPrompt("Diagram the handoff", { seqId: 1, runId });
  chat.install({
    rows: () => {
      return [prompt];
    },
  });
  const channel = sessionOutputChannelName(
    "test-user-123",
    "org_default",
    runId,
  );

  await setupPage({ context, path: chat.path });
  await screen.findByText("Diagram the handoff");
  await waitFor(() => {
    return expect(
      context.mocks.ably.hasSubscriptionOnChannel(channel, runId),
    ).toBeTruthy();
  });
  const chunk = (chunkIndex: number, delta: string) => {
    return context.mocks.ably.triggerOnChannel(channel, runId, {
      runId,
      eventId,
      threadId: chat.threadId,
      runEventId: "diagram-message",
      createdAt: prompt.createdAt,
      chunkIndex,
      delta,
    });
  };
  chunk(0, flow + "\n\n" + sequence);
  await expect(
    screen.findByRole("img", { name: "Diagram" }),
  ).resolves.toBeVisible();
  const partial = await waitFor(() => {
    const code = [...document.querySelectorAll("pre code")].find((node) => {
      return (
        node.textContent?.includes("Alice->>Bob: Approve") &&
        !node.closest("details")
      );
    });
    expect(code).toBeVisible();
    return code;
  });
  expect(screen.getAllByLabelText("Expand diagram")).toHaveLength(1);
  chunk(1, "\n```");
  await waitFor(() => {
    return expect(screen.getAllByRole("img", { name: "Diagram" })).toHaveLength(
      2,
    );
  });
  expect(partial).not.toBeVisible();
  expect(screen.getAllByLabelText("Expand diagram")).toHaveLength(2);
});
