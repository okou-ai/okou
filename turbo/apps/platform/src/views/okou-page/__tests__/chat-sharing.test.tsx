import {
  type SharedThreadAudience,
  sharedThreadVisibilityContract,
} from "@okouai/api-contracts/contracts/shared-thread-visibility";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import { setupPage } from "./chat-lifecycle-test-helpers.ts";
import {
  assistantEvent,
  completedEvent,
  createChatRunFixtures,
  findEnabledButton,
  findWorkHistoryToggle,
  promptEvent,
  publishRunUpdate,
  queryButton,
  readyChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);

const RUN_ID = "e5000000-0000-4000-a000-000000000101";
const PROMPT_ID = "e5000000-0000-4000-a000-000000000201";
const SECOND_PROMPT_ID = "e5000000-0000-4000-a000-000000000202";
const ANSWER_ID = "e5000000-0000-4000-a000-000000000301";
const SECOND_ANSWER_ID = "e5000000-0000-4000-a000-000000000302";
const THIRD_ANSWER_ID = "e5000000-0000-4000-a000-000000000303";
const SHARED_THREAD_ID = "e5000000-0000-4000-a000-000000000901";

const PROMPT = "Draft the launch note";
const ANSWER = "The launch note is ready for review";

interface CreateRequest {
  readonly eventIds: readonly string[];
  readonly id?: string;
  readonly audience: SharedThreadAudience;
}

function conversation(answer = ANSWER): MockChatEventInput[] {
  return [
    promptEvent({ id: PROMPT_ID, runId: RUN_ID, seqId: 1, text: PROMPT }),
    assistantEvent({ id: ANSWER_ID, runId: RUN_ID, seqId: 2, text: answer }),
    completedEvent({
      id: "e5000000-0000-4000-a000-000000000399",
      runId: RUN_ID,
      seqId: 3,
    }),
  ];
}

function shareUrl(id = SHARED_THREAD_ID): string {
  return `${location.origin}/share/threads/${id}`;
}

async function openChat(
  chatEvents: MockChatEventInput[],
  options: {
    readonly activeRunIds?: string[];
    readonly clipboard?: "allowed" | "denied";
  } = {},
): Promise<{ readonly writes: string[]; readonly user: UserEvent }> {
  installRunChat({
    chatEvents,
    ...(options.activeRunIds === undefined
      ? {}
      : { activeRunIds: options.activeRunIds }),
  });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  // user-event replaces navigator.clipboard when it is set up, so the
  // clipboard boundary is installed afterwards on the object the page uses.
  const user = userEvent.setup({ delay: null });
  if (options.clipboard === "denied") {
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
      new DOMException("Clipboard unavailable", "NotAllowedError"),
    );
    return { writes: [], user };
  }
  return { ...context.mocks.browser.clipboardWriteText(), user };
}

function mockCreate(
  respond: (body: CreateRequest) => Promise<void> | void = () => {},
  status: 201 | 403 = 201,
): CreateRequest[] {
  const requests: CreateRequest[] = [];
  context.mocks.api(
    sharedThreadVisibilityContract.create,
    async ({ body, respond: reply }) => {
      requests.push(body);
      await respond(body);
      if (status === 403) {
        return reply(403, {
          error: { code: "FORBIDDEN", message: "Sharing is not allowed" },
        });
      }
      return reply(201, { id: body.id ?? SHARED_THREAD_ID });
    },
  );
  return requests;
}

async function startSharing(): Promise<void> {
  click(await findEnabledButton("Share messages"));
  await waitFor(() => {
    expect(selectedCountLabels("0 selected")).not.toHaveLength(0);
  });
}

function selectedCountLabels(text: string): HTMLElement[] {
  return screen.queryAllByText(text);
}

function groupCheckboxes(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      "[data-chat-share-selectable-group] [role='checkbox']",
    ),
  );
}

function groupCheckbox(index: number): HTMLElement {
  const checkbox = groupCheckboxes()[index];
  if (!checkbox) {
    throw new Error(`Message group ${index.toString()} has no checkbox`);
  }
  return checkbox;
}

function groupLabel(index: number): HTMLElement {
  const group = document.querySelectorAll<HTMLElement>(
    "[data-chat-share-selectable-group]",
  )[index];
  const label = group?.querySelector<HTMLElement>("label");
  if (!label) {
    throw new Error(`Message group ${index.toString()} has no row label`);
  }
  return label;
}

function shareButton(): HTMLElement {
  const button = queryButton("Share");
  if (!button) {
    throw new Error("Share button was not visible");
  }
  return button;
}

function passageActions(): HTMLElement[] {
  return queryAllByRoleFast("button").filter((button) => {
    return ["c", "q", "f"].includes(
      button.getAttribute("aria-keyshortcuts") ?? "",
    );
  });
}

function textNodeContaining(text: string): Text {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof Text && node.data.includes(text)) {
      return node;
    }
  }
  throw new Error(`Text not found: ${text}`);
}

function selectText(text: string): void {
  const node = textNodeContaining(text);
  const target = node.parentElement;
  if (!target) {
    throw new Error(`Text has no element: ${text}`);
  }
  const start = node.data.indexOf(text);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + text.length);
  const rect = {
    bottom: 48,
    height: 24,
    left: 24,
    right: 224,
    top: 24,
    width: 200,
    x: 24,
    y: 24,
    toJSON: () => {
      return {};
    },
  } satisfies DOMRect;
  Object.defineProperty(range, "getClientRects", {
    value: () => {
      return [rect];
    },
  });
  Object.defineProperty(range, "getBoundingClientRect", {
    value: () => {
      return rect;
    },
  });
  const pointer = {
    button: 0,
    isPrimary: true,
    pointerId: 1,
    pointerType: "mouse",
  };
  fireEvent.pointerDown(target, pointer);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  fireEvent(document, new Event("selectionchange"));
  fireEvent.pointerUp(target, pointer);
  fireEvent.click(target, { button: 0 });
}

function clearSelection(): void {
  window.getSelection()?.removeAllRanges();
  fireEvent(document, new Event("selectionchange"));
}

function messageShareButton(): HTMLElement {
  const button = screen.queryByTestId("chat-message-share");
  if (!button) {
    throw new Error("Message share button was not visible");
  }
  return button;
}

async function openMessageShareMenu(user: UserEvent): Promise<HTMLElement> {
  await waitFor(() => {
    expect(messageShareButton()).toBeEnabled();
  });
  await user.click(messageShareButton());
  return await screen.findByRole("menu", { name: "Share message" });
}

function menuItem(menu: HTMLElement, name: string): HTMLElement {
  const item = queryAllByRoleFast("menuitem", menu).find((candidate) => {
    return candidate.textContent?.startsWith(name) === true;
  });
  if (!item) {
    throw new Error(`Menu item ${name} was not visible`);
  }
  return item;
}

function composer(): HTMLElement | null {
  return screen.queryByRole("textbox", { name: "Message" });
}

function thinkingIndicator(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-thinking-indicator]");
}

test("The row label toggles a message group once", async () => {
  await openChat(conversation());
  await startSharing();

  click(groupLabel(0));
  await waitFor(() => {
    expect(groupCheckbox(0)).toBeChecked();
  });
  expect(selectedCountLabels("1 selected")).not.toHaveLength(0);
  expect(shareButton()).toBeEnabled();

  click(groupLabel(0));
  await waitFor(() => {
    expect(groupCheckbox(0)).not.toBeChecked();
  });
  expect(selectedCountLabels("0 selected")).not.toHaveLength(0);
  expect(shareButton()).toBeDisabled();
});

test("Message text and code copying remain separate from group selection", async () => {
  const clipboard = await openChat(
    conversation(
      "Read the [release guide](https://example.com/guide) first.\n\n```sh\nnpm run release\n```",
    ),
  );
  await startSharing();
  const pre = await waitFor(() => {
    const block = Array.from(document.querySelectorAll("pre")).find(
      (candidate) => {
        return candidate.textContent?.includes("npm run release") === true;
      },
    );
    if (!(block instanceof HTMLElement)) {
      throw new Error("Code block was not rendered");
    }
    return block;
  });

  const [copyCode] = queryAllByRoleFast("button", pre);
  if (!copyCode) {
    throw new Error("Code block has no copy button");
  }
  click(copyCode);
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual(["npm run release\n"]);
  });
  expect(groupCheckbox(1)).not.toBeChecked();
  expect(selectedCountLabels("0 selected")).not.toHaveLength(0);

  click(groupCheckbox(1));
  await waitFor(() => {
    expect(groupCheckbox(1)).toBeChecked();
  });
  expect(shareButton()).toBeEnabled();
  click(screen.getByText(/Read the/u));
  expect(groupCheckbox(1)).toBeChecked();
  expect(selectedCountLabels("1 selected")).not.toHaveLength(0);
  expect(
    queryAllByRoleFast("link").find((link) => {
      return link.textContent === "release guide";
    }),
  ).toHaveAttribute("href", "https://example.com/guide");
});

test("A growing selected message group becomes partial and can select its new messages", async () => {
  const chatEvents: MockChatEventInput[] = [
    promptEvent({ id: PROMPT_ID, seqId: 1, text: PROMPT }),
  ];
  const requests = mockCreate();
  await openChat(chatEvents);
  await startSharing();
  click(groupCheckbox(0));
  await waitFor(() => {
    expect(groupCheckbox(0)).toBeChecked();
  });

  chatEvents.push(
    promptEvent({
      id: SECOND_PROMPT_ID,
      seqId: 2,
      text: "Add the pricing section",
    }),
  );
  publishRunUpdate();
  await expect(
    screen.findByText("Add the pricing section"),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expect(groupCheckbox(0)).toHaveAttribute("aria-checked", "mixed");
  });

  click(groupCheckbox(0));
  await waitFor(() => {
    expect(groupCheckbox(0)).toHaveAttribute("aria-checked", "true");
  });
  click(groupCheckbox(0));
  await waitFor(() => {
    expect(groupCheckbox(0)).toHaveAttribute("aria-checked", "false");
  });
  click(groupCheckbox(0));
  await waitFor(() => {
    expect(groupCheckbox(0)).toHaveAttribute("aria-checked", "true");
  });
  click(shareButton());

  await waitFor(() => {
    expect(requests).toHaveLength(1);
  });
  expect(requests[0]?.eventIds).toStrictEqual([PROMPT_ID, SECOND_PROMPT_ID]);
});

test("Share selected message groups as a public conversation snapshot", async () => {
  const requests = mockCreate();
  const clipboard = await openChat(conversation());
  await startSharing();

  click(groupCheckbox(0));
  click(groupCheckbox(1));
  await waitFor(() => {
    expect(selectedCountLabels("2 selected")).not.toHaveLength(0);
  });
  click(shareButton());

  await expect(
    screen.findByRole("textbox", { name: "Shared chat link" }),
  ).resolves.toHaveValue(shareUrl());
  expect(requests).toStrictEqual([
    { eventIds: [PROMPT_ID, ANSWER_ID], audience: "public" },
  ]);
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([shareUrl()]);
  });
  expect(groupCheckbox(1)).toBeChecked();
  expect(groupCheckbox(1)).toHaveAttribute("aria-disabled", "true");
  click(groupCheckbox(1));
  expect(groupCheckbox(1)).toBeChecked();
  selectText(ANSWER);
  expect(window.getSelection()?.toString()).toBe(ANSWER);
  expect(passageActions()).toHaveLength(0);
});

test("Hide passage actions throughout sharing and restore them afterward", async () => {
  mockCreate();
  await openChat(conversation());
  selectText(ANSWER);
  await waitFor(() => {
    expect(passageActions()).toHaveLength(3);
  });

  await startSharing();
  expect(passageActions()).toHaveLength(0);
  selectText(ANSWER);
  expect(window.getSelection()?.toString()).toBe(ANSWER);
  expect(passageActions()).toHaveLength(0);
  clearSelection();

  click(groupCheckbox(1));
  await waitFor(() => {
    expect(shareButton()).toBeEnabled();
  });
  click(shareButton());
  await expect(
    screen.findByRole("textbox", { name: "Shared chat link" }),
  ).resolves.toBeVisible();
  selectText(ANSWER);
  expect(passageActions()).toHaveLength(0);
  clearSelection();

  click(await findEnabledButton("Close"));
  await waitFor(() => {
    expect(composer()).toBeVisible();
  });
  selectText(ANSWER);
  await waitFor(() => {
    expect(passageActions()).toHaveLength(3);
  });
});

test("Back-to-back user messages keep their frame apart while sharing", async () => {
  await openChat([
    promptEvent({ id: PROMPT_ID, seqId: 1, text: PROMPT }),
    promptEvent({
      id: SECOND_PROMPT_ID,
      seqId: 2,
      text: "Add the pricing section",
    }),
  ]);
  await startSharing();

  const messages = Array.from(
    document.querySelectorAll<HTMLElement>('[data-role="user"]'),
  );
  expect(messages).toHaveLength(2);
  for (const message of messages) {
    expect(
      message.querySelector("[data-chat-user-message-actions]"),
    ).not.toBeNull();
  }
  expect(messages[0]).not.toHaveAttribute("data-chat-user-message-stacked");
  expect(messages[1]).toHaveAttribute("data-chat-user-message-stacked", "true");
  expect(queryButton("Copy message")).toBeNull();
});

test.each(["running", "failed"] as const)(
  "Sharing a %s answer shows only its latest message and restores the expanded history on close",
  async (state) => {
    const requests = mockCreate();
    const events: MockChatEventInput[] = [
      promptEvent({ id: PROMPT_ID, runId: RUN_ID, seqId: 1, text: PROMPT }),
      assistantEvent({
        id: ANSWER_ID,
        runId: RUN_ID,
        seqId: 2,
        text: "Collected the launch facts",
      }),
      assistantEvent({
        id: SECOND_ANSWER_ID,
        runId: RUN_ID,
        seqId: 3,
        text: "Drafted the launch outline",
      }),
      assistantEvent({
        id: THIRD_ANSWER_ID,
        runId: RUN_ID,
        seqId: 4,
        text: "Final launch note",
      }),
    ];
    if (state === "failed") {
      events.push({
        id: "e5000000-0000-4000-a000-000000000398",
        role: "assistant",
        content: null,
        runId: RUN_ID,
        runLifecycleEvent: "failed",
        error: "The launch tool stopped responding",
        seqId: 5,
        createdAt: "2026-08-01T10:00:05.000Z",
      });
    }
    await openChat(
      events,
      state === "running" ? { activeRunIds: [RUN_ID] } : {},
    );
    click(await findWorkHistoryToggle("collapsed"));
    await expect(
      screen.findByText("Collected the launch facts"),
    ).resolves.toBeVisible();
    expect(screen.getByText("Drafted the launch outline")).toBeVisible();
    const status = (): HTMLElement | null => {
      return state === "running"
        ? thinkingIndicator()
        : screen.queryByText("This run couldn't finish");
    };
    await waitFor(() => {
      expect(status()).toBeVisible();
    });

    await startSharing();
    expect(screen.getByText("Final launch note")).toBeVisible();
    expect(screen.queryByText("Collected the launch facts")).toBeNull();
    expect(screen.queryByText("Drafted the launch outline")).toBeNull();
    expect(status()).toBeNull();
    selectText("Final launch note");
    expect(passageActions()).toHaveLength(0);
    clearSelection();
    click(groupCheckbox(1));
    await waitFor(() => {
      expect(shareButton()).toBeEnabled();
    });
    click(shareButton());
    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    expect(requests[0]?.eventIds).toStrictEqual([THIRD_ANSWER_ID]);

    click(await findEnabledButton("Close"));
    await expect(
      screen.findByText("Collected the launch facts"),
    ).resolves.toBeVisible();
    expect(screen.getByText("Drafted the launch outline")).toBeVisible();
    expect(screen.getByText("Final launch note")).toBeVisible();
    await expect(findWorkHistoryToggle("expanded")).resolves.toBeVisible();
    await waitFor(() => {
      expect(status()).toBeVisible();
    });
    selectText("Final launch note");
    await waitFor(() => {
      expect(passageActions()).toHaveLength(3);
    });
  },
);

test("An oversized message group cannot be added to a shared snapshot", async () => {
  await openChat(conversation("界".repeat(524_289)));
  await startSharing();

  click(groupCheckbox(1));

  await expect(
    screen.findByText("Select fewer messages to share"),
  ).resolves.toBeVisible();
  expect(groupCheckbox(1)).not.toBeChecked();
  expect(selectedCountLabels("0 selected")).not.toHaveLength(0);
  expect(screen.getByText(PROMPT)).toBeVisible();
});

test("Select an audience before creating a share and change it after creation", async () => {
  const requests = mockCreate();
  let audience: SharedThreadAudience = "organization";
  let revision = "e5000000-0000-4000-a000-000000000801";
  const updates: { audience: SharedThreadAudience; revision: string | null }[] =
    [];
  context.mocks.api(sharedThreadVisibilityContract.get, ({ respond }) => {
    return respond(200, {
      id: SHARED_THREAD_ID,
      audience,
      revision,
      organization: { id: "org_default", name: "Acme" },
    });
  });
  context.mocks.api(
    sharedThreadVisibilityContract.update,
    ({ body, respond }) => {
      updates.push({
        audience: body.audience,
        revision: body.expectedRevision,
      });
      audience = body.audience;
      revision = "e5000000-0000-4000-a000-000000000802";
      return respond(200, {
        id: SHARED_THREAD_ID,
        audience,
        revision,
        organization: { id: "org_default", name: "Acme" },
      });
    },
  );
  await openChat(conversation());
  await startSharing();

  click(await findEnabledButton("Who can access"));
  click(await findRadio("Anyone at Default Org"));
  await waitFor(() => {
    expect(queryButton("Who can access")).toHaveTextContent(
      "Anyone in your organization",
    );
  });
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "Escape",
  });
  click(groupCheckbox(1));
  await waitFor(() => {
    expect(shareButton()).toBeEnabled();
  });
  click(shareButton());
  await expect(
    screen.findByRole("textbox", { name: "Shared chat link" }),
  ).resolves.toBeVisible();
  expect(requests).toStrictEqual([
    { eventIds: [ANSWER_ID], audience: "organization" },
  ]);

  click(await findEnabledButton("Share"));
  await waitFor(() => {
    expect(findRadioNow("Anyone at Acme")).toBeChecked();
  });
  click(findRadioNow("Anyone with the link"));
  await waitFor(() => {
    expect(findRadioNow("Anyone with the link")).toBeChecked();
  });
  expect(updates).toStrictEqual([
    {
      audience: "public",
      revision: "e5000000-0000-4000-a000-000000000801",
    },
  ]);
});

function findRadioNow(name: string): HTMLElement {
  const radio = queryAllByRoleFast("radio").find((candidate) => {
    return (
      candidate.textContent?.includes(name) === true ||
      candidate.getAttribute("aria-label") === name
    );
  });
  if (!radio) {
    throw new Error(`Radio ${name} was not visible`);
  }
  return radio;
}

function findRadio(name: string): Promise<HTMLElement> {
  return waitFor(() => {
    return findRadioNow(name);
  });
}

test("Choose Organization and copy a message share without replacing the composer", async () => {
  const response = context.mocks.deferred<void>();
  const requests = mockCreate(() => {
    return response.promise;
  });
  const clipboard = await openChat(conversation());
  const menu = await openMessageShareMenu(clipboard.user);

  click(menuItem(menu, "Organization"));

  await waitFor(() => {
    expect(requests).toHaveLength(1);
  });
  expect(requests[0]?.eventIds).toStrictEqual([PROMPT_ID, ANSWER_ID]);
  expect(requests[0]?.audience).toBe("organization");
  const url = shareUrl(requests[0]?.id);
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([url]);
  });
  expect(messageShareButton()).toHaveAccessibleName("Copied");
  expect(composer()).toBeVisible();

  response.resolve();
  await waitFor(() => {
    expect(composer()).toBeVisible();
  });
  expect(
    screen.queryByRole("textbox", { name: "Shared chat link" }),
  ).not.toBeInTheDocument();
});

test("Dismiss the audience menu without copying", async () => {
  const clipboard = await openChat(conversation());
  expect(composer()).toBeVisible();
  await openMessageShareMenu(clipboard.user);

  await clipboard.user.keyboard("{Escape}");

  await waitFor(() => {
    expect(
      screen.queryByRole("menu", { name: "Share message" }),
    ).not.toBeInTheDocument();
  });
  await waitFor(() => {
    expect(messageShareButton()).toHaveFocus();
  });
  expect(clipboard.writes).toStrictEqual([]);
  expect(composer()).toBeVisible();
});

test("A failed message share (403) reverts the optimistic copy and keeps the composer", async () => {
  const response = context.mocks.deferred<void>();
  mockCreate(() => {
    return response.promise;
  }, 403);
  const { user } = await openChat(conversation());
  const menu = await openMessageShareMenu(user);

  click(menuItem(menu, "Everyone"));
  await waitFor(() => {
    expect(messageShareButton()).toHaveAccessibleName("Copied");
  });
  expect(composer()).toBeVisible();

  response.resolve();
  await expect(
    screen.findByText("The shared link could not be created."),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expect(messageShareButton()).toHaveAccessibleName("Share message");
  });
  expect(messageShareButton()).toBeEnabled();
  expect(composer()).toBeVisible();
  expect(
    screen.queryByRole("textbox", { name: "Shared chat link" }),
  ).not.toBeInTheDocument();
});

test("A denied clipboard write reverts the optimistic message share confirmation", async () => {
  const response = context.mocks.deferred<void>();
  const requests = mockCreate(() => {
    return response.promise;
  });
  const { user } = await openChat(conversation(), { clipboard: "denied" });
  const menu = await openMessageShareMenu(user);

  click(menuItem(menu, "Organization"));
  await waitFor(() => {
    expect(requests).toHaveLength(1);
  });
  expect(messageShareButton()).toHaveAccessibleName("Copied");

  response.resolve();
  await expect(
    screen.findByText("Could not copy the link"),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expect(messageShareButton()).toHaveAccessibleName("Share message");
  });
  expect(messageShareButton()).toBeEnabled();
  expect(composer()).toBeVisible();
  expect(
    screen.queryByRole("textbox", { name: "Shared chat link" }),
  ).not.toBeInTheDocument();
});
