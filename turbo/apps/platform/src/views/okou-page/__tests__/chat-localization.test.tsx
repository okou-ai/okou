import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import {
  chatEventsContract,
  chatThreadDraftContract,
  chatThreadEventsContract,
  chatThreadsContract,
  type ChatEventSendBody,
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
const RUN_ID = "a0000000-0000-4000-a000-000000000081";
const EVENT_ID = "e0000000-0000-4000-a000-000000000081";
const CREATED_AT = "2026-08-01T10:00:00.000Z";

const context = testContext();

interface ComposerCopy {
  readonly attach: string;
  readonly close: string;
  readonly language: string;
  readonly locale: SupportedLocale;
  readonly message: string;
  readonly option: string;
  readonly placeholder: string;
  readonly send: string;
  readonly settings: string;
}

const portuguese = {
  locale: "pt-BR",
  message: "Mensagem",
  placeholder: "Peça para automatizar fluxos de trabalho, gerenciar tarefas...",
  attach: "Anexar",
  send: "Enviar",
  settings: "Configurações",
  language: "Idioma",
  close: "Fechar",
  option: "Português (Brasil)",
} as const satisfies ComposerCopy;
const english = {
  locale: "en-US",
  message: "Message",
  placeholder: "Ask me to automate workflows, manage tasks...",
  attach: "Attach",
  send: "Send",
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
    selectedModel: "claude-sonnet-4-6",
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
      model: "claude-sonnet-4-6",
      modelLabel: "Claude Sonnet 4.6",
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
    selectedModel: "claude-sonnet-4-6",
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

function localizedComposer(copy: ComposerCopy): HTMLElement {
  const editor = document.querySelector<HTMLElement>(
    '[data-slot="chat-composer-card"] [contenteditable="true"]',
  );
  if (!editor) {
    throw new Error("Composer editor not found");
  }
  expect(editor).toHaveAttribute("aria-label", copy.message);
  return editor;
}

async function expectLocalizedComposerAttributes(
  copy: ComposerCopy,
  sendEnabled = false,
): Promise<HTMLElement> {
  const composer = await waitFor(() => {
    const editor = localizedComposer(copy);
    expect(editor).toHaveAttribute("placeholder", copy.placeholder);
    const root = editor.closest<HTMLElement>(
      "[data-slot='chat-composer-card']",
    );
    if (!root) {
      throw new Error("Composer root not found");
    }
    const buttons = Array.from(
      root.querySelectorAll<HTMLButtonElement>("button"),
    );
    const attach = buttons.find((button) => {
      return button.getAttribute("aria-label") === copy.attach;
    });
    const send = buttons.find((button) => {
      return button.getAttribute("aria-label") === copy.send;
    });
    expect(attach).toBeEnabled();
    expect(send?.disabled).toStrictEqual(!sendEnabled);
    return editor;
  });
  expect(document.documentElement).toHaveAttribute("lang", copy.locale);
  return composer;
}

test("A cancelled run keeps its meaning when the language changes", async () => {
  const activeRun: ChatEventRow = {
    id: EVENT_ID,
    chatThreadId: THREAD_ID,
    runId: RUN_ID,
    revokesEventId: null,
    contextType: null,
    contextId: null,
    runEventSequenceNumber: null,
    runEventId: null,
    seqId: 1,
    createdAt: CREATED_AT,
    eventType: "input.prompt",
    payload: {
      userMessage: {
        version: 1,
        parts: [{ type: "text", text: "Continue the active workflow" }],
      },
    },
  };
  let stoppedRequest: ChatEventSendBody | undefined;

  configureExistingChat({
    draft: null,
    rows: [activeRun],
    title: "Fluxo em andamento",
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    stoppedRequest = body;
    return respond(201, {
      runId: RUN_ID,
      threadId: THREAD_ID,
      status: "pending",
      createdAt: CREATED_AT,
    });
  });

  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
  });

  const stop = await findAction("button", "Parar");
  click(stop);

  const portugueseCancellation = await screen.findByText(
    "Pausado no meio do raciocínio — retome quando quiser.",
  );
  expect(portugueseCancellation).toBeVisible();
  await waitFor(() => {
    expect(stoppedRequest).toMatchObject({
      agentId: AGENT_ID,
      threadId: THREAD_ID,
      interruptsRunId: RUN_ID,
    });
  });

  await changeLanguage(portuguese, english);

  const englishCancellation = await screen.findByText(
    "Paused mid-thought — pick it back up whenever.",
  );
  expect(englishCancellation).toBeVisible();
  expect(
    screen.queryByText("Pausado no meio do raciocínio — retome quando quiser."),
  ).not.toBeInTheDocument();
  expect(pathname()).toBe(`/chats/${THREAD_ID}`);
});

test("Changing language translates the enabled composer controls", async () => {
  configureExistingChat({
    draft: userMessage("Rascunho ainda não enviado"),
    title: "Composer language",
  });

  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
  });
  await expectLocalizedComposerAttributes(portuguese, true);
  await changeLanguage(portuguese, english);

  const translatedComposer = await expectLocalizedComposerAttributes(
    english,
    true,
  );
  expect(translatedComposer).toHaveAttribute(
    "placeholder",
    english.placeholder,
  );
  const attach = await findAction("button", "Attach");
  const send = await findAction("button", "Send");
  expect(attach).toBeEnabled();
  expect(send).toBeEnabled();
});

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
  const originalComposer = await screen.findByRole("textbox", {
    name: "Mensagem",
  });
  expect(originalComposer).toHaveTextContent(draft);
  const originalUrl = `${pathname()}${search()}`;

  await changeLanguage(portuguese, english);

  const translatedComposer = await waitFor(() => {
    return localizedComposer(english);
  });
  expect(`${pathname()}${search()}`).toBe(originalUrl);
  expect(translatedComposer).toHaveTextContent(draft);
  const translatedTitleCopies = screen.getAllByText(title);
  const translatedVisibleTitle = translatedTitleCopies.find((element) => {
    return element.closest("header") !== null;
  });
  expect(translatedVisibleTitle).toBeVisible();
});
