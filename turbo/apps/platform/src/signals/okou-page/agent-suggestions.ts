import { command } from "ccstate";
import type {
  Suggestion,
  SuggestionOption,
} from "@okouai/api-contracts/contracts/suggestions";
import { currentAgentId$, defaultAgentId$ } from "../agent.ts";
import { rootSignal$ } from "../root-signal.ts";
import { navigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import {
  ensureDraft$,
  resumeThreadDraftHandoff$,
} from "../chat-page/create-chat-thread.ts";
import { ensureAgentDraft$ } from "./agent-draft.ts";
import { resetSignal } from "../utils.ts";
import { agentSuggestionEntries$ } from "./agent-suggestion-session.ts";
import { agentChatComposerSignals$ } from "./agent-composer-signals.ts";
import { createRestoredAttachment } from "./chat-draft.ts";
import {
  messageDocumentToPrompt,
  textToMessageDocument,
} from "./user-message-document-codec.ts";
import {
  readSuggestionContext,
  suggestionContextPart,
  suggestionFeedbacks,
} from "@okouai/api-contracts/contracts/suggestion-context";
import type {
  UserMessageDocument,
  FeedbackNotePart,
  ComposerDraft,
} from "@okouai/api-contracts/contracts/chat-threads";

async function suggestionDraftVersion(draft: ComposerDraft): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(draft)),
      ),
    ),
  )
    .map((byte) => {
      return byte.toString(16).padStart(2, "0");
    })
    .join("");
}

function withSuggestionContext(
  current: UserMessageDocument | null,
  item: Suggestion,
  contextVersion: string,
  attachmentIds: readonly string[],
): UserMessageDocument {
  const previous = current ? suggestionFeedbacks(current) : [];
  const parts =
    current?.parts.filter((part, index) => {
      return (
        readSuggestionContext(part) === null &&
        !(
          part.type === "feedback" &&
          readSuggestionContext(current.parts[index - 1])
        )
      );
    }) ?? [];
  const note: FeedbackNotePart[] = previous.flatMap(({ part }, index) => {
    return index === 0
      ? part.note
      : [{ type: "text", text: "\n" }, ...part.note];
  });
  const background = item.customOption.draft.draftUserMessage?.parts.find(
    (part) => {
      return part.type === "feedback";
    },
  );
  if (background?.type !== "feedback") {
    throw new Error("Missing suggestion background");
  }
  const document: UserMessageDocument = {
    version: 1,
    parts: [
      ...parts,
      suggestionContextPart({
        draftId: previous[0]?.context.draftId ?? crypto.randomUUID(),
        suggestionId: item.id,
        optionId: "custom",
        titleSnapshot: item.title,
        rationaleSnapshot: item.rationale,
        contextVersion,
        attachmentIds: [...attachmentIds],
      }),
      { ...background, note },
    ],
  };
  return document;
}

const resetPreparation$ = resetSignal();

/**
 * The Feed has no composer of its own. A prepared draft continues in the
 * default agent's home, whose setup loads and persists any pending handoff.
 */
const openAgentComposer$ = command(
  async ({ get, set }, agentId: string, signal: AbortSignal) => {
    await set(
      navigateTo$,
      ROUTES.agentChat,
      { pathParams: { agentId } },
      signal,
    );
    signal.throwIfAborted();
    // The home recovers an unreachable agent onto another surface; focus only
    // the composer that received the draft.
    if (get(currentAgentId$) === agentId) {
      set(get(agentChatComposerSignals$).editor.focus$);
    }
  },
);

/** Prepare the saved, complete context in the default agent's composer without consuming it. */
export const prepareAgentSuggestion$ = command(
  async ({ get, set }, item: Suggestion, pageSignal: AbortSignal) => {
    const signal = set(resetPreparation$, pageSignal);
    const agentId = await get(defaultAgentId$);
    signal.throwIfAborted();
    if (!agentId) {
      throw new Error("Suggestion target is unavailable");
    }
    const entry = set(ensureAgentDraft$, agentId);
    await set(entry.load$, signal);
    const draft = entry.draft;
    const contextVersion = await suggestionDraftVersion(
      item.customOption.draft,
    );
    signal.throwIfAborted();
    const cards = await get(agentSuggestionEntries$);
    signal.throwIfAborted();
    if (
      !cards.some((card) => {
        return card.item.id === item.id && !get(card.hidden$);
      })
    ) {
      return;
    }
    const current =
      set(draft.readEditorDocument$)?.toMessageDocument({
        selectedTemplate: get(draft.generationTemplate$),
      }) ??
      set(draft.peekRestoredUserMessage$) ??
      textToMessageDocument(get(draft.input$));
    const previous = current ? suggestionFeedbacks(current) : [];
    const currentAttachmentIds = new Set(
      get(draft.attachments$).map((attachment) => {
        return attachment.restoredFileId;
      }),
    );
    if (
      previous.some(({ context }) => {
        return (
          context.suggestionId === item.id &&
          context.contextVersion === contextVersion &&
          (item.customOption.draft.draftAttachments ?? []).every((file) => {
            return currentAttachmentIds.has(file.id);
          })
        );
      })
    ) {
      await set(openAgentComposer$, agentId, get(rootSignal$));
      return;
    }
    const oldAttachmentIds = new Set(
      previous.flatMap(({ context }) => {
        return context.attachmentIds;
      }),
    );
    for (const attachment of get(draft.attachments$)) {
      if (oldAttachmentIds.has(attachment.restoredFileId ?? "")) {
        set(attachment.cancel$);
      }
    }
    const attachments = get(draft.attachments$).filter((attachment) => {
      return !oldAttachmentIds.has(attachment.restoredFileId ?? "");
    });
    const addedAttachments = (
      item.customOption.draft.draftAttachments ?? []
    ).filter((attachment) => {
      return !attachments.some((existing) => {
        return existing.restoredFileId === attachment.id;
      });
    });
    const document = withSuggestionContext(
      current,
      item,
      contextVersion,
      addedAttachments.map((attachment) => {
        return attachment.id;
      }),
    );
    const content = messageDocumentToPrompt(document);
    if (content === null) {
      throw new Error("Invalid suggestion background");
    }
    // Leaving the Feed is part of this action, so the installed context is
    // reconciled, saved and opened beyond the Feed visit.
    const committed = get(rootSignal$);
    const seeded = set(
      draft.seed$,
      {
        content,
        userMessage: document,
        generationTemplate: get(draft.generationTemplate$),
        attachments: [
          ...attachments,
          ...addedAttachments.map(createRestoredAttachment),
        ],
      },
      committed,
    );
    await Promise.all([
      seeded,
      set(entry.queueDraftSync$, committed),
      set(openAgentComposer$, agentId, committed),
    ]);
  },
);

const applyAgentSuggestionDraft$ = command(
  async (
    { get, set },
    option: SuggestionOption,
    agentId: string,
    signal: AbortSignal,
  ) => {
    const target =
      option.threadId === null ? set(ensureAgentDraft$, agentId) : null;
    const draft =
      option.threadId !== null
        ? set(ensureDraft$, option.threadId)
        : set(ensureAgentDraft$, agentId).draft;
    // Installing the draft is synchronous; attachment reconciliation and
    // persistence must not delay focus or navigation.
    const installed = set(draft.prependComposerDraft$, option.draft, signal);
    if (option.threadId !== null) {
      await Promise.all([
        installed,
        set(
          navigateTo$,
          ROUTES.chat,
          {
            pathParams: { threadId: option.threadId },
          },
          signal,
        ),
      ]);
      signal.throwIfAborted();
      // The destination normally loads and persists its handoff. An unavailable
      // target has no composer, so retain the prepared draft through that path too.
      if (get(draft.composerDraftHandoff$)) {
        await set(resumeThreadDraftHandoff$, option.threadId, signal);
      }
      return;
    }
    if (!target) {
      throw new Error("Suggestion target is unavailable");
    }
    await Promise.all([installed, set(openAgentComposer$, agentId, signal)]);
    signal.throwIfAborted();
    // The agent home normally loads and persists its handoff. A recovered
    // destination has no composer, so retain the prepared draft here too.
    if (get(draft.composerDraftHandoff$)) {
      await set(target.load$, signal);
    }
  },
);

export const startAgentSuggestion$ = command(
  async (
    { get, set },
    item: Suggestion,
    optionId: string,
    pageSignal: AbortSignal,
  ): Promise<void> => {
    const [entries, agentId] = await Promise.all([
      get(agentSuggestionEntries$),
      get(defaultAgentId$),
    ]);
    pageSignal.throwIfAborted();
    const entry = entries.find((candidate) => {
      return candidate.item.id === item.id;
    });
    if (!entry || get(entry.hidden$)) {
      return;
    }
    const option = item.options.find((candidate) => {
      return candidate.id === optionId;
    });
    if (!option) {
      throw new Error("Suggestion option is unavailable");
    }
    if (!agentId) {
      throw new Error("Suggestion target is unavailable");
    }
    const signal = get(rootSignal$);
    set(resetPreparation$);
    set(entry.hidden$, true);
    // The loaded card owns this visit's choice and draft. Recording the choice
    // cannot replace it with a later server version or hold the card in place.
    await Promise.all([
      set(entry.enqueue$, { type: "consume", optionId }, signal),
      set(applyAgentSuggestionDraft$, option, agentId, signal),
    ]);
  },
);
