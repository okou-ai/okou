import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  suggestionsContract,
  type Suggestion,
  type SuggestionOption,
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
  readonly option: SuggestionOption;
  // Once consumed, this card is a recoverable draft, not another consume/send.
  readonly recoveryAgentId: string | null;
  // Domain receipt: this consumed suggestion is already in the member's draft.
  readonly draftApplied?: boolean;
}
const cardContext$ = state<SuggestionCardContext | null>(null);
export const agentSuggestionRecoveryId$ = computed((get) => {
  const context = get(cardContext$);
  return context?.recoveryAgentId ? context.item.id : null;
});
export const agentSuggestionSelectedOptionId$ = computed((get) => {
  return get(cardContext$)?.option.id ?? null;
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
    set(consumedIds$, (ids) => {
      return [...ids, item.id];
    });
    let consumed = false;
    // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
    const result = await withCleanup(
      (async () => {
        const response = await accept(
          get(apiClient$)(suggestionsContract).consume({
            params: { id: item.id },
            body: { optionId },
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
      resetExecution$: resetSignal(),
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
    resetExecution$: resetSignal(),
    composer: createIsolatedAgentComposerSignals(target.agentId),
    events: null,
  };
});

const restoreAgentSuggestionDraft$ = command(
  async (
    { get, set },
    item: Suggestion,
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
    if (!get(cardContext$)?.draftApplied) {
      // Validation/application throw synchronously. Only a returned command
      // result certifies that retry must never prepend this suggestion again.
      const pending = set(draft.prependComposerDraft$, option.draft, signal);
      set(cardContext$, {
        item,
        option,
        recoveryAgentId: agentId,
        draftApplied: true,
      });
      await pending;
    } else {
      await set(draft.reconcileComposerDraft$, signal);
    }
    if (option.threadId !== null) {
      await set(resumeThreadDraftHandoff$, option.threadId, signal);
      signal.throwIfAborted();
      set(detachedNavigateTo$, ROUTES.chat, {
        pathParams: { threadId: option.threadId },
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
    option: SuggestionOption,
    primary: string,
    parentSignal: AbortSignal,
  ) => {
    let sent = false;
    let releaseRunner: (() => void) | undefined;
    // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
    return await withCleanup(
      (async () => {
        const agentId =
          option.threadId === null
            ? primary
            : (
                await set(
                  lookupSuggestionThread$,
                  option.threadId,
                  parentSignal,
                )
              ).meta?.agentId;
        parentSignal.throwIfAborted();
        if (!agentId) {
          throw new Error("Suggestion target is unavailable");
        }
        const target = { agentId, threadId: option.threadId };
        set(target$, target);
        const runner = get(runner$);
        if (!runner) {
          throw new Error("Suggestion target is unavailable");
        }
        const signal = set(runner.resetExecution$, parentSignal);
        const { composer, events } = runner;
        releaseRunner = () => {
          set(runner.resetExecution$);
          for (const attachment of get(composer.draft.attachments$)) {
            set(attachment.cancel$);
          }
          composer.editor.editor.destroy();
          if (get(target$) === target) {
            set(target$, null);
            get(runner$);
          }
        };
        const message = option.draft.draftUserMessage;
        const document = draftToEditorDoc(message);
        const content = message ? messageDocumentToPrompt(message) : null;
        if (!message || !document || content === null) {
          throw new Error("Invalid suggestion message");
        }
        const attachments = userMessageDraftAttachments(
          message,
          option.draft.draftAttachments ?? [],
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
        sent = await set(
          composer.submission.submitCurrentInput$,
          action,
          undefined,
          signal,
        );
        signal.throwIfAborted();
        if (sent && option.threadId !== null) {
          set(detachedNavigateTo$, ROUTES.chat, {
            pathParams: { threadId: option.threadId },
          });
        }
        return sent;
      })(),
      () => {
        releaseRunner?.();
        const recovery = get(cardContext$);
        if (!parentSignal.aborted && !sent && recovery?.item.id === item.id) {
          set(cardContext$, { ...recovery, recoveryAgentId: primary });
          set(showAgentSuggestionRecovery$, recovery.item, recovery.option.id);
        } else {
          toast.dismiss(`suggestion-recovery-${item.id}`);
        }
      },
    );
  },
);

const consumeAndRunAgentSuggestion$ = command(
  async (
    { get, set },
    item: Suggestion,
    optionId: string,
    signal: AbortSignal,
  ) => {
    const primary = await get(defaultAgentId$);
    signal.throwIfAborted();
    if (!primary) {
      throw new Error("Primary Agent is unavailable");
    }
    const selected = await set(consumeAgentSuggestion$, item, optionId, signal);
    if (selected === null) {
      set(cardContext$, null);
      return;
    }
    // The consume response owns the current content and destination. Preserve
    // it for recovery on both a domain refusal and a rejected send, without
    // turning transport failures into fulfilled operations.
    const option = selected.options.find((entry) => {
      return entry.id === selected.selectedOptionId;
    });
    if (!option || option.id !== optionId) {
      throw new Error(
        "Consumed suggestion does not contain the selected option",
      );
    }
    set(cardContext$, { item: selected, option, recoveryAgentId: null });
    if (await set(sendAgentSuggestion$, selected, option, primary, signal)) {
      set(cardContext$, null);
    }
  },
);

const runAgentSuggestion$ = command(
  async (
    { get, set },
    item: Suggestion,
    optionId: string,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const context = get(cardContext$);
    if (context?.item.id === item.id && context.recoveryAgentId) {
      if (context.option.id !== optionId) {
        return;
      }
      await set(
        restoreAgentSuggestionDraft$,
        context.item,
        context.option,
        context.recoveryAgentId,
        signal,
      );
      signal.throwIfAborted();
      set(cardContext$, null);
      toast.dismiss(`suggestion-recovery-${item.id}`);
      return;
    }
    const option = item.options.find((entry) => {
      return entry.id === optionId;
    });
    if (!option) {
      throw new Error("Suggestion option is unavailable");
    }
    set(cardContext$, { item, option, recoveryAgentId: null });
    await set(consumeAndRunAgentSuggestion$, item, optionId, signal);
  },
);

const showAgentSuggestionRecovery$ = command(
  ({ get, set }, item: Suggestion, optionId: string): void => {
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
              set(startAgentSuggestion$, item, optionId, get(rootSignal$)),
              Reason.DomCallback,
            );
          },
        },
      },
    );
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
    const context = get(cardContext$);
    if (
      get(consumedIds$).includes(item.id) &&
      !(context?.item.id === item.id && context.recoveryAgentId)
    ) {
      return;
    }
    // Consumption and draft recovery survive the navigation initiated by sending.
    const signal = get(rootSignal$);
    await set(runAgentSuggestion$, item, optionId, signal);
  },
);

export const dismissAgentSuggestion$ = command(
  async ({ get, set }, item: Suggestion, signal: AbortSignal) => {
    signal.throwIfAborted();
    const context = get(cardContext$);
    if (context?.item.id === item.id) {
      toast.dismiss(`suggestion-recovery-${item.id}`);
      set(cardContext$, null);
      if (context.recoveryAgentId) {
        return;
      }
    }
    await set(consumeAgentSuggestion$, item, null, signal);
  },
);
