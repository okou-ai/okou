import { sessionOutputChannelName } from "@okouai/api-contracts/contracts/realtime";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import {
  completedMarkdownReply,
  createMarkdownChatFixture,
} from "./markdown-page-test-helpers.ts";

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

test("markdown-mermaid-001 A finished diagram opens from its inline image and returns to both sources", async () => {
  const path = completedMarkdownReply(
    context,
    [flow, sequence + "\n```"].join("\n\n"),
  );
  await setupPage({ context, path });
  await waitFor(() =>
    {return expect(screen.getAllByLabelText("Expand diagram")).toHaveLength(2)},
  );
  click(screen.getAllByLabelText("Expand diagram")[0]!);
  const preview = await screen.findByRole("dialog", {
    name: "diagram.svg preview",
  });
  click(await findFastControl("button", "Open in split view", preview));
  const close = await findFastControl("button", "Close artifact");
  const side = screen.getByTestId("artifact-sidebar");
  const image = await within(side).findByRole("img");
  const url = image.getAttribute("src");
  expect(url).toMatch(/^blob:/);
  const revoked = vi.spyOn(URL, "revokeObjectURL");
  click(close);
  await waitFor(() => {return expect(revoked).toHaveBeenCalledWith(url)});
  expect(side).not.toBeInTheDocument();
  const diagrams = screen.getAllByRole("img", { name: "Diagram" });
  expect(diagrams).toHaveLength(2);
  const sources = screen.getAllByText("Diagram source");
  expect(sources).toHaveLength(2);
  for (const element of [...diagrams, ...sources]) {
    expect(element).toBeVisible();
  }
});
