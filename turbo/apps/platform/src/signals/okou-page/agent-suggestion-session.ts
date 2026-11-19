import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { feedContract } from "@okouai/api-contracts/client/feed";
import { getSuggestionExpiresAt } from "@okouai/api-contracts/validators/suggestions";
import type {
  Suggestion,
  SuggestionFeedbackRequest,
  PlatformEvent,
} from "@okouai/api-contracts/contracts/feed";
import { TEXT_TOAST_ACTION, toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import { accept } from "../../lib/accept.ts";
import { now } from "../../lib/time.ts";
import { defaultAgentId$ } from "../agent.ts";
import { apiClient$ } from "../api-client.ts";
import { authenticatedSessionKey$ } from "../auth.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { rootSignal$ } from "../root-signal.ts";
import { onDomEventFn, onRef, resetSignal } from "../utils.ts";
import { createDraftSignals } from "./chat-draft.ts";
import { createPlatformEventEntry } from "./platform-feed-events.ts";
import {
  createForYouReadRef,
  reloadForYouSources$,
} from "./for-you-sources.ts";

type FeedbackKind =
  "already_done" | "not_planned" | "less_like_this" | "dismissed";
type SuggestionMutation =
  | { readonly type: "feedback"; readonly request: SuggestionFeedbackRequest }
  | { readonly type: "consume"; readonly optionId: string };

function createSuggestionEntry(item: Suggestion) {
  const hidden$ = state(false);
  const mutations$ = state<readonly SuggestionMutation[]>([]);
  const acknowledged$ = state(0);
  const result$ = state<Promise<void> | undefined>(undefined);
  // The server no longer offers this card, so nothing was recorded for it and
  // its remaining writes have no target. None of them is sent or retried.
  const unavailable$ = state(false);
  // The member acted on this card during the visit: it was handled, or it has
  // writes, such as a restored card's Undo.
  const acted$ = computed((get) => {
    return get(hidden$) || get(mutations$).length > 0;
  });

  // Each card has its own ordered outbox. A reason or Undo must follow its
  // feedback, while another card can save independently. Keep the accepted
  // prefix so an explicit retry reuses the remaining request identities.
  const persist$ = command(async ({ get, set }, signal: AbortSignal) => {
    const mutations = get(mutations$);
    for (
      let index = get(acknowledged$);
      index < mutations.length && !get(unavailable$);
      index++
    ) {
      signal.throwIfAborted();
      const mutation = mutations[index];
      const client = get(apiClient$)(feedContract);
      if (mutation.type === "feedback") {
        const { kind } = mutation.request;
        // A first response conflicts once the card has left the pool: a
        // background check consumed or withdrew it, or another session
        // handled it. Undo and a reason target that recorded response.
        const result = await accept(
          client.feedback({
            params: { id: item.id },
            body: {
              ...mutation.request,
              snapshot: item.consumeToken ? item : undefined,
            },
            fetchOptions: { signal },
          }),
          kind === "undo" || kind === "reason" ? [200] : [200, 409],
          signal,
        );
        if (result.status === 409) {
          set(unavailable$, true);
        }
      } else {
        // The cached option has already prepared a draft. Another session
        // consuming the card does not invalidate that member-owned draft.
        await accept(
          client.consume({
            params: { id: item.id },
            body: {
              optionId: mutation.optionId,
              snapshot: item.consumeToken ? item : undefined,
            },
            fetchOptions: { signal },
          }),
          [200, 409],
          signal,
        );
      }
      set(acknowledged$, index + 1);
    }
  });
  const continue$ = command(
    async (
      { set },
      previous: Promise<void> | undefined,
      signal: AbortSignal,
    ) => {
      await previous;
      signal.throwIfAborted();
      await set(persist$, signal);
    },
  );
  const enqueue$ = command(
    ({ get, set }, mutation: SuggestionMutation, signal: AbortSignal) => {
      set(mutations$, (mutations) => {
        return [...mutations, mutation];
      });
      const result = set(continue$, get(result$), signal);
      set(result$, result);
      return result;
    },
  );
  const retry$ = command(({ get, set }, pageSignal: AbortSignal) => {
    pageSignal.throwIfAborted();
    const result = set(persist$, get(rootSignal$));
    set(result$, result);
    return result;
  });
  // A chosen action is sent from this card's own unsaved draft, so the
  // default Agent's composer is neither read nor replaced.
  const optionDraft = createDraftSignals();
  // The chosen action's send, whose progress and failure its sent row shows.
  const sending$ = state<Promise<void> | undefined>(undefined);
  return {
    item,
    readOnRef$: createForYouReadRef(item.id),
    hidden$,
    unavailable$,
    acted$,
    result$,
    enqueue$,
    retry$,
    optionDraft,
    sending$,
  };
}
export type AgentSuggestionEntry = ReturnType<typeof createSuggestionEntry>;

interface SuggestionFeedbackOutcome {
  readonly type: "feedback";
  readonly id: string;
  readonly undoId: string;
  readonly kind: FeedbackKind;
}
interface SuggestionSentOutcome {
  readonly type: "sent";
  /** Null until the new thread is published. */
  readonly threadId: string | null;
}
type SuggestionOutcome = SuggestionFeedbackOutcome | SuggestionSentOutcome;

/** A visit's waiting cards and handled outcomes. */
interface AgentSuggestionListItem {
  readonly entry: AgentSuggestionEntry;
  readonly outcome: SuggestionOutcome | null;
}
interface SettledSuggestion extends AgentSuggestionListItem {
  readonly outcome: SuggestionOutcome;
}

/** The suggestion feature owns both the For you page and its navigation entry. */
export const suggestionsEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.AgentSuggestion] === true;
});

const agentSuggestionsEnabled$ = computed(async (get) => {
  if (!get(suggestionsEnabled$)) {
    return false;
  }
  // A new-chat option starts in the default agent.
  return (await get(defaultAgentId$)) !== null;
});

const feedVersion$ = computed((get) => {
  get(authenticatedSessionKey$);
  return state(0);
});
/**
 * The sidebar preloads the same owner-scoped feed that each review visit uses.
 * Ably refreshes it independently of the visit's cards and in-progress writes.
 */
const forYouFeed$ = computed(async (get) => {
  get(get(feedVersion$));
  if (!(await get(agentSuggestionsEnabled$))) {
    return [];
  }
  const result = await accept(
    get(apiClient$)(feedContract).list(),
    [200, 403],
    undefined,
    { showErrorToast: false },
  );
  return result.status === 200 ? result.body.items : [];
});

const reloadForYouFeed$ = command(({ get, set }) => {
  set(get(feedVersion$), (version) => {
    return version + 1;
  });
});

const refreshForYouFeed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(reloadForYouFeed$);
    set(reloadForYouSources$);
    await get(forYouFeed$);
    signal.throwIfAborted();
    return false;
  },
);
/**
 * The row owns background refreshes for both the unread summary and detail feed.
 * Subscription and continuity-gap reads also recover changes missed while away.
 */
export const followForYouFeedOnRef$ = onRef(
  command(({ set }, _row: HTMLElement, signal: AbortSignal) => {
    set(
      setAblyLoop$,
      {
        scope: "credential",
        topic: "agentSuggestionsChanged",
        loopCommand$: refreshForYouFeed$,
        options: { runOnSubscribe: true },
      },
      signal,
    );
  }),
);

function createSuggestionSession() {
  const settledOrder$ = state<readonly string[]>([]);
  const feed$ = state<
    | readonly (Suggestion | PlatformEvent)[]
    | Promise<readonly (Suggestion | PlatformEvent)[]>
  >([]);
  const events$ = computed(async (get) => {
    return (await get(feed$))
      .filter((item) => {
        return item.type === "event";
      })
      .map((item) => {
        return createPlatformEventEntry(item, reloadForYouFeed$);
      });
  });
  // A visit owns its cards, independent of reactive metadata invalidations.
  // They are read again only when a write finds that a card has left the pool.
  const entries$ = state<
    readonly AgentSuggestionEntry[] | Promise<readonly AgentSuggestionEntry[]>
  >([]);
  // Handled cards, in the order the member handled them.
  const settled$ = state<readonly SettledSuggestion[]>([]);
  const listItems$ = computed(
    async (get): Promise<readonly AgentSuggestionListItem[]> => {
      const entries = await get(entries$);
      const waiting = entries
        .filter((entry) => {
          return (
            !get(entry.hidden$) &&
            !get(entry.unavailable$) &&
            getSuggestionExpiresAt(entry.item) > now()
          );
        })
        .map((entry) => {
          return { entry, outcome: null };
        });
      const settled = get(settled$).filter(({ entry }) => {
        return !get(entry.unavailable$);
      });
      return [...waiting, ...settled];
    },
  );
  return {
    feed$,
    events$,
    settledOrder$,
    entries$,
    listItems$,
    settled$,
  };
}

const visit$ = state(0);
const session$ = computed((get) => {
  get(authenticatedSessionKey$);
  get(visit$);
  return createSuggestionSession();
});
export const agentSuggestionEntries$ = computed((get) => {
  return get(get(session$).entries$);
});
export const agentSuggestionListItems$ = computed((get) => {
  return get(get(session$).listItems$);
});
export const platformEventEntries$ = computed((get) => {
  return get(get(session$).events$);
});
export const settledFeedOrder$ = computed((get) => {
  return get(get(session$).settledOrder$);
});
/** A replaced review heading is the keyboard destination for the next card. */
export const focusSuggestionTitleOnRef$ = onRef<HTMLHeadingElement>(
  command((_context, title: HTMLHeadingElement) => {
    title.focus({ preventScroll: true });
  }),
);

const loadAgentSuggestionEntries$ = command(
  async ({ get }, signal: AbortSignal) => {
    const items = await get(get(session$).feed$);
    signal.throwIfAborted();
    return items
      .filter((item) => {
        return item.type === "suggestion";
      })
      .map(createSuggestionEntry);
  },
);
/** Each visit takes a snapshot of the feed already followed by the sidebar. */
export const enterSuggestionSession$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(visit$, get(visit$) + 1);
    set(get(session$).feed$, get(forYouFeed$));
    const entries = set(loadAgentSuggestionEntries$, signal);
    set(get(session$).entries$, entries);
    await entries;
  },
);

/** A failed shared read needs invalidation before opening a new snapshot. */
export const reloadSuggestionSession$ = command(
  ({ set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(reloadForYouFeed$);
    return set(enterSuggestionSession$, signal);
  },
);

const SUGGESTION_UNAVAILABLE_TOAST_ID = "agent-suggestion-unavailable";
const resetSuggestionRefresh$ = resetSignal();
/**
 * A card that has left the pool leaves the visit with a short notice rather
 * than the API's conflict, and the visit reads the pool again so the cards
 * that left with it go too. Cards the member acted on keep their rows and
 * writes; newly offered cards follow the loaded ones.
 */
const refreshAfterUnavailableSuggestion$ = command(
  async (
    { get, set },
    entry: AgentSuggestionEntry,
    pageSignal: AbortSignal,
  ) => {
    if (!get(entry.unavailable$)) {
      return;
    }
    pageSignal.throwIfAborted();
    // Cards found gone together share one notice.
    toast.info(
      i18n.t(($) => {
        return $.chat.agentSuggestions.unavailable;
      }),
      { id: SUGGESTION_UNAVAILABLE_TOAST_ID },
    );
    // The latest read replaces an earlier one, which could drop its cards.
    const signal = set(resetSuggestionRefresh$, pageSignal);
    const session = get(session$);
    set(reloadForYouFeed$);
    const offered = (await get(forYouFeed$)).filter((item) => {
      return item.type === "suggestion";
    });
    const loaded = await get(session.entries$);
    signal.throwIfAborted();
    const offeredIds = new Set(
      offered.map((item) => {
        return item.id;
      }),
    );
    const kept = loaded.filter((candidate) => {
      return (
        !get(candidate.unavailable$) &&
        (offeredIds.has(candidate.item.id) || get(candidate.acted$))
      );
    });
    // The open review retains its original entries and must skip removed cards.
    for (const candidate of loaded) {
      if (!kept.includes(candidate)) {
        set(candidate.unavailable$, true);
      }
    }
    const keptIds = new Set(
      kept.map((candidate) => {
        return candidate.item.id;
      }),
    );
    set(session.entries$, [
      ...kept,
      ...offered
        .filter((item) => {
          return !keptIds.has(item.id);
        })
        .map(createSuggestionEntry),
    ]);
  },
);

/** Sends a card's unsaved writes again with their original identities. */
export const retryAgentSuggestion$ = command(
  async ({ set }, entry: AgentSuggestionEntry, pageSignal: AbortSignal) => {
    await set(entry.retry$, pageSignal);
    await set(refreshAfterUnavailableSuggestion$, entry, pageSignal);
    pageSignal.throwIfAborted();
  },
);

/** Records how a card was handled and removes it from the waiting stack. */
export const settleAgentSuggestion$ = command(
  (
    { get, set },
    entry: AgentSuggestionEntry,
    outcome: SuggestionOutcome,
    pageSignal: AbortSignal,
  ) => {
    // A later visit has its own cards; this card is no longer on screen.
    if (pageSignal.aborted) {
      return;
    }
    const session = get(session$);
    set(entry.hidden$, true);
    set(session.settledOrder$, (ids) => {
      return [
        ...ids.filter((id) => {
          return id !== entry.item.id;
        }),
        entry.item.id,
      ];
    });
    set(session.settled$, [
      ...get(session.settled$).filter((candidate) => {
        return candidate.entry !== entry;
      }),
      { entry, outcome },
    ]);
  },
);

/**
 * Updates a handled card's row in place. A row the member already closed, or
 * one from an earlier visit, stays closed.
 */
const updateSettledSuggestion$ = command(
  ({ get, set }, entry: AgentSuggestionEntry, outcome: SuggestionOutcome) => {
    const session = get(session$);
    set(
      session.settled$,
      get(session.settled$).map((candidate) => {
        return candidate.entry === entry ? { entry, outcome } : candidate;
      }),
    );
  },
);

/** Links a sent card's row to the thread its send published. */
export const linkAgentSuggestionThread$ = command(
  ({ set }, entry: AgentSuggestionEntry, threadId: string) => {
    set(updateSettledSuggestion$, entry, { type: "sent", threadId });
  },
);

/** Returns a handled card to its original place among the waiting cards. */
export const restoreAgentSuggestion$ = command(
  ({ get, set }, entry: AgentSuggestionEntry) => {
    const session = get(session$);
    set(entry.hidden$, false);
    set(
      session.settled$,
      get(session.settled$).filter((candidate) => {
        return candidate.entry !== entry;
      }),
    );
  },
);

function settledFeedback(
  settled: readonly SettledSuggestion[],
  entry: AgentSuggestionEntry,
): SuggestionFeedbackOutcome | null {
  const found = settled.find((candidate) => {
    return candidate.entry === entry;
  });
  return found?.outcome.type === "feedback" ? found.outcome : null;
}

/** Clears a handled card from the list; the card stays handled. */
export const closeSettledSuggestion$ = command(
  ({ get, set }, entry: AgentSuggestionEntry) => {
    const session = get(session$);
    set(
      session.settled$,
      get(session.settled$).filter((candidate) => {
        return candidate.entry !== entry;
      }),
    );
  },
);
const submitAgentSuggestionFeedback$ = command(
  async (
    { get, set },
    suggestionId: string,
    kind: FeedbackKind,
    pageSignal: AbortSignal,
  ) => {
    const session = get(session$);
    const entries = await get(session.entries$);
    pageSignal.throwIfAborted();
    const entry = entries.find((candidate) => {
      return candidate.item.id === suggestionId;
    });
    if (!entry || get(entry.hidden$)) {
      return;
    }
    const id = crypto.randomUUID();
    set(
      settleAgentSuggestion$,
      entry,
      {
        type: "feedback",
        id,
        undoId: crypto.randomUUID(),
        kind,
      },
      pageSignal,
    );
    await set(
      entry.enqueue$,
      {
        type: "feedback",
        request: { id, kind, targetId: null, note: "" },
      },
      get(rootSignal$),
    );
    await set(refreshAfterUnavailableSuggestion$, entry, pageSignal);
    pageSignal.throwIfAborted();
  },
);
const undoSuggestionFeedback$ = command(
  async (
    { get, set },
    entry: AgentSuggestionEntry,
    pageSignal: AbortSignal,
  ) => {
    pageSignal.throwIfAborted();
    const feedback = settledFeedback(get(get(session$).settled$), entry);
    if (!feedback) {
      return;
    }
    set(restoreAgentSuggestion$, entry);
    await set(
      entry.enqueue$,
      {
        type: "feedback",
        request: {
          id: feedback.undoId,
          kind: "undo",
          targetId: feedback.id,
          note: "",
        },
      },
      get(rootSignal$),
    );
  },
);

/** Handling a card offers Undo without keeping its content in the stack. */
export const submitSuggestionFeedbackWithUndo$ = command(
  async (
    { get, set },
    suggestionId: string,
    kind: FeedbackKind,
    signal: AbortSignal,
  ) => {
    const session = get(session$);
    const entry = (await get(session.entries$)).find((candidate) => {
      return candidate.item.id === suggestionId;
    });
    signal.throwIfAborted();
    if (!entry) {
      return;
    }
    await set(submitAgentSuggestionFeedback$, suggestionId, kind, signal);
    signal.throwIfAborted();
    if (
      get(entry.unavailable$) ||
      !settledFeedback(get(session.settled$), entry)
    ) {
      return;
    }
    const messages = i18n.t(
      ($) => {
        return $.chat.agentSuggestions;
      },
      { returnObjects: true },
    );
    const message = {
      dismissed: messages.dismissRecorded,
      already_done: messages.doneRecorded,
      not_planned: messages.notPlannedRecorded,
      less_like_this: messages.lessRecorded,
    }[kind];
    toast.success(message, {
      ...TEXT_TOAST_ACTION,
      id: "suggestion-feedback",
      action: {
        label: messages.undoFeedback,
        onClick: onDomEventFn(async () => {
          signal.throwIfAborted();
          await set(undoSuggestionFeedback$, entry, signal);
        }),
      },
    });
  },
);
