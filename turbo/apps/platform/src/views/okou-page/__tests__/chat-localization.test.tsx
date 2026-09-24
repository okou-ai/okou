import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
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
import { pathname, search } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { SupportedLocale } from "../../../i18n/resources.ts";
import {
  buildModelPolicy,
  buildProvider,
  OPENROUTER_PROVIDER_ID,
} from "./chat-composer-test-helpers.ts";

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "b0000000-0000-4000-a000-000000000081";
const CREATED_AT = "2026-08-01T10:00:00.000Z";

const context = testContext();

interface ComposerCopy {
  readonly close: string;
  readonly language: string;
  readonly locale: SupportedLocale;
  readonly option: string;
  readonly settings: string;
}

const portuguese = {
  locale: "pt-BR",
  settings: "Configurações",
  language: "Idioma",
  close: "Fechar",
  option: "Português (Brasil)",
} as const satisfies ComposerCopy;
const english = {
  locale: "en-US",
  settings: "Settings",
  language: "Language",
  close: "Close",
  option: "English",
} as const satisfies ComposerCopy;

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
    renamedAt: null,
    selectedModel: "claude-sonnet-5",
    serviceTier: null,
    modelSettings: {},
    computerUseHostId: null,
    cloudBrowserEnabled: false,
    selectedVideoModel: null,
    selectedImageModel: null,
  };
}

function configureModelRoute(): void {
  context.mocks.data.orgModelProviders([
    buildProvider({
      id: OPENROUTER_PROVIDER_ID,
      type: "openrouter-api-key",
      secretName: "OPENROUTER_API_KEY",
    }),
  ]);
  context.mocks.data.orgModelPolicies([
    buildModelPolicy({
      id: "00000000-0000-4000-a000-000000000081",
      model: "claude-sonnet-5",
      modelLabel: "Claude Sonnet 5",
      isDefault: true,
      defaultProviderType: "openrouter-api-key",
      credentialScope: "org",
      modelProviderId: OPENROUTER_PROVIDER_ID,
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
    selectedVideoModel: null,
    selectedImageModel: null,
    updatedAt: null,
  });
  configureModelRoute();
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      chatThreads: [chatThread(args.title)],
      latestEventId: null,
      latestSeqId: null,
    });
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

async function changeLanguage(
  current: ComposerCopy,
  next: ComposerCopy,
): Promise<void> {
  click(await findAction("button", "Test User"));
  const menu = await screen.findByRole("menu");
  click(await findAction("menuitem", current.settings, menu));

  const dialog = await screen.findByRole("dialog", {
    name: current.settings,
  });
  click(await findAction("combobox", current.language, dialog));
  click(await findAction("option", next.option));

  await waitFor(() => {
    expect(document.documentElement).toHaveAttribute("lang", next.locale);
  });
  const translatedDialog = await screen.findByRole("dialog", {
    name: next.settings,
  });
  click(await findAction("button", next.close, translatedDialog));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: next.settings }),
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

test("Changing language preserves the open conversation and draft", async () => {
  const title = "Planejamento semanal";
  const draft = "Rascunho ainda não enviado";

  configureExistingChat({
    draft: userMessage(draft),
    title,
  });

  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
  });

  const titleCopies = await screen.findAllByText(title);
  const visibleTitle = titleCopies.find((element) => {
    return element.closest("header") !== null;
  });
  expect(visibleTitle).toBeVisible();
  const originalComposer = composerEditor();
  expect(originalComposer).toHaveTextContent(draft);
  const originalUrl = `${pathname()}${search()}`;

  await changeLanguage(portuguese, english);

  const translatedComposer = composerEditor();
  expect(`${pathname()}${search()}`).toBe(originalUrl);
  expect(translatedComposer).toHaveTextContent(draft);
  const translatedTitleCopies = screen.getAllByText(title);
  const translatedVisibleTitle = translatedTitleCopies.find((element) => {
    return element.closest("header") !== null;
  });
  expect(translatedVisibleTitle).toBeVisible();
});
