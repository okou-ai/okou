import { browserContract } from "@okouai/api-contracts/contracts/browser";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  chatThreadDraftContract,
  chatThreadEventsContract,
  chatThreadsContract,
  type ChatThreadSnapshotProjection,
  type UserMessageInputDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import type { SupportedLocale } from "../../../i18n/resources.ts";
import {
  mockChatThreadSnapshotResponse,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { pathname, search } from "../../../signals/location.ts";
import { CLAUDE_SUBSCRIPTION_PROVIDER_ID } from "./chat-composer-test-helpers.ts";
import { buildProvider, buildRunModel } from "./chat-model-builders.ts";

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "b0000000-0000-4000-a000-000000000081";
const CREATED_AT = "2026-08-01T10:00:00.000Z";

const context = testContext();

interface LanguageChoice {
  readonly locale: SupportedLocale;
  readonly option: string;
}

const portuguese = {
  locale: "pt-BR",
  option: "Português (Brasil)",
} as const satisfies LanguageChoice;
const english = {
  locale: "en-US",
  option: "English",
} as const satisfies LanguageChoice;

function actionName(element: HTMLElement): string {
  return (
    element.getAttribute("aria-label") ?? element.textContent?.trim() ?? ""
  );
}

function getAction(
  role: "button" | "combobox" | "link" | "menuitem" | "option",
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const element = queryAllByRoleFast(role, container).find((candidate) => {
    return actionName(candidate) === name;
  });
  if (!element) {
    throw new Error(`Could not find ${role} named ${name}`);
  }
  return element;
}

function findAction(
  role: "button" | "combobox" | "link" | "menuitem" | "option",
  name: string,
  container: ParentNode = document.body,
): Promise<HTMLElement> {
  return waitFor(() => {
    return getAction(role, name, container);
  });
}

function userMessage(text: string): UserMessageInputDocument {
  return {
    version: 1,
    parts: [{ type: "text", text }],
  };
}

function chatThread(title: string): ChatThreadSnapshotProjection {
  return {
    id: THREAD_ID,
    agentId: AGENT_ID,
    title,
    sortAt: CREATED_AT,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    pinnedAt: null,
    archived: false,
    renamedAt: null,
    selectedModel: "claude-sonnet-5",
    serviceTier: null,
    modelSettings: {},
    computerUseHostId: null,
    cloudBrowserEnabled: false,
  };
}

function configureModelRoute(): void {
  context.mocks.data.personalModelProviders([
    buildProvider({
      id: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
      type: "claude-code-oauth-token",
    }),
  ]);
  context.mocks.data.availableRunModels([
    buildRunModel({
      model: "claude-sonnet-5",
      modelLabel: "Claude Sonnet 5",
      providerType: "claude-code-oauth-token",
      modelProviderId: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
    }),
  ]);
}

function configureNoBrowserSession(): void {
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "BROWSER_NOT_FOUND",
        message: "Managed browser not found",
      },
    });
  });
}

function configureExistingChat(args: {
  readonly draft: UserMessageInputDocument | null;
  readonly rows?: readonly ChatEventRow[];
  readonly title: string;
}): void {
  // Let real bootstrap load the user's existing locale once. The tested
  // language change happens later in Settings.
  context.mocks.browser.language(portuguese.locale);
  context.mocks.data.userPreferences({ locale: portuguese.locale });
  configureNoBrowserSession();
  context.mocks.data.agents([{ agentId: AGENT_ID }]);
  context.mocks.data.userModelPreference({
    selectedModel: "claude-sonnet-5",
    serviceTier: null,
    modelSettings: {},
    selectedImageModel: null,
    updatedAt: null,
  });
  configureModelRoute();
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(
      200,
      mockChatThreadSnapshotResponse(context, {
        chatThreads: [chatThread(args.title)],
        latestEventId: null,
        latestSeqId: null,
      }),
    );
  });
  context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: args.draft,
      draftAttachments: null,
    });
  });
  context.mocks.api(chatThreadEventsContract.rows, ({ respond }) => {
    const rows = [...(args.rows ?? [])];
    const lastRow = rows.at(-1);
    return respond(200, {
      rows,
      cursor: lastRow
        ? { lastEventId: lastRow.id, lastSeqId: lastRow.seqId }
        : { lastEventId: null, lastSeqId: 0 },
      hasMore: false,
    });
  });
}

async function changeLanguage(next: LanguageChoice): Promise<void> {
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  click(await findAction("combobox", "Language", dialog));
  click(await findAction("option", next.option));

  await waitFor(() => {
    expect(document.documentElement).toHaveAttribute("lang", next.locale);
  });
}

async function closeSettings(): Promise<void> {
  click(
    await findAction(
      "button",
      "Close",
      await screen.findByRole("dialog", { name: "Settings" }),
    ),
  );
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Settings" }),
    ).not.toBeInTheDocument();
  });
}

function composerEditor(): HTMLElement {
  const editor = document.querySelector<HTMLElement>(
    '[data-slot="chat-composer-card"] [contenteditable="true"]',
  );
  if (!editor) {
    throw new Error("Composer editor not found");
  }
  return editor;
}

async function openLocalizedChatWithDraft() {
  const title = "Planejamento semanal";
  const draft = "Rascunho ainda não enviado";

  configureExistingChat({
    draft: userMessage(draft),
    title,
  });

  await setupPage({
    context,
    path: `/chats/${THREAD_ID}?settings=preference`,
    locale: portuguese.locale,
  });
  await waitFor(() => {
    expect(document.documentElement).toHaveAttribute("lang", portuguese.locale);
  });

  return { title, draft };
}

test("Changing language preserves the conversation while Settings stays open", async () => {
  const { title } = await openLocalizedChatWithDraft();
  await screen.findByText(title, { selector: "header *" });
  const originalUrl = `${pathname()}${search()}`;

  await changeLanguage(english);

  expect(`${pathname()}${search()}`).toBe(originalUrl);
  expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  expect(screen.getByText(title, { selector: "header *" })).toBeInTheDocument();
});

test("Closing translated Settings preserves the conversation and unsent draft", async () => {
  const { title, draft } = await openLocalizedChatWithDraft();
  await screen.findByText(title, { selector: "header *" });
  const originalPath = pathname();
  await waitFor(() => {
    expect(composerEditor()).toHaveTextContent(draft);
  });

  await changeLanguage(english);
  await closeSettings();

  expect(`${pathname()}${search()}`).toBe(originalPath);
  expect(screen.getByText(title, { selector: "header *" })).toBeInTheDocument();
  expect(composerEditor()).toHaveTextContent(draft);
});
