import { act, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import { chatThreadByIdContract } from "@okouai/api-contracts/contracts/chat-threads";
import { setupPage, startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  continuityEventRow,
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";

const context = testContext();
const PROJECT_ID = "30000000-0000-4000-8000-000000000071";
const CREATED_AT = "2026-11-02T00:00:00.000Z";
const RECOVERY_NOTICE =
  "Finalizing the cancelled run before queued work continues.";

function fixture(message?: string) {
  const thread = continuityThread(121, 1, "Planning conversation");
  const workspace = installContinuityWorkspace(context, {
    caseId: 121,
    threads: [thread],
    chatEventRows: [
      ...(message
        ? [
            continuityEventRow(121, 1, thread.id, "input.prompt", {
              runId: crypto.randomUUID(),
              payload: {
                userMessage: {
                  version: 1,
                  parts: [{ type: "text", text: message }],
                },
              },
            }),
          ]
        : []),
      continuityEventRow(121, message ? 2 : 1, thread.id, "input.automation", {
        payload: {
          userMessage: {
            version: 1,
            parts: [
              {
                type: "automation",
                workflowName: "Launch follow-up",
                automationBrief: "Queued follow-up",
              },
            ],
          },
        },
      }),
    ],
  });
  let projectName: string | null = null;
  let projectSequence = 1;
  let recoveryPending = true;
  context.mocks.api(projectsContract.snapshot, ({ respond }) => {
    return respond(200, {
      projects: [
        {
          id: PROJECT_ID,
          name: "Launch",
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
        },
      ],
      latestEventId: null,
      latestSeqId: 1,
    });
  });
  context.mocks.api(projectsContract.events, ({ query, respond }) => {
    return respond(200, {
      events:
        projectName && query.sinceSeqId < projectSequence
          ? [
              {
                id: `30000000-0000-4000-8000-${projectSequence.toString().padStart(12, "0")}`,
                seqId: projectSequence,
                projectId: PROJECT_ID,
                kind: "renamed",
                name: projectName,
                createdAt: CREATED_AT,
              },
            ]
          : [],
      hasMore: false,
    });
  });
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: null,
      cancellationRecoveryPending: recoveryPending,
    });
  });
  return {
    thread,
    renameProject: (name: string) => {
      projectName = name;
      projectSequence += 1;
    },
    setRecoveryPending: (value: boolean) => {
      recoveryPending = value;
    },
    pageOptions: {
      ...workspace.pageOptions,
    },
  };
}

test.each(["home", "thread"] as const)(
  "%s startup shows Projects and follows realtime changes",
  async (route) => {
    const workspace = fixture();
    await setupPage({
      context,
      ...workspace.pageOptions,
      path: route === "home" ? "/" : `/chats/${workspace.thread.id}`,
    });
    expect(screen.getByText("Launch")).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Message" }),
    ).toBeInTheDocument();
    workspace.renameProject("Launch ready");
    context.mocks.ably.trigger("threadListChanged");
    await expect(
      screen.findByText("Launch ready"),
    ).resolves.toBeInTheDocument();
    workspace.renameProject("Launch confirmed");
    context.mocks.ably.trigger("threadListChanged");
    await expect(
      screen.findByText("Launch confirmed"),
    ).resolves.toBeInTheDocument();
  },
);

test("Thread detail remains live after its first subscribed read", async () => {
  const workspace = fixture();
  await setupPage({
    context,
    ...workspace.pageOptions,
    path: `/chats/${workspace.thread.id}`,
  });
  await expect(screen.findByText(RECOVERY_NOTICE)).resolves.toBeInTheDocument();
  workspace.setRecoveryPending(false);
  context.mocks.ably.trigger(`chatThreadDetailChanged:${workspace.thread.id}`);
  await waitFor(() => {
    expect(screen.queryByText(RECOVERY_NOTICE)).not.toBeInTheDocument();
  });
});

test("The first thread detail read includes changes made before realtime attaches", async () => {
  const workspace = fixture();
  workspace.setRecoveryPending(false);
  const attachment = context.mocks.ably.deferSubscribeOnChannel(
    "user:chat-list-user-321",
    `chatThreadDetailChanged:${workspace.thread.id}`,
  );
  const page = await startPage({
    context,
    ...workspace.pageOptions,
    path: `/chats/${workspace.thread.id}`,
  });
  await attachment.started;
  workspace.setRecoveryPending(true);
  attachment.attach();
  await page.ready;
  await expect(screen.findByText(RECOVERY_NOTICE)).resolves.toBeInTheDocument();
});

test("A realtime continuity gap refreshes thread detail without a notification", async () => {
  const workspace = fixture();
  await setupPage({
    context,
    ...workspace.pageOptions,
    path: `/chats/${workspace.thread.id}`,
  });
  await expect(screen.findByText(RECOVERY_NOTICE)).resolves.toBeInTheDocument();
  workspace.setRecoveryPending(false);
  act(() => {
    context.mocks.ably.triggerChannelGap("user:chat-list-user-321");
  });
  await waitFor(() => {
    expect(screen.queryByText(RECOVERY_NOTICE)).not.toBeInTheDocument();
  });
});

test("A private chat keeps its stored message while only its own detail event refreshes the recovery notice", async () => {
  const content = "Lighthouse crew ready";
  const workspace = fixture(content);
  await setupPage({
    context,
    ...workspace.pageOptions,
    path: "/chats/" + workspace.thread.id,
  });
  await screen.findByText(content);
  const notice = await screen.findByText(RECOVERY_NOTICE);
  const topic = "chatThreadDetailChanged:" + workspace.thread.id;
  const user = workspace.pageOptions.auth.user.id;
  workspace.setRecoveryPending(false);
  context.mocks.ably.triggerOnChannel("user:unrelated-member", topic, {});
  context.mocks.ably.triggerOnChannel("user:" + user, "newFeature:changed", {});
  workspace.renameProject("Survey project synchronized");
  context.mocks.ably.trigger("threadListChanged");
  await screen.findByText("Survey project synchronized");
  expect(notice).toBeVisible();
  context.mocks.ably.triggerOnChannel("user:" + user, topic, {});
  await waitFor(() => {
    return expect(notice).not.toBeInTheDocument();
  });
  await expect(screen.findByText(content)).resolves.toBeVisible();
});
