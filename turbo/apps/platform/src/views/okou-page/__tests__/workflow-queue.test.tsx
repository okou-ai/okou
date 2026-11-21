import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createChatRunFixtures,
  promptEvent,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";
import { findAction } from "./connector-integrations-test-helpers.ts";

const context = testContext();

function pending(title: string, seqId: number) {
  return {
    ...promptEvent({ id: crypto.randomUUID(), seqId, text: title }),
    eventType: "input.automation" as const,
    userMessage: {
      version: 1 as const,
      parts: [
        {
          type: "automation" as const,
          workflowName: "ops",
          automationBrief: title,
        },
      ],
    },
  };
}

test("workflow-queue-001 the transcript and ordered automation queue keep their own messages", async () => {
  const runId = crypto.randomUUID();
  createChatRunFixtures(context).installRunChat({
    chatEvents: [
      promptEvent({
        id: crypto.randomUUID(),
        runId,
        seqId: 1,
        text: "Start the handover",
      }),
      promptEvent({
        id: crypto.randomUUID(),
        runId,
        seqId: 2,
        text: "Include the financials",
      }),
      pending("Validate ledger", 3),
      pending("Send handover", 4),
    ],
  });
  await setupPage({ context, path: RUN_PATH });
  const jobs = await screen.findAllByLabelText("Pending automation event");
  expect(
    jobs.map((el) => {
      return el.textContent;
    }),
  ).toStrictEqual(["Validate ledger", "Send handover"]);
  for (const title of ["Start the handover", "Include the financials"]) {
    await expect(screen.findByText(title)).resolves.toBeVisible();
  }
  for (const name of ["Validate ledger", "Send handover"]) {
    expect(screen.getAllByText(name)).toHaveLength(1);
  }
});

test("workflow-queue-003 skipping the deployment check revokes its own event and keeps the digest", async () => {
  const target = pending("Check deployment", 2),
    digest = pending("Publish digest", 3);
  const revoked = context.mocks.deferred<string>();
  createChatRunFixtures(context).installRunChat({
    chatEvents: [
      promptEvent({
        id: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        seqId: 1,
        text: "Start operations",
      }),
      target,
      digest,
    ],
    onRecallEventAppend: (body) => {
      return revoked.resolve(body.revokesEventId);
    },
  });
  await setupPage({ context, path: RUN_PATH });
  const label = await screen.findByText("Check deployment");
  const row = label.closest('[role="listitem"]');
  if (!row) {
    throw new Error("Missing pending event");
  }
  click(await findAction("button", "Skip automation event", row));
  await expect(revoked.promise).resolves.toBe(target.id);
  await waitFor(() => {
    return expect(screen.queryByText("Check deployment")).toBeNull();
  });
  expect(screen.getByText("Publish digest")).toBeVisible();
});
