import type {
  ChatEventUsagePayload,
  UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { isSupportedRunModel } from "@okouai/api-contracts/contracts/model-providers";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect } from "vitest";

import { queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { createChatEvent } from "../../../mocks/mock-helpers.ts";
import {
  AGENT_ID,
  context,
  mockChatLifecycleWithoutBrowserSession,
} from "./chat-lifecycle-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import { fillComposer } from "./chat-test-helpers.ts";

export { context };

export const RUN_THREAD_ID = "b0000000-0000-4000-a000-000000000801";
export const RUN_PATH = `/chats/${RUN_THREAD_ID}`;
export const NEW_CHAT_PATH = `/agents/${AGENT_ID}/chat`;

const DEFAULT_MODEL = "claude-sonnet-4-6";

type LifecycleOptions = NonNullable<
  Parameters<typeof mockChatLifecycleWithoutBrowserSession>[0]
>;

export function installRunChat(
  options: LifecycleOptions = {},
): ReturnType<typeof mockChatLifecycleWithoutBrowserSession> {
  const requestedModel = options.selectedModel ?? DEFAULT_MODEL;
  const selectedModel = isSupportedRunModel(requestedModel)
    ? requestedModel
    : DEFAULT_MODEL;
  context.mocks.data.agents([
    {
      agentId: AGENT_ID,
      displayName: "Run Agent",
      description: "Handles visible chat work",
    },
  ]);
  if (options.selectedModel !== undefined) {
    context.mocks.data.userModelPreference({
      selectedModel,
      serviceTier:
        options.codexServiceTier === "fast" ? ("priority" as const) : null,
      modelSettings: options.modelSettings ?? {},
      selectedVideoModel: null,
      selectedImageModel: null,
      updatedAt: null,
    });
  }
  return mockChatLifecycleWithoutBrowserSession({
    threadId: RUN_THREAD_ID,
    threadTitle: "Run conversation",
    selectedModel: DEFAULT_MODEL,
    ...options,
  });
}

export function publishRunUpdate(threadId = RUN_THREAD_ID): void {
  createChatEvent(threadId);
}

function normalizedText(element: Element): string {
  return element.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}

function matchesAccessibleName(element: HTMLElement, name: string): boolean {
  const text = normalizedText(element);
  return (
    element.getAttribute("aria-label") === name ||
    text === name ||
    (element.hasAttribute("aria-keyshortcuts") && text.startsWith(name))
  );
}

function workHistoryToggleButtons(container: ParentNode): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>("[data-chat-run-work-range]"),
  );
}

export function queryWorkHistoryToggles(
  state: "collapsed" | "expanded",
  container: ParentNode = document.body,
): HTMLElement[] {
  const expanded = state === "expanded";
  return workHistoryToggleButtons(container).filter((control) => {
    return control.getAttribute("aria-expanded") === String(expanded);
  });
}

export function queryWorkHistoryToggle(
  state: "collapsed" | "expanded",
  container: ParentNode = document.body,
): HTMLElement | null {
  const options = queryWorkHistoryToggles(state, container);
  if (options.length > 1) {
    throw new Error(`Found multiple ${state} work history toggles`);
  }
  return options[0] ?? null;
}

export function getWorkHistoryToggle(
  state: "collapsed" | "expanded",
  container: ParentNode = document.body,
): HTMLElement {
  const option = queryWorkHistoryToggle(state, container);
  if (!option) {
    throw new Error(`${state} work history toggle was not visible`);
  }
  return option;
}

export function findWorkHistoryToggle(
  state: "collapsed" | "expanded",
  container: ParentNode = document.body,
): Promise<HTMLElement> {
  return waitFor(() => {
    return getWorkHistoryToggle(state, container);
  });
}

export function queryButton(
  name: string,
  container: ParentNode = document.body,
): HTMLElement | null {
  return (
    queryAllByRoleFast("button", container).find((element) => {
      return matchesAccessibleName(element, name);
    }) ?? null
  );
}

export function findButton(name: string): Promise<HTMLElement> {
  return waitFor(() => {
    const button = queryButton(name);
    if (!button) {
      throw new Error(`Button ${name} was not visible`);
    }
    return button;
  });
}

export function findEnabledButton(
  name: string,
  container: ParentNode = document.body,
): Promise<HTMLElement> {
  return waitFor(() => {
    const button = queryButton(name, container);
    expect(button).toBeEnabled();
    return button!;
  });
}

export function findLink(name: string): Promise<HTMLElement> {
  return waitFor(() => {
    const link = queryAllByRoleFast("link").find((element) => {
      return matchesAccessibleName(element, name);
    });
    if (!link) {
      throw new Error(`Link ${name} was not visible`);
    }
    return link;
  });
}

export async function readyChat(): Promise<HTMLElement> {
  const composer = await screen.findByRole("textbox", { name: "Message" });
  expect(composer).toBeVisible();
  return (
    screen.queryByRole("region", { name: "Chat thread" }) ??
    composer.closest("main") ??
    composer
  );
}

export async function sendText(text: string): Promise<void> {
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await fillComposer(composer, text);
  const currentComposer = await screen.findByRole("textbox", {
    name: "Message",
  });
  await findEnabledButton("Send");
  const user = userEvent.setup({ delay: null });
  await user.click(currentComposer);
  await user.keyboard("{Enter}");
  await waitFor(() => {
    expect(
      screen.getByRole("textbox", { name: "Message" }).textContent?.trim(),
    ).toBe("");
  });
}

function textDocument(
  text: string,
  model?: string,
  serviceTier?: "priority" | null,
): UserMessageDocument {
  return {
    version: 1,
    parts: [
      { type: "text", text },
      ...(model
        ? [
            {
              type: "model" as const,
              selectedModel: model,
              ...(serviceTier === "priority" ? { serviceTier } : {}),
            },
          ]
        : []),
    ],
  };
}

export function promptEvent(args: {
  readonly id: string;
  readonly runId?: string;
  readonly seqId: number;
  readonly text: string;
  readonly createdAt?: string;
  readonly model?: string;
  readonly serviceTier?: "priority" | null;
}): MockChatEventInput {
  return {
    id: args.id,
    role: "user",
    content: args.text,
    runId: args.runId,
    seqId: args.seqId,
    createdAt:
      args.createdAt ??
      `2026-08-01T10:00:${String(args.seqId).padStart(2, "0")}.000Z`,
    userMessage: textDocument(args.text, args.model, args.serviceTier),
  };
}

export function assistantEvent(args: {
  readonly id: string;
  readonly runId: string;
  readonly seqId: number;
  readonly text: string;
  readonly createdAt?: string;
}): MockChatEventInput {
  return {
    id: args.id,
    role: "assistant",
    content: args.text,
    runId: args.runId,
    seqId: args.seqId,
    createdAt:
      args.createdAt ??
      `2026-08-01T10:00:${String(args.seqId).padStart(2, "0")}.000Z`,
  };
}

export function thinkingEvent(args: {
  readonly id: string;
  readonly runId: string;
  readonly seqId: number;
  readonly text: string;
}): MockChatEventInput {
  return {
    id: args.id,
    role: "assistant",
    content: null,
    thinking: args.text,
    runId: args.runId,
    seqId: args.seqId,
    createdAt: `2026-08-01T10:00:${String(args.seqId).padStart(2, "0")}.000Z`,
  };
}

export function completedEvent(args: {
  readonly id: string;
  readonly runId: string;
  readonly seqId: number;
  readonly createdAt?: string;
}): MockChatEventInput {
  return {
    id: args.id,
    role: "assistant",
    content: null,
    runId: args.runId,
    runLifecycleEvent: "completed",
    seqId: args.seqId,
    createdAt:
      args.createdAt ??
      `2026-08-01T10:00:${String(args.seqId).padStart(2, "0")}.000Z`,
  };
}

export function cancelledEvent(args: {
  readonly id: string;
  readonly runId: string;
  readonly seqId: number;
}): MockChatEventInput {
  return {
    id: args.id,
    role: "assistant",
    content: null,
    runId: args.runId,
    error: "Run cancelled",
    runLifecycleEvent: "cancelled",
    seqId: args.seqId,
    createdAt: `2026-08-01T10:00:${String(args.seqId).padStart(2, "0")}.000Z`,
  };
}

export function usageEvent(args: {
  readonly id: string;
  readonly runId: string;
  readonly seqId: number;
  readonly usage: ChatEventUsagePayload;
  readonly revokesEventId?: string;
}): MockChatEventInput {
  return {
    id: args.id,
    role: "assistant",
    content: null,
    runId: args.runId,
    usage: args.usage,
    seqId: args.seqId,
    ...(args.revokesEventId === undefined
      ? {}
      : { revokesEventId: args.revokesEventId }),
    createdAt: args.usage.settledAt,
  };
}

export function creditUsage(
  totalCredits: number,
  breakdown: ChatEventUsagePayload["breakdown"],
  settledAt = "2026-08-01T10:01:00.000Z",
): ChatEventUsagePayload {
  return { version: 1, totalCredits, settledAt, breakdown };
}

export function expectTextOrder(...texts: readonly string[]): void {
  const elements = texts.map((text) => {
    return screen.getByText(text);
  });
  for (let index = 1; index < elements.length; index += 1) {
    const previous = elements[index - 1];
    const current = elements[index];
    if (!previous || !current) {
      throw new Error("Missing ordered chat text");
    }
    expect(
      previous.compareDocumentPosition(current) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  }
}
