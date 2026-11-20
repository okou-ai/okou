import { browserAuthorizationRequestsContract } from "@okouai/api-contracts/contracts/browser";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockAuthorizationCallbackThread } from "./authorization-callback-test-helpers.ts";
import { createMessageExperienceHelpers } from "./chat-message-experience-test-helpers.ts";

const context = testContext();
const { installMessageExperienceChat } =
  createMessageExperienceHelpers(context);
const THREAD_ID = "b0000000-0000-4000-a000-000000000902";
const REQUEST_TOKEN = "vm0_browser_authorization_request_test";
const CALLBACK_PROMPT =
  "The cloud browser is enabled. Please continue the previous task.";
const CALLBACK_LINK = `https://app.okou.ai/browser/authorize/${REQUEST_TOKEN}?callbackPrompt=The%20cloud%20browser%20is%20enabled.%20Please%20continue%20the%20previous%20task.&threadId=${THREAD_ID}`;
const ASSISTANT_TEXT = "I need a cloud browser to check the dashboard.";
const UNAVAILABLE =
  "This cloud browser authorization link is invalid, expired, or not available for this workspace.";

interface RequestState {
  chatThreadId: string;
  completedAt: string | null;
}

function mockRequest(
  initial: RequestState,
  apply: () => Promise<"applied" | "forbidden"> = () => {
    return Promise.resolve("applied");
  },
): void {
  const server = { ...initial };
  context.mocks.api(browserAuthorizationRequestsContract.get, ({ respond }) => {
    return respond(200, {
      id: "a4000000-0000-4000-8000-000000000002",
      chatThreadId: server.chatThreadId,
      expiresAt: "2099-01-01T00:00:00.000Z",
      completedAt: server.completedAt,
      cloudBrowserEnabled: server.completedAt !== null,
    });
  });
  context.mocks.api(
    browserAuthorizationRequestsContract.apply,
    async ({ respond }) => {
      if ((await apply()) === "forbidden") {
        return respond(403, {
          error: { code: "FORBIDDEN", message: "Browser access denied" },
        });
      }
      server.completedAt = "2026-11-20T08:00:00.000Z";
      return respond(200, { ok: true, cloudBrowserEnabled: true });
    },
  );
}

async function openChat(link: string): Promise<void> {
  installMessageExperienceChat({
    threadId: THREAD_ID,
    chatEvents: [
      {
        id: "browser-request-message",
        role: "assistant",
        content: `${ASSISTANT_TEXT}\n\n${link}`,
        runId: "d0000000-0000-4000-a000-000000000902",
        seqId: 1,
        createdAt: "2026-11-20T07:59:00.000Z",
      },
    ],
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
  });
  await expect(screen.findByText(ASSISTANT_TEXT)).resolves.toBeInTheDocument();
}

function button(name: string): HTMLElement | undefined {
  return queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
}

async function findButtonNamed(name: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const found = button(name);
    if (!found) {
      throw new Error(`Expected the ${name} button`);
    }
    return found;
  });
}

test(`A user allows a browser request and continues from ${CALLBACK_LINK}`, async () => {
  const approval = context.mocks.deferred<void>();
  mockRequest({ chatThreadId: THREAD_ID, completedAt: null }, async () => {
    await approval.promise;
    return "applied";
  });
  mockAuthorizationCallbackThread(context, THREAD_ID);
  await openChat(CALLBACK_LINK);
  const allow = await findButtonNamed("Allow");
  await waitFor(() => {
    expect(allow).toBeEnabled();
  });

  click(allow);

  // The Allow action stays busy while authorization is pending.
  await waitFor(() => {
    expect(button("Allow")).toHaveAttribute("aria-busy", "true");
  });
  expect(button("Allow")).toHaveAttribute("aria-disabled", "true");
  // Meanwhile the task does not resume.
  expect(screen.queryByText(CALLBACK_PROMPT)).not.toBeInTheDocument();

  approval.resolve();

  await expect(screen.findByText(CALLBACK_PROMPT)).resolves.toBeInTheDocument();
  await expect(findButtonNamed("Allowed")).resolves.toBeDisabled();
  expect(screen.getByText(ASSISTANT_TEXT)).toBeInTheDocument();
});

test("Failed authorization leaves the task paused", async () => {
  mockRequest({ chatThreadId: THREAD_ID, completedAt: null }, () => {
    return Promise.resolve("forbidden");
  });
  // A continuation would be deliverable, so its absence is meaningful.
  mockAuthorizationCallbackThread(context, THREAD_ID);
  await openChat(CALLBACK_LINK);
  const allow = await findButtonNamed("Allow");
  await waitFor(() => {
    expect(allow).toBeEnabled();
  });

  click(allow);

  await expect(
    screen.findByText("Couldn't continue."),
  ).resolves.toBeInTheDocument();
  await expect(findButtonNamed("Allow")).resolves.toBeEnabled();
  expect(screen.queryByText(CALLBACK_PROMPT)).not.toBeInTheDocument();
});

test("A request from another chat cannot enable a browser or continue this task", async () => {
  mockRequest({
    chatThreadId: "b0000000-0000-4000-a000-000000000903",
    completedAt: null,
  });

  await openChat(`https://app.okou.ai/browser/authorize/${REQUEST_TOKEN}`);

  await expect(screen.findByText(UNAVAILABLE)).resolves.toBeInTheDocument();
  expect(button("Allow")).toBeUndefined();
});

test("Completed requests stay allowed when the chat is reopened", async () => {
  mockRequest({
    chatThreadId: THREAD_ID,
    completedAt: "2026-11-20T07:30:00.000Z",
  });
  mockAuthorizationCallbackThread(context, THREAD_ID);

  await openChat(CALLBACK_LINK);

  await expect(findButtonNamed("Allowed")).resolves.toBeDisabled();
  expect(button("Allow")).toBeUndefined();
  // Reopening a completed request does not resume the task again.
  expect(screen.queryByText(CALLBACK_PROMPT)).not.toBeInTheDocument();
});
