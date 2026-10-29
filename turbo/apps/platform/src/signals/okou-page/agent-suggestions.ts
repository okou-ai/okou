import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  suggestionsContract,
  getSuggestionExpiresAt,
  type Suggestion,
  type SuggestionOption,
  type SuggestionFeedbackRequest,
} from "@okouai/api-contracts/contracts/suggestions";
import { accept } from "../../lib/accept.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { defaultAgentId$ } from "../agent.ts";
import { currentChatAgentId$ } from "../agent-chat.ts";
import { apiClient$ } from "../api-client.ts";
import { setAblyInvalidationLoop$ } from "../realtime.ts";
import { rootSignal$ } from "../root-signal.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import {
  ensureDraft$,
  resumeThreadDraftHandoff$,
} from "../chat-page/create-chat-thread.ts";
import { ensureAgentDraft$ } from "./agent-draft.ts";
import { now } from "../../lib/time.ts";
import { setLoop, settle } from "../utils.ts";
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

export const preparedAgentSuggestionId$ = computed((get) => {
  return (
    get(get(agentChatComposerSignals$).feedback.items$).find((item) => {
      return item.suggestionContext;
    })?.suggestionContext?.suggestionId ?? null
  );
});

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

/** Prepare the saved, complete context in the existing composer without consuming it. */
export const prepareAgentSuggestion$ = command(
  async ({ get, set }, item: Suggestion, signal: AbortSignal) => {
    const agentId = await get(defaultAgentId$);
    signal.throwIfAborted();
    if (!agentId || get(agentChatComposerSignals$).agentId !== agentId) {
      throw new Error("Suggestion target is unavailable");
    }
    const entry = set(ensureAgentDraft$, agentId);
    await set(entry.load$, signal);
    const draft = entry.draft;
    const contextVersion = await suggestionDraftVersion(
      item.customOption.draft,
    );
    signal.throwIfAborted();
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
      set(get(agentChatComposerSignals$).editor.focus$);
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
          attachmentIds: addedAttachments.map((attachment) => {
            return attachment.id;
          }),
        }),
        { ...background, note },
      ],
    };
    const content = messageDocumentToPrompt(document);
    if (content === null) {
      throw new Error("Invalid suggestion background");
    }
    await set(
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
      signal,
    );
    set(get(agentChatComposerSignals$).editor.focus$);
    await set(entry.queueDraftSync$, signal);
  },
);

export const agentSuggestionsEnabled$ = computed(async (get) => {
  if (!get(featureSwitch$)[FeatureSwitchKey.AgentSuggestion]) {
    return false;
  }
  const [current, primary] = await Promise.all([
    get(currentChatAgentId$),
    get(defaultAgentId$),
  ]);
  return primary !== null && current === primary;
});
const revision$ = state(0);
const expiryRevision$ = state(0);
const consumedIds$ = state<readonly string[]>([]);
interface OptimisticFeedback {
  readonly suggestionId: string;
  readonly feedbackId: string;
}
const optimisticFeedbacks$ = state<readonly OptimisticFeedback[]>([]);
const latestFeedbackIntent$ = state<string | null>(null);
export const savingSuggestionFeedback$ = computed((get) => {
  return get(optimisticFeedbacks$).length > 0;
});

interface FeedbackConfirmation {
  readonly item: Suggestion;
  readonly id: string;
  readonly undoId: string;
  readonly kind:
    "already_done" | "not_planned" | "less_like_this" | "dismissed";
  readonly reasonSaved: boolean;
  readonly note: string;
}
const feedbackConfirmation$ = state<FeedbackConfirmation | null>(null);
export const suggestionFeedbackConfirmation$ = computed((get) => {
  return get(feedbackConfirmation$);
});
const feedbackReasonOpen$ = state(false);
export const suggestionFeedbackReasonOpen$ = computed((get) => {
  return get(feedbackReasonOpen$);
});
const feedbackRequests$ = state<Readonly<Record<string, string>>>({});
export const closeSuggestionFeedback$ = command(({ set }) => {
  set(feedbackConfirmation$, null);
  set(feedbackReasonOpen$, false);
});
export const openSuggestionFeedbackReason$ = command(({ set }) => {
  set(feedbackReasonOpen$, true);
});
const feedbackRequestId$ = command(({ get, set }, key: string) => {
  const existing = get(feedbackRequests$)[key];
  if (existing) {
    return existing;
  }
  const id = crypto.randomUUID();
  set(feedbackRequests$, { ...get(feedbackRequests$), [key]: id });
  return id;
});
export const submitAgentSuggestionFeedback$ = command(
  async (
    { get, set },
    item: Suggestion,
    kind: "already_done" | "not_planned" | "less_like_this" | "dismissed",
    signal: AbortSignal,
  ) => {
    const key = `${item.id}:${kind}`;
    const id = set(feedbackRequestId$, key);
    if (
      get(optimisticFeedbacks$).some((entry) => {
        return entry.suggestionId === item.id;
      })
    ) {
      return;
    }
    set(latestFeedbackIntent$, id);
    set(optimisticFeedbacks$, [
      ...get(optimisticFeedbacks$),
      { suggestionId: item.id, feedbackId: id },
    ]);
    const outcome = await settle(
      accept(
        get(apiClient$)(suggestionsContract).feedback({
          params: { id: item.id },
          body: {
            id,
            kind,
            targetId: null,
            note: "",
            snapshot: item.consumeToken ? item : undefined,
          },
          fetchOptions: { signal },
        }),
        [200, 409],
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();
    set(
      optimisticFeedbacks$,
      get(optimisticFeedbacks$).filter((entry) => {
        return entry.feedbackId !== id;
      }),
    );
    if (!outcome.ok) {
      set(reload$);
      throw outcome.error;
    }
    const result = outcome.value;
    set(consumedIds$, [...get(consumedIds$), item.id]);
    if (result.status === 200 && get(latestFeedbackIntent$) === id) {
      set(
        feedbackRequests$,
        Object.fromEntries(
          Object.entries(get(feedbackRequests$)).filter(([entryKey]) => {
            return entryKey !== key;
          }),
        ),
      );
      set(feedbackConfirmation$, {
        item,
        id,
        undoId: crypto.randomUUID(),
        kind,
        reasonSaved: false,
        note: "",
      });
      set(feedbackReasonOpen$, false);
    }
    set(reload$);
  },
);
export const undoSuggestionFeedback$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const last = get(suggestionFeedbackConfirmation$);
    if (!last) {
      return;
    }
    const result = await accept(
      get(apiClient$)(suggestionsContract).feedback({
        params: { id: last.item.id },
        body: {
          id: last.undoId,
          kind: "undo",
          targetId: last.id,
          note: "",
          snapshot: last.item.consumeToken ? last.item : undefined,
        },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    if (result.body.restored) {
      set(
        consumedIds$,
        get(consumedIds$).filter((id) => {
          return id !== last.item.id;
        }),
      );
    }
    if (get(suggestionFeedbackConfirmation$)?.id === last.id) {
      set(closeSuggestionFeedback$);
    }
    set(reload$);
  },
);
export const saveSuggestionFeedbackReason$ = command(
  async ({ get, set }, note: string, signal: AbortSignal) => {
    const last = get(suggestionFeedbackConfirmation$);
    if (!last) {
      return;
    }
    const request: SuggestionFeedbackRequest = {
      id: set(feedbackRequestId$, `${last.id}:${note}`),
      kind: "reason",
      targetId: last.id,
      note,
    };
    await accept(
      get(apiClient$)(suggestionsContract).feedback({
        params: { id: last.item.id },
        body: request,
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    if (get(suggestionFeedbackConfirmation$)?.id === last.id) {
      set(feedbackConfirmation$, { ...last, reasonSaved: true, note });
      set(feedbackReasonOpen$, false);
    }
  },
);
// The panel shows one suggestion at a time. A position rather than an id, so
// consuming the card on screen brings up the one after it, and consuming the
// last one falls back to the one before.
const index$ = state(0);
export const agentSuggestionIndex$ = computed((get) => {
  return get(index$);
});
export const showAgentSuggestion$ = command(({ set }, index: number) => {
  set(index$, index);
});
const agentSuggestions$ = computed(async (get) => {
  get(revision$);
  if (!(await get(agentSuggestionsEnabled$))) {
    return [];
  }
  // Suggestions are an optional entry on the home page, so a failed read
  // hides the tab instead of raising a toast over the composer.
  const result = await accept(
    get(apiClient$)(suggestionsContract).list({}),
    [200, 403],
    undefined,
    { showErrorToast: false },
  );
  return result.status === 200 ? result.body.suggestions : [];
});
export const visibleAgentSuggestions$ = computed(async (get) => {
  get(expiryRevision$);
  const consumed = get(consumedIds$);
  const optimistic = get(optimisticFeedbacks$);
  return (await get(agentSuggestions$)).filter((item) => {
    return (
      !consumed.includes(item.id) &&
      !optimistic.some((entry) => {
        return entry.suggestionId === item.id;
      }) &&
      getSuggestionExpiresAt(item) > now()
    );
  });
});
const reload$ = command(({ set }) => {
  set(revision$, (value) => {
    return value + 1;
  });
});
export const enterAgentSuggestions$ = command(({ set }) => {
  set(index$, 0);
  set(consumedIds$, []);
  set(optimisticFeedbacks$, []);
  set(latestFeedbackIntent$, null);
  set(feedbackRequests$, {});
  set(closeSuggestionFeedback$);
  set(reload$);
});
export const subscribeAgentSuggestions$ = command(
  ({ get, set }, signal: AbortSignal) => {
    if (!get(featureSwitch$)[FeatureSwitchKey.AgentSuggestion]) {
      return;
    }
    set(
      setAblyInvalidationLoop$,
      {
        scope: "credential",
        topic: "agentSuggestionsChanged",
        invalidations: [reload$],
        options: { runOnSubscribe: true },
      },
      signal,
    );
    // Expire already-loaded cards even if no curation or cleanup event arrives.
    // This only re-derives the cached collection; it does not poll the API.
    setLoop(
      () => {
        set(expiryRevision$, (value) => {
          return value + 1;
        });
        return false;
      },
      1000,
      signal,
      { testIntervalMs: 100 },
    );
  },
);
/**
 * Consume the suggestion on the server, then remove it from the panel.
 * Dismissing stops here; using a suggestion adds its content to a draft. Resolves to
 * the consumed suggestion, or to null when it was already consumed here or
 * elsewhere.
 */
const consumeAgentSuggestion$ = command(
  async (
    { get, set },
    item: Suggestion,
    optionId: string | null,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    if (get(consumedIds$).includes(item.id)) {
      return null;
    }
    const result = await accept(
      get(apiClient$)(suggestionsContract).consume({
        params: { id: item.id },
        body: {
          optionId,
          snapshot: item.consumeToken === undefined ? undefined : item,
        },
        fetchOptions: { signal },
      }),
      [200, 409],
      signal,
    );
    set(consumedIds$, (ids) => {
      return [...ids, item.id];
    });
    signal.throwIfAborted();
    set(reload$);
    return result.status === 200 ? result.body : null;
  },
);
const applyAgentSuggestionDraft$ = command(
  async (
    { set },
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
    await set(draft.prependComposerDraft$, option.draft, signal);
    if (option.threadId !== null) {
      await set(resumeThreadDraftHandoff$, option.threadId, signal);
      signal.throwIfAborted();
      set(detachedNavigateTo$, ROUTES.chat, {
        pathParams: { threadId: option.threadId },
      });
      return;
    }
    if (!target) {
      throw new Error("Suggestion target is unavailable");
    }
    await set(target.load$, signal);
    signal.throwIfAborted();
    set(detachedNavigateTo$, ROUTES.agentChat, {
      pathParams: { agentId },
    });
  },
);

export const startAgentSuggestion$ = command(
  async (
    { get, set },
    item: Suggestion,
    optionId: string,
    pageSignal: AbortSignal,
  ): Promise<void> => {
    pageSignal.throwIfAborted();
    if (
      !item.options.some((option) => {
        return option.id === optionId;
      })
    ) {
      throw new Error("Suggestion option is unavailable");
    }
    const signal = get(rootSignal$);
    // Resolve the new-thread destination before consuming. The accepted result
    // can change the target, so both new and existing cards need this identity.
    const agentId = await get(defaultAgentId$);
    signal.throwIfAborted();
    if (!agentId) {
      throw new Error("Suggestion target is unavailable");
    }
    const selected = await set(consumeAgentSuggestion$, item, optionId, signal);
    if (!selected) {
      return;
    }
    const option = selected.options.find((entry) => {
      return entry.id === selected.selectedOptionId;
    });
    if (!option || option.id !== optionId) {
      throw new Error(
        "Consumed suggestion does not contain the selected option",
      );
    }
    // Existing threads already have an authoritative ID. Install their draft
    // before any destination metadata or saved-draft request can fail.
    await set(applyAgentSuggestionDraft$, option, agentId, signal);
  },
);

export const dismissAgentSuggestion$ = command(
  async ({ set }, item: Suggestion, signal: AbortSignal) => {
    await set(submitAgentSuggestionFeedback$, item, "dismissed", signal);
  },
);
