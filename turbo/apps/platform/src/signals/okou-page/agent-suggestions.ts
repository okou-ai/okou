import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  suggestionsContract,
  type Suggestion,
} from "@okouai/api-contracts/contracts/suggestions";
import { accept } from "../../lib/accept.ts";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
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
import { detach, Reason, resetSignal, withCleanup } from "../utils.ts";

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
interface SuggestionCardContext {
  readonly item: Suggestion;
  // Once consumed, this card is a recoverable draft, not another consume/send.
  readonly recoveryAgentId: string | null;
  // Domain receipt: this consumed suggestion is already in the member's draft.
  readonly draftApplied?: boolean;
}
const cardContext$ = state<SuggestionCardContext | null>(null);
const running$ = state<Promise<void> | null>(null);
const operation$ = state<Promise<void> | undefined>(undefined);
export const agentSuggestionOperation$ = computed((get) => {
  return get(operation$);
});
export const agentSuggestionRecoveryId$ = computed((get) => {
  const context = get(cardContext$);
  return context?.recoveryAgentId ? context.item.id : null;
});
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
  const pinned = get(cardContext$)?.item;
  // An accepted action owns this card until send, restore or explicit dismissal.
  // Recovery must not depend on a fresh server pool containing a consumed entry,
  // or even on that optional list request succeeding after navigation.
  if (pinned) {
    return [pinned];
  }
  const consumed = get(consumedIds$);
  return (await get(agentSuggestions$)).filter((item) => {
    return !consumed.includes(item.id);
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
    let consumed = false;
    const result = await withCleanup(
      (async () => {
        const response = await accept(
          get(apiClient$)(suggestionsContract).consume({
            params: { id: item.id },
            body: {},
            fetchOptions: { signal },
          }),
          [200, 409],
        );
        consumed = true;
        signal.throwIfAborted();
        return response;
      })(),
      () => {
        // Failed optimistic consumption is retryable; an accepted consume (or
        // conflict) remains consumed even if this caller is then cancelled.
        if (!consumed) {
          set(consumedIds$, (ids) => {
            return ids.filter((id) => {
              return id !== item.id;
            });
          });
        }
      },
    );
    signal.throwIfAborted();
    set(reload$);
    return result.status === 200 ? result.body : null;
  },
);
const lookupSuggestionThread$ = createThreadMetaLookup();
const resetSuggestionExecution$ = resetSignal();
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
  async (
    { get, set },
    item: Suggestion,
    agentId: string,
    signal: AbortSignal,
  ) => {
    const target =
      item.threadId === null ? set(ensureAgentDraft$, agentId) : null;
    const draft =
      item.threadId !== null
        ? set(ensureDraft$, item.threadId)
        : set(ensureAgentDraft$, agentId).draft;
    if (!get(cardContext$)?.draftApplied) {
      // Validation/application throw synchronously. Only a returned command
      // result certifies that retry must never prepend this suggestion again.
      const pending = set(draft.prependComposerDraft$, item.draft, signal);
      set(cardContext$, { item, recoveryAgentId: agentId, draftApplied: true });
      await pending;
    } else {
      await set(draft.reconcileComposerDraft$, signal);
    }
    if (item.threadId !== null) {
      await set(resumeThreadDraftHandoff$, item.threadId, signal);
      signal.throwIfAborted();
      set(detachedNavigateTo$, ROUTES.chat, {
        pathParams: { threadId: item.threadId },
      });
      return;
    }
    if (!target) {
      throw new Error("Suggestion recovery target is unavailable");
    }
    const hadHandoff = get(draft.composerDraftHandoff$) !== null;
    await set(target.load$, signal);
    // A handoff load already awaits its save. After a prior save failure the
    // marker is gone and load$ can skip local input, so retry must save it once.
    if (!hadHandoff) {
      await set(target.queueDraftSync$, signal);
    }
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
      set(cardContext$, null);
      return;
    }
    // The consume response owns the current content and destination. Preserve
    // it for recovery on both a domain refusal and a rejected send, without
    // turning transport failures into fulfilled operations.
    set(cardContext$, { item: selected, recoveryAgentId: primary });
    if (await set(sendAgentSuggestion$, selected, primary, signal)) {
      set(cardContext$, null);
    }
  },
);

const runAgentSuggestion$ = command(
  async ({ get, set }, item: Suggestion, signal: AbortSignal) => {
    signal.throwIfAborted();
    const context = get(cardContext$);
    if (context?.item.id === item.id && context.recoveryAgentId) {
      await set(
        restoreAgentSuggestionDraft$,
        context.item,
        context.recoveryAgentId,
        signal,
      );
      signal.throwIfAborted();
      set(cardContext$, null);
      return;
    }
    set(cardContext$, { item, recoveryAgentId: null });
    await set(consumeAndRunAgentSuggestion$, item, signal);
  },
);

const showAgentSuggestionRecovery$ = command(
  ({ get, set }, item: Suggestion): void => {
    // This is a retained consumed-draft action, not a second HTTP error report.
    // It must survive the page that starting a new thread can unmount.
    toast.info(
      i18n.t(($) => {
        return $.chat.agentSuggestions.recoveryHint;
      }),
      {
        id: `suggestion-recovery-${item.id}`,
        duration: Infinity,
        action: {
          label: i18n.t(($) => {
            return $.chat.agentSuggestions.restoreDraft;
          }),
          onClick: () => {
            detach(
              set(startAgentSuggestion$, item, get(rootSignal$)),
              Reason.DomCallback,
            );
          },
        },
      },
    );
  },
);

export const startAgentSuggestion$ = command(
  (
    { get, set },
    item: Suggestion,
    pageSignal: AbortSignal,
  ): Promise<void> | undefined => {
    pageSignal.throwIfAborted();
    const running = get(running$);
    if (running) {
      return running;
    }
    const context = get(cardContext$);
    if (
      get(consumedIds$).includes(item.id) &&
      !(context?.item.id === item.id && context.recoveryAgentId)
    ) {
      return;
    }
    // Consumption, sending and draft recovery belong to the root-owned action,
    // not to the card that navigation can unmount. Keep the terminal Promise
    // observable while separately releasing exclusion and runner resources.
    const signal = set(resetSuggestionExecution$, get(rootSignal$));
    const operation = withCleanup(
      set(runAgentSuggestion$, item, signal),
      () => {
        const cancelled = signal.aborted;
        set(resetSuggestionExecution$);
        const runner = get(runner$);
        if (runner) {
          for (const attachment of get(runner.composer.draft.attachments$)) {
            set(attachment.cancel$);
          }
          runner.composer.editor.editor.destroy();
        }
        set(target$, null);
        // Drop the computed's memoized isolated graph as well as its target.
        get(runner$);
        set(running$, null);
        const recovery = get(cardContext$);
        if (!cancelled && recovery?.recoveryAgentId) {
          set(showAgentSuggestionRecovery$, recovery.item);
        } else {
          toast.dismiss(`suggestion-recovery-${item.id}`);
        }
      },
    );
    set(running$, operation);
    set(operation$, operation);
    return operation;
  },
);

export const dismissAgentSuggestion$ = command(
  async ({ get, set }, item: Suggestion, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (get(running$)) {
      return;
    }
    const context = get(cardContext$);
    if (context?.item.id === item.id) {
      toast.dismiss(`suggestion-recovery-${item.id}`);
      set(cardContext$, null);
      if (context.recoveryAgentId) {
        return;
      }
    }
    await set(consumeAgentSuggestion$, item, signal);
  },
);
