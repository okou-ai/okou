import type { ChatFollowupOrigin } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  context,
  findComposer,
  findFastControl,
  installMessageExperienceChat,
  MESSAGE_EXPERIENCE_AGENT_ID,
} from "./chat-message-experience-test-helpers.ts";

const FOLLOWUP_EVENT_ID = "e0000000-0000-4000-a000-000000000071";
const RUN_ID = "d0000000-0000-4000-a000-000000000071";
const OTHER_THREAD_ID = "b0000000-0000-4000-a000-000000000072";
const FIRST_PROMPT = "Create a presentation outline";
const SECOND_PROMPT = "Compare the launch options";
const CREATED_AT = "2026-08-21T14:00:00.000Z";

interface SentMessage {
  readonly prompt: string;
  readonly followupOrigins?: ChatFollowupOrigin[];
}

function followupReply(): MockChatEventInput[] {
  return [
    {
      id: "followup-input",
      role: "user",
      content: "Review the launch plan",
      runId: RUN_ID,
      createdAt: CREATED_AT,
    },
    {
      id: "followup-reply",
      role: "assistant",
      content: "The launch plan is ready.",
      runId: RUN_ID,
      runLifecycleEvent: "completed",
      createdAt: "2026-08-21T14:00:05.000Z",
    },
    {
      id: FOLLOWUP_EVENT_ID,
      role: "assistant",
      eventType: "output.followups",
      runId: RUN_ID,
      content: JSON.stringify({
        version: 1,
        followups: [
          { prompt: FIRST_PROMPT, kind: "talk" },
          { prompt: SECOND_PROMPT, kind: "talk" },
        ],
      }),
      createdAt: "2026-08-21T14:00:06.000Z",
    },
  ];
}

async function openFollowups(enabled = true) {
  const onSendRequest = vi.fn<(body: SentMessage) => void>();
  const control = installMessageExperienceChat({
    threadId: context.resourceId,
    threadTitle: "Launch conversation",
    chatEvents: followupReply(),
    onSendRequest,
  });
  control.setThreadList([
    {
      id: context.resourceId,
      title: "Launch conversation",
      agent: { id: MESSAGE_EXPERIENCE_AGENT_ID, avatarUrl: null },
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    {
      id: OTHER_THREAD_ID,
      title: "Other conversation",
      agent: { id: MESSAGE_EXPERIENCE_AGENT_ID, avatarUrl: null },
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
  ]);
  await setupPage({
    context,
    path: `/chats/${context.resourceId}`,
    featureSwitches: { [FeatureSwitchKey.PersonalizedFollowups]: enabled },
  });
  const group = await screen.findByRole("group", { name: "Keep going" });
  const composer = await findComposer();
  return { onSendRequest, group, composer, control };
}

async function sendDraft(): Promise<void> {
  const send = await waitFor(() => {
    const send = queryAllByRoleFast("button").find((button) => {
      return button.getAttribute("aria-label") === "Send";
    });
    if (!send) {
      throw new Error("Send button not found");
    }
    expect(send).toBeEnabled();
    return send;
  });
  click(send);
}

test.each([true, false])(
  "Only the enabled rollout sends follow-up origins (%s)",
  async (enabled) => {
    const { onSendRequest, group, composer } = await openFollowups(enabled);
    click(await findFastControl("button", FIRST_PROMPT, group));
    expect(composer).toHaveTextContent(FIRST_PROMPT);
    expect(onSendRequest).not.toHaveBeenCalled();

    await sendDraft();
    await waitFor(() => {
      expect(onSendRequest).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: FIRST_PROMPT }),
      );
    });
    expect(onSendRequest.mock.lastCall?.[0].followupOrigins).toStrictEqual(
      enabled ? [{ eventId: FOLLOWUP_EVENT_ID, index: 0 }] : undefined,
    );
  },
);

test("A repeated pick keeps one source through edits beside an existing draft", async () => {
  const user = userEvent.setup({ delay: null });
  const { onSendRequest, group, composer } = await openFollowups();
  await fill(composer, "Use the approved plan");
  const recommendation = await findFastControl("button", FIRST_PROMPT, group);
  click(recommendation);
  expect(composer.textContent).toBe(`Use the approved plan${FIRST_PROMPT}`);
  click(recommendation);
  await waitFor(() => {
    expect(window.getSelection()?.toString()).toBe(FIRST_PROMPT);
  });
  await user.keyboard("{ArrowRight}{Backspace}");
  await user.paste("e for finance");
  expect(composer).toHaveTextContent(
    "Create a presentation outline for finance",
  );

  await sendDraft();
  await waitFor(() => {
    expect(onSendRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt:
          "Use the approved plan\nCreate a presentation outline for finance",
        followupOrigins: [{ eventId: FOLLOWUP_EVENT_ID, index: 0 }],
      }),
    );
  });
});

test("Replacing a picked prompt with unrelated text drops its source", async () => {
  const { onSendRequest, group, composer } = await openFollowups();
  click(await findFastControl("button", FIRST_PROMPT, group));
  expect(composer).toHaveTextContent(FIRST_PROMPT);
  await fill(composer, "Check tomorrow's calendar instead");

  await sendDraft();
  await waitFor(() => {
    expect(onSendRequest).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Check tomorrow's calendar instead" }),
    );
  });
  expect(onSendRequest.mock.lastCall?.[0].followupOrigins).toBeUndefined();
});

test("Removing one of multiple picks keeps only the surviving source", async () => {
  const user = userEvent.setup({ delay: null });
  const { onSendRequest, group, composer } = await openFollowups();
  click(await findFastControl("button", FIRST_PROMPT, group));
  const second = await findFastControl("button", SECOND_PROMPT, group);
  click(second);
  expect(composer.textContent).toBe(`${FIRST_PROMPT}${SECOND_PROMPT}`);
  click(second);
  await waitFor(() => {
    expect(window.getSelection()?.toString()).toBe(SECOND_PROMPT);
  });
  await user.keyboard("{Backspace}");
  await user.paste("Use next week's budget");
  expect(composer).not.toHaveTextContent(SECOND_PROMPT);

  await sendDraft();
  await waitFor(() => {
    expect(onSendRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: `${FIRST_PROMPT}\nUse next week's budget`,
        followupOrigins: [{ eventId: FOLLOWUP_EVENT_ID, index: 0 }],
      }),
    );
  });
});

test("A send includes both picks and clears their origins for the next message", async () => {
  const { onSendRequest, group, composer, control } = await openFollowups();
  click(await findFastControl("button", FIRST_PROMPT, group));
  click(await findFastControl("button", SECOND_PROMPT, group));
  expect(composer.textContent).toBe(`${FIRST_PROMPT}${SECOND_PROMPT}`);

  await sendDraft();
  await waitFor(() => {
    expect(onSendRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: `${FIRST_PROMPT}\n${SECOND_PROMPT}`,
        followupOrigins: [
          { eventId: FOLLOWUP_EVENT_ID, index: 0 },
          { eventId: FOLLOWUP_EVENT_ID, index: 1 },
        ],
      }),
    );
  });
  await findFastControl("button", "Stop");
  control.completeRun("The outline and comparison are ready.");
  await expect(
    screen.findByText("The outline and comparison are ready."),
  ).resolves.toBeInTheDocument();
  await fill(await findComposer(), "Check tomorrow's calendar");
  await sendDraft();
  await waitFor(() => {
    expect(onSendRequest).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Check tomorrow's calendar" }),
    );
  });
  expect(onSendRequest.mock.lastCall?.[0].followupOrigins).toBeUndefined();
});

test("Picking text already written by the user does not attribute it to AI", async () => {
  const { onSendRequest, group, composer } = await openFollowups();
  await fill(composer, FIRST_PROMPT);
  click(await findFastControl("button", FIRST_PROMPT, group));
  expect(composer.textContent).toBe(FIRST_PROMPT);

  await sendDraft();
  await waitFor(() => {
    expect(onSendRequest).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: FIRST_PROMPT }),
    );
  });
  expect(onSendRequest.mock.lastCall?.[0].followupOrigins).toBeUndefined();
});

test("Returning to a saved draft does not reconstruct attribution from its text", async () => {
  const { onSendRequest, group, composer } = await openFollowups();
  click(await findFastControl("button", FIRST_PROMPT, group));
  expect(composer).toHaveTextContent(FIRST_PROMPT);
  click(await findFastControl("link", "Other conversation"));
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/chats/${OTHER_THREAD_ID}`);
  });
  click(await findFastControl("link", "Launch conversation"));
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/chats/${context.resourceId}`);
  });
  const restoredComposer = await findComposer();
  await waitFor(() => {
    expect(restoredComposer).toHaveTextContent(FIRST_PROMPT);
  });

  await sendDraft();
  await waitFor(() => {
    expect(onSendRequest).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: FIRST_PROMPT }),
    );
  });
  expect(onSendRequest.mock.lastCall?.[0].followupOrigins).toBeUndefined();
});
