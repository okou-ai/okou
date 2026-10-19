import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  suggestionsContract,
  type Suggestion,
} from "@okouai/api-contracts/contracts/suggestions";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
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
  createThreadComposerSignals,
} from "../chat-page/create-chat-thread.ts";
import { ensureAgentDraft$ } from "./agent-draft.ts";
import { createIsolatedAgentComposerSignals } from "./agent-composer-signals.ts";
import { createChatEventSignals } from "../chat-page/chat-event-signals.ts";
import { createThreadMetaLookup } from "../chat-page/chat-thread-event-sourcing.ts";
import { createRestoredAttachment } from "./chat-draft.ts";
import {
  draftToEditorDoc,
  messageDocumentToPrompt,
  userMessageDraftAttachments,
} from "./user-message-document-codec.ts";
import { detach, Reason, resetSignal, settle, withCleanup } from "../utils.ts";

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
const consumedIds$ = state<readonly string[]>([]);
const startingSuggestion$ = state<Suggestion | null>(null);
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
  const consumed = get(consumedIds$);
  const starting = get(startingSuggestion$);
  const index = get(index$);
  const items = (await get(agentSuggestions$)).filter((item) => {
    return item.id === starting?.id || !consumed.includes(item.id);
  });
  // Keep the initiating card visible while consumption removes it from the
  // server pool, so its loading state stays attached to the action it owns.
  if (
    starting &&
    !items.some((item) => {
      return item.id === starting.id;
    })
  ) {
    items.splice(Math.min(index, items.length), 0, starting);
  }
  return items;
});
const reload$ = command(({ set }) => {
  set(revision$, (value) => {
    return value + 1;
  });
});
export const enterAgentSuggestions$ = command(({ set }) => {
  set(index$, 0);
  set(consumedIds$, []);
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
  },
);
/**
 * Hides the suggestion at once and consumes it on the server. Dismissing a
 * suggestion is this alone; starting one goes on to send its message. Resolves to
 * the consumed suggestion, or to null when it was already consumed here or
 * elsewhere.
 */
export const consumeAgentSuggestion$ = command(
  async ({ get, set }, item: Suggestion, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (get(consumedIds$).includes(item.id)) {
      return null;
    }
    set(consumedIds$, (ids) => {
      return [...ids, item.id];
    });
    const result = await accept(
      get(apiClient$)(suggestionsContract).consume({
        params: { id: item.id },
        body: {},
        fetchOptions: { signal },
      }),
      [200, 409],
    );
    signal.throwIfAborted();
    set(reload$);
    return result.status === 200 ? result.body : null;
  },
);
const lookupSuggestionThread$ = createThreadMetaLookup();
const resetSuggestionExecution$ = resetSignal();
export const agentSuggestionStarting$ = computed((get) => {
  return get(startingSuggestion$) !== null;
});
interface SuggestionTarget {
  readonly agentId: string;
  readonly threadId: string | null;
}
const target$ = state<SuggestionTarget | null>(null);
// Construct the isolated graph outside command execution. One invocation owns
// it until the finite send completes, including the navigation it initiates.
const runner$ = computed((get) => {
  const target = get(target$);
  if (!target) {
    return null;
  }
  if (target.threadId) {
    const events = createChatEventSignals(target.threadId);
    return {
      composer: createThreadComposerSignals(
        target.threadId,
        target.agentId,
        events,
        { preserveThreadDraft: true },
      ),
      events,
    };
  }
  return {
    composer: createIsolatedAgentComposerSignals(target.agentId),
    events: null,
  };
});

const restoreAgentSuggestionDraft$ = command(
  async ({ set }, item: Suggestion, agentId: string, signal: AbortSignal) => {
    if (item.threadId !== null) {
      const draft = set(ensureDraft$, item.threadId);
      await set(draft.prependComposerDraft$, item.draft, signal);
      signal.throwIfAborted();
      set(detachedNavigateTo$, ROUTES.chat, {
        pathParams: { threadId: item.threadId },
      });
      return;
    }
    const target = set(ensureAgentDraft$, agentId);
    await set(target.draft.prependComposerDraft$, item.draft, signal);
    await set(target.load$, signal);
    signal.throwIfAborted();
    set(detachedNavigateTo$, ROUTES.agentChat, {
      pathParams: { agentId },
    });
  },
);

const sendAgentSuggestion$ = command(
  async (
    { get, set },
    item: Suggestion,
    primary: string,
    signal: AbortSignal,
  ) => {
    const agentId =
      item.threadId === null
        ? primary
        : (await set(lookupSuggestionThread$, item.threadId, signal)).meta
            ?.agentId;
    signal.throwIfAborted();
    if (!agentId) {
      throw new Error("Suggestion target is unavailable");
    }
    set(target$, { agentId, threadId: item.threadId });
    const runner = get(runner$);
    if (!runner) {
      throw new Error("Suggestion target is unavailable");
    }
    const { composer, events } = runner;
    const message = item.draft.draftUserMessage;
    const document = draftToEditorDoc(message);
    const content = message ? messageDocumentToPrompt(message) : null;
    if (!message || !document || content === null) {
      throw new Error("Invalid suggestion message");
    }
    const attachments = userMessageDraftAttachments(
      message,
      item.draft.draftAttachments ?? [],
    );
    if (
      attachments.length !==
      message.parts.filter((part) => {
        return part.type === "file";
      }).length
    ) {
      return false;
    }
    const removedAttachments = await set(
      composer.draft.seed$,
      {
        content,
        userMessage: message,
        generationTemplate: message.parts.find((part) => {
          return part.type === "template";
        })?.template,
        attachments: attachments.map(createRestoredAttachment),
      },
      signal,
    );
    // Sending a partial suggestion could change its meaning. Let the member
    // recover and repair its draft when a referenced attachment is unavailable.
    if (removedAttachments) {
      return false;
    }
    composer.editor.editor.commands.setContent(document);
    if (events) {
      await set(events.setup$, signal);
      await set(events.catchUp$, signal);
    }
    signal.throwIfAborted();
    const action = await get(composer.submission.primaryAction$);
    signal.throwIfAborted();
    if (action !== "send" && action !== "queue") {
      return false;
    }
    const sent = await set(
      composer.submission.submitCurrentInput$,
      action,
      undefined,
      signal,
    );
    signal.throwIfAborted();
    if (sent && item.threadId !== null) {
      set(detachedNavigateTo$, ROUTES.chat, {
        pathParams: { threadId: item.threadId },
      });
    }
    return sent;
  },
);

const consumeAndRunAgentSuggestion$ = command(
  async ({ get, set }, item: Suggestion, signal: AbortSignal) => {
    const primary = await get(defaultAgentId$);
    signal.throwIfAborted();
    if (!primary) {
      throw new Error("Primary Agent is unavailable");
    }
    const selected = await set(consumeAgentSuggestion$, item, signal);
    if (selected === null) {
      return;
    }
    // The consume response owns the current content and destination.
    const result = await settle(
      set(sendAgentSuggestion$, selected, primary, signal),
      signal,
    );
    if (result.ok && result.value) {
      return;
    }
    toast.error(
      i18n.t(($) => {
        return $.chat.agentSuggestions.runFailed;
      }),
      {
        duration: Infinity,
        description: i18n.t(($) => {
          return $.chat.agentSuggestions.recoveryHint;
        }),
        action: {
          label: i18n.t(($) => {
            return $.chat.agentSuggestions.restoreDraft;
          }),
          onClick: () => {
            detach(
              set(
                restoreAgentSuggestionDraft$,
                selected,
                primary,
                get(rootSignal$),
              ),
              Reason.DomCallback,
            );
          },
        },
      },
    );
  },
);

export const startAgentSuggestion$ = command(
  async ({ get, set }, item: Suggestion, pageSignal: AbortSignal) => {
    pageSignal.throwIfAborted();
    if (
      get(startingSuggestion$) !== null ||
      get(consumedIds$).includes(item.id)
    ) {
      return;
    }
    set(startingSuggestion$, item);
    // Consumption and sending belong to this accepted action, so navigating
    // away must not interrupt the handoff between the two requests.
    const signal = set(resetSuggestionExecution$, get(rootSignal$));
    await withCleanup(set(consumeAndRunAgentSuggestion$, item, signal), () => {
      set(resetSuggestionExecution$);
      get(runner$)?.composer.editor.editor.destroy();
      set(target$, null);
      set(startingSuggestion$, null);
    });
  },
);
