import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import {
  fireEvent,
  screen,
  waitFor,
  waitForElementToBeRemoved,
} from "@testing-library/react";

import { click } from "../../../__tests__/page-helper.ts";
import {
  assistantEvent,
  context,
  findButton,
  installRunChat,
  promptEvent,
  readyChat,
  RUN_PATH,
  RUN_THREAD_ID,
} from "./chat-run-test-fixtures.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";

export { context, findButton, readyChat, RUN_PATH, RUN_THREAD_ID };

export const CAPABILITY_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
export const FIRST_CAPABILITY_RUN_ID = "d0000000-0000-4000-a000-000000000811";
export const SECOND_CAPABILITY_RUN_ID = "d0000000-0000-4000-a000-000000000812";

export interface CapturedChatSend {
  readonly prompt: string;
  readonly threadId?: string;
  readonly clientThreadId?: string;
  readonly userMessage?: UserMessageDocument;
  readonly sourceRunId?: string;
}

export function completedConversation(
  firstResponse: string,
  secondResponse?: string,
): MockChatEventInput[] {
  const first = [
    promptEvent({
      id: "capability-first-user",
      runId: FIRST_CAPABILITY_RUN_ID,
      seqId: 1,
      text: "Prepare the first response",
    }),
    assistantEvent({
      id: "capability-first-assistant",
      runId: FIRST_CAPABILITY_RUN_ID,
      seqId: 2,
      text: firstResponse,
    }),
  ];
  if (secondResponse === undefined) {
    return first;
  }
  return [
    ...first,
    promptEvent({
      id: "capability-second-user",
      runId: SECOND_CAPABILITY_RUN_ID,
      seqId: 3,
      text: "Prepare another response",
    }),
    assistantEvent({
      id: "capability-second-assistant",
      runId: SECOND_CAPABILITY_RUN_ID,
      seqId: 4,
      text: secondResponse,
    }),
  ];
}

export function installCapabilityChat(args: {
  readonly events: MockChatEventInput[];
  readonly threadTitle?: string;
  readonly onSend?: (send: CapturedChatSend) => void;
}): void {
  installRunChat({
    chatEvents: args.events,
    threadTitle: args.threadTitle ?? "Capability conversation",
    onSendRequest(body) {
      args.onSend?.({
        prompt: body.prompt,
        ...(body.threadId === undefined ? {} : { threadId: body.threadId }),
        ...(body.clientThreadId === undefined
          ? {}
          : { clientThreadId: body.clientThreadId }),
        ...(body.userMessage === undefined
          ? {}
          : { userMessage: body.userMessage }),
        ...(body.sourceRunId === undefined
          ? {}
          : { sourceRunId: body.sourceRunId }),
      });
    },
  });
}

function textNodeContaining(
  text: string,
  occurrence = 0,
  container: ParentNode = document.body,
): Text {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const matches: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (
      node instanceof Text &&
      node.data.includes(text) &&
      node.parentElement?.closest(
        '[data-role="assistant"], [data-feedback-source]',
      )
    ) {
      matches.push(node);
    }
  }
  const match = matches[occurrence];
  if (!match) {
    throw new Error(`Selectable text ${text} was not found`);
  }
  return match;
}

function visibleSelectionRange(
  startNode: Text,
  startOffset: number,
  endNode: Text,
  endOffset: number,
): Range {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
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
    configurable: true,
    value: () => {
      return [rect];
    },
  });
  Object.defineProperty(range, "getBoundingClientRect", {
    configurable: true,
    value: () => {
      return rect;
    },
  });
  return range;
}

function setPassageSelection(
  passage: string,
  occurrence = 0,
  interaction: "mouse" | "native" = "mouse",
): void {
  const node = textNodeContaining(passage, occurrence);
  const start = node.data.indexOf(passage);
  const target = node.parentElement;
  if (!target) {
    throw new Error("Selectable passage has no element target");
  }
  if (interaction === "mouse") {
    fireEvent.mouseDown(target, { button: 0 });
  }
  const range = visibleSelectionRange(
    node,
    start,
    node,
    start + passage.length,
  );
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("Selection API is unavailable");
  }
  selection.removeAllRanges();
  selection.addRange(range);
  if (interaction === "mouse") {
    fireEvent.mouseUp(target, { button: 0 });
  } else {
    fireEvent(document, new Event("selectionchange"));
  }
}

export async function selectPassage(
  passage: string,
  occurrence = 0,
): Promise<void> {
  setPassageSelection(passage, occurrence);
  await findButton("Quote");
}

export async function selectPassageWithoutActions(
  passage: string,
  occurrence = 0,
): Promise<void> {
  const existingQuoteAction = await findButton("Quote");
  setPassageSelection(passage, occurrence, "native");
  await waitForElementToBeRemoved(existingQuoteAction);
}

export async function selectAcrossPassages(
  startPassage: string,
  endPassage: string,
): Promise<void> {
  const startNode = textNodeContaining(startPassage);
  const endNode = textNodeContaining(endPassage);
  const startOffset = startNode.data.indexOf(startPassage);
  const endOffset = endNode.data.indexOf(endPassage) + endPassage.length;
  const target = startNode.parentElement;
  if (!target) {
    throw new Error("Selectable passage has no element target");
  }
  fireEvent.mouseDown(target, { button: 0 });
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("Selection API is unavailable");
  }
  selection.removeAllRanges();
  selection.addRange(
    visibleSelectionRange(startNode, startOffset, endNode, endOffset),
  );
  fireEvent.mouseUp(endNode.parentElement ?? target, { button: 0 });
  await waitFor(() => {
    if (
      document.querySelector(
        '[data-radix-popper-content-wrapper] button[aria-keyshortcuts="q"]',
      )
    ) {
      throw new Error("Ambiguous selection still exposes passage actions");
    }
  });
}

export function clearPassageSelection(): void {
  window.getSelection()?.removeAllRanges();
  fireEvent(document, new Event("selectionchange"));
}

export async function quoteSelectedPassage(): Promise<HTMLElement> {
  const existingNotes = screen.queryAllByRole("textbox", {
    name: "Ask or comment on this quote",
  }).length;
  click(await findButton("Quote"));
  return await waitFor(() => {
    const notes = screen.queryAllByRole("textbox", {
      name: "Ask or comment on this quote",
    });
    const addedNote = notes[existingNotes];
    if (!addedNote) {
      throw new Error("Quoted passage was not added to the composer");
    }
    return addedNote;
  });
}

export function feedbackNotes(): HTMLElement[] {
  return screen.getAllByRole("textbox", {
    name: "Ask or comment on this quote",
  });
}

export function feedbackItems(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-feedback-item]"),
  );
}

export async function waitForSend(
  sends: readonly CapturedChatSend[],
  count: number,
): Promise<CapturedChatSend> {
  await waitFor(() => {
    if (sends.length !== count) {
      throw new Error(
        `Expected ${String(count)} sends, received ${String(sends.length)}`,
      );
    }
  });
  const send = sends[count - 1];
  if (!send) {
    throw new Error("Captured send was unavailable");
  }
  return send;
}
