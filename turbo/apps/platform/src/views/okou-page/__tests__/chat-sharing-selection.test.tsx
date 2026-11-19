import {
  sharedThreadVisibilityContract,
  type SharedThreadAudience,
} from "@okouai/api-contracts/contracts/shared-thread-visibility";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { createChatEvent } from "../../../mocks/mock-helpers.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const THREAD_ID = "b0000000-0000-4000-a000-000000000801";
const PROMPT_ID = "b0000000-0000-4000-a000-000000000802";
const ANSWER_ID = "b0000000-0000-4000-a000-000000000803";
const SHARE_ID = "b0000000-0000-4000-a000-000000000804";
const PROMPT = "Summarize the launch plan";
const ANSWER = "The launch plan has three phases.";

function conversation(): MockChatEventInput[] {
  return [
    {
      id: PROMPT_ID,
      role: "user",
      content: PROMPT,
      runId: "launch",
      createdAt: "2026-08-01T10:00:00Z",
    },
    {
      id: ANSWER_ID,
      role: "assistant",
      content: ANSWER,
      runId: "launch",
      createdAt: "2026-08-01T10:00:01Z",
    },
    {
      id: "launch-completed",
      role: "assistant",
      content: null,
      runId: "launch",
      runLifecycleEvent: "completed",
      createdAt: "2026-08-01T10:00:02Z",
    },
  ];
}

function button(name: string): HTMLElement {
  const found = queryAllByRoleFast("button").find((element) => {
    return (
      element.getAttribute("aria-label") === name ||
      element.textContent?.trim() === name
    );
  });
  if (!found) {
    throw new Error(`Button not found: ${name}`);
  }
  return found;
}

function checkboxFor(text: string): HTMLElement {
  const group = screen
    .getByText(text)
    .closest<HTMLElement>("[data-chat-share-selectable-group]");
  if (!group) {
    throw new Error(`Selection not found: ${text}`);
  }
  return within(group).getByRole("checkbox");
}

async function openConversation(events = conversation(), nameLine = true) {
  const clipboard = context.mocks.browser.clipboardWriteText();
  const requests: { eventIds: string[]; audience: SharedThreadAudience }[] = [];
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "Launch planning",
    chatEvents: events,
  });
  context.mocks.api(
    sharedThreadVisibilityContract.create,
    ({ body, respond }) => {
      requests.push({ eventIds: [...body.eventIds], audience: body.audience });
      return respond(201, { id: SHARE_ID });
    },
  );
  context.mocks.api(sharedThreadVisibilityContract.get, ({ respond }) => {
    return respond(200, {
      id: SHARE_ID,
      audience: "private",
      revision: null,
      organization: { id: "org_mock", name: "Acme" },
    });
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
    featureSwitches: {
      [FeatureSwitchKey.ThreadSharingSelection]: true,
      [FeatureSwitchKey.ChatReplyNameLine]: nameLine,
    },
  });
  await screen.findByText(ANSWER);
  await waitFor(() => {
    expect(button("Share messages")).toBeEnabled();
  });
  return { clipboard, requests };
}

async function openSelection(events = conversation(), nameLine = true) {
  const result = await openConversation(events, nameLine);
  click(button("Share messages"));
  await screen.findByRole("checkbox", { name: "Select all" });
  return result;
}

async function chooseAccess(name = "Only me") {
  click(screen.getByRole("combobox", { name: "Who can open" }));
  const option = await screen.findByRole("option", { name });
  click(option);
  await waitFor(() => {
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
}

test.each([true, false])(
  "All, partial, preview and keyboard selection share the same draft (name line: %s)",
  async (nameLine) => {
    const { requests } = await openSelection(conversation(), nameLine);
    const all = screen.getByRole("checkbox", { name: "Select all" });
    expect(all).not.toBeChecked();
    expect(button("Preview")).toBeDisabled();
    expect(button("Create & copy link")).toBeDisabled();
    click(checkboxFor(ANSWER));
    await waitFor(() => {
      expect(all).toBePartiallyChecked();
    });
    expect(screen.getByText("1 of 2 selected")).toBeInTheDocument();
    click(button("Preview"));
    const preview = await screen.findByRole("dialog", {
      name: "Share preview",
    });
    expect(within(preview).getByText(ANSWER)).toBeInTheDocument();
    expect(within(preview).queryByText(PROMPT)).not.toBeInTheDocument();
    const user = userEvent.setup({ delay: null });
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(preview).not.toBeInTheDocument();
    });
    expect(button("Preview")).toHaveFocus();
    expect(all).toBePartiallyChecked();
    await user.click(all);
    expect(all).toBeChecked();
    expect(screen.getByText("2 of 2 selected")).toBeInTheDocument();
    await user.keyboard(" ");
    expect(all).not.toBeChecked();
    expect(screen.getByText("0 of 2 selected")).toBeInTheDocument();
    expect(requests).toStrictEqual([]);
  },
);

test("Choose access and create directly without a mandatory preview; reopening keeps the link", async () => {
  const { requests, clipboard } = await openSelection();
  click(screen.getByRole("checkbox", { name: "Select all" }));
  expect(button("Create & copy link")).toBeDisabled();
  await chooseAccess("Anyone at Default Org");
  expect(
    screen.getAllByText("Workspace members only. Sign-in required.").length,
  ).toBeGreaterThan(0);
  click(button("Create & copy link"));
  await screen.findByRole("textbox", { name: "Shared chat link" });
  expect(requests).toStrictEqual([
    { eventIds: [PROMPT_ID, ANSWER_ID], audience: "organization" },
  ]);
  expect(clipboard.writes).toStrictEqual([
    `https://app.okou.ai/share/threads/${SHARE_ID}`,
  ]);
  click(button("Close"));
  await screen.findByRole("textbox", { name: "Message" });
  click(button("Share messages"));
  await screen.findByRole("textbox", { name: "Shared chat link" });
  expect(requests).toHaveLength(1);
});

test("Reply sharing preselects its question and answer and preserves the draft on close", async () => {
  const { requests } = await openConversation();
  click(button("Share message"));
  await screen.findByText("2 of 2 selected");
  expect(checkboxFor(PROMPT)).toBeChecked();
  expect(checkboxFor(ANSWER)).toBeChecked();
  expect(button("Create & copy link")).toBeDisabled();
  click(checkboxFor(PROMPT));
  await chooseAccess("Anyone with the link");
  click(button("Close"));
  await screen.findByRole("textbox", { name: "Message" });
  click(button("Share messages"));
  await screen.findByText("1 of 2 selected");
  expect(checkboxFor(PROMPT)).not.toBeChecked();
  expect(checkboxFor(ANSWER)).toBeChecked();
  expect(
    screen.getByRole("combobox", { name: "Who can open" }),
  ).toHaveTextContent("Anyone with the link");
  expect(requests).toStrictEqual([]);
});

test("Pending creation locks the draft; failure retains it and clipboard failure keeps a copyable link", async () => {
  await openSelection();
  const response = context.mocks.deferred<void>();
  const received = context.mocks.deferred<void>();
  context.mocks.api(
    sharedThreadVisibilityContract.create,
    async ({ respond }) => {
      received.resolve();
      await response.promise;
      return respond(413, {
        error: { code: "TOO_LARGE", message: "Too large" },
      });
    },
  );
  click(screen.getByRole("checkbox", { name: "Select all" }));
  await chooseAccess();
  click(button("Create & copy link"));
  await received.promise;
  expect(screen.getByRole("checkbox", { name: "Select all" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(checkboxFor(ANSWER)).toHaveAttribute("aria-disabled", "true");
  expect(button("Close")).toBeDisabled();
  expect(button("Preview")).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "Who can open" })).toBeDisabled();
  response.resolve();
  await screen.findByText(
    "Could not create the link. Your selection and access choice are saved.",
  );
  expect(screen.getByText("2 of 2 selected")).toBeInTheDocument();
  expect(button("Create & copy link")).toBeEnabled();
  const copy = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockRejectedValue(new Error("Clipboard permission denied"));
  context.mocks.api(sharedThreadVisibilityContract.create, ({ respond }) => {
    return respond(201, { id: SHARE_ID });
  });
  click(button("Create & copy link"));
  const link = await screen.findByRole("textbox", { name: "Shared chat link" });
  expect(link).toHaveValue(`https://app.okou.ai/share/threads/${SHARE_ID}`);
  await screen.findByText("Could not copy the link");
  copy.mockResolvedValue();
  click(button("Copy link"));
  await waitFor(() => {
    expect(button("Copied")).toBeInTheDocument();
  });
  expect(copy).toHaveBeenLastCalledWith(
    `https://app.okou.ai/share/threads/${SHARE_ID}`,
  );
});

test("Select all includes messages outside the render window and newly arrived turns require selection", async () => {
  const events = conversation();
  const { requests } = await openSelection(events);
  click(screen.getByRole("checkbox", { name: "Select all" }));
  const ids = [PROMPT_ID, ANSWER_ID];
  act(() => {
    for (let turn = 1; turn <= 12; turn++) {
      const minute = String(turn).padStart(2, "0");
      const runId = `later-${String(turn)}`;
      const promptId = `b0000000-0000-4000-a000-${String(1000 + turn * 2).padStart(12, "0")}`;
      const answerId = `b0000000-0000-4000-a000-${String(1001 + turn * 2).padStart(12, "0")}`;
      ids.push(promptId, answerId);
      events.push(
        {
          id: promptId,
          role: "user",
          content: `Question ${String(turn)}`,
          runId,
          createdAt: `2026-08-01T10:${minute}:00Z`,
        },
        {
          id: answerId,
          role: "assistant",
          content: `Answer ${String(turn)}`,
          runId,
          createdAt: `2026-08-01T10:${minute}:01Z`,
        },
        {
          id: `completed-${String(turn)}`,
          role: "assistant",
          content: null,
          runId,
          runLifecycleEvent: "completed",
          createdAt: `2026-08-01T10:${minute}:02Z`,
        },
      );
    }
    createChatEvent(THREAD_ID);
  });
  await screen.findByText("Answer 12");
  expect(screen.queryByText(ANSWER)).not.toBeInTheDocument();
  expect(
    screen.getByRole("checkbox", { name: "Select all" }),
  ).toBePartiallyChecked();
  click(screen.getByRole("checkbox", { name: "Select all" }));
  await screen.findByText("26 of 26 selected");
  await chooseAccess();
  click(button("Create & copy link"));
  await screen.findByRole("textbox", { name: "Shared chat link" });
  expect(requests).toStrictEqual([{ eventIds: ids, audience: "private" }]);
});

test("An oversized select-all attempt keeps the existing selection", async () => {
  const events = conversation();
  events[1] = {
    ...events[1],
    content: `${ANSWER}\n\n<!--${"界".repeat(524_289)}-->`,
    createdAt: "2026-08-01T10:00:01Z",
  };
  await openSelection(events);
  click(checkboxFor(PROMPT));
  click(screen.getByRole("checkbox", { name: "Select all" }));
  await screen.findByText("Select fewer messages to share");
  expect(screen.getByText("1 of 2 selected")).toBeInTheDocument();
  expect(checkboxFor(PROMPT)).toBeChecked();
  expect(checkboxFor(ANSWER)).not.toBeChecked();
});

test("Preview includes selected attachments and excludes background messages", async () => {
  const events = conversation();
  events[0] = {
    ...events[0],
    content: PROMPT,
    createdAt: "2026-08-01T10:00:00Z",
    fileParts: [
      {
        type: "file",
        fileId: "b0000000-0000-4000-a000-000000000805",
        filenameSnapshot: "launch-notes.txt",
        contentType: "text/plain",
      },
    ],
  };
  events.splice(1, 0, {
    id: "b0000000-0000-4000-a000-000000000806",
    role: "assistant",
    content: "Private work in progress",
    runId: "launch",
    createdAt: "2026-08-01T10:00:00.500Z",
  });
  await openSelection(events);
  click(screen.getByRole("checkbox", { name: "Select all" }));
  click(button("Preview"));
  const preview = await screen.findByRole("dialog", { name: "Share preview" });
  expect(within(preview).getByText("launch-notes.txt")).toBeInTheDocument();
  expect(within(preview).getByText(ANSWER)).toBeInTheDocument();
  expect(
    within(preview).queryByText("Private work in progress"),
  ).not.toBeInTheDocument();
});

test("Mobile sharing has the same selection controls and can create another snapshot", async () => {
  context.mocks.browser.matchMedia((query) => {
    return query === "(pointer: coarse)";
  });
  const { requests } = await openSelection();
  expect(
    queryAllByRoleFast("button").filter((element) => {
      return element.textContent === "Close";
    }),
  ).toHaveLength(1);
  click(screen.getByRole("checkbox", { name: "Select all" }));
  await chooseAccess();
  click(button("Create & copy link"));
  await screen.findByRole("textbox", { name: "Shared chat link" });
  click(button("Change selection"));
  await screen.findByText("2 of 2 selected");
  click(checkboxFor(PROMPT));
  click(button("Create & copy link"));
  await screen.findByRole("textbox", { name: "Shared chat link" });
  expect(requests).toStrictEqual([
    { eventIds: [PROMPT_ID, ANSWER_ID], audience: "private" },
    { eventIds: [ANSWER_ID], audience: "private" },
  ]);
});
