import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { suggestionsContract } from "@okouai/api-contracts/client/suggestions";
import { getSuggestionExpiresAt } from "@okouai/api-contracts/validators/suggestions";
import type {
  Suggestion,
  SuggestionFeedbackRequest,
} from "@okouai/api-contracts/contracts/suggestions";
import { TEXT_TOAST_ACTION, toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import { accept } from "../../lib/accept.ts";
import { now } from "../../lib/time.ts";
import { defaultAgentChatPageActive$, defaultAgentId$ } from "../agent.ts";
import { apiClient$ } from "../api-client.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { setAblyInvalidationLoop$ } from "../realtime.ts";
import { rootSignal$ } from "../root-signal.ts";
import { onDomEventFn, onRef, resetSignal } from "../utils.ts";
import { createDraftSignals } from "./chat-draft.ts";

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
      const client = get(apiClient$)(suggestionsContract);
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
  readonly reasonSaved: boolean;
  readonly note: string;
}
interface SuggestionSentOutcome {
  readonly type: "sent";
  /** Null until the new thread is published. */
  readonly threadId: string | null;
}
export type SuggestionOutcome =
  SuggestionFeedbackOutcome | SuggestionSentOutcome;

/** A listed row: a waiting card, or a handled one below every waiting card. */
interface AgentSuggestionListItem {
  readonly entry: AgentSuggestionEntry;
  readonly outcome: SuggestionOutcome | null;
}
interface SettledSuggestion extends AgentSuggestionListItem {
  readonly outcome: SuggestionOutcome;
}

/** Home's suggestion list and its chat-list row follow the Suggestions rollout. */
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

const readAgentSuggestions$ = command(
  async ({ get }, signal: AbortSignal): Promise<readonly Suggestion[]> => {
    const enabled = await get(agentSuggestionsEnabled$);
    signal.throwIfAborted();
    if (!enabled) {
      return [];
    }
    const result = await accept(
      get(apiClient$)(suggestionsContract).list({ fetchOptions: { signal } }),
      [200, 403],
      signal,
      { showErrorToast: false },
    );
    return result.status === 200 ? result.body.suggestions : [];
  },
);

const waitingSuggestionCountVersion$ = state(0);
/**
 * The cards waiting on home, counted on its chat-list row. The row reads the
 * server's actionable cards rather than a home visit's snapshot, so it follows
 * every committed change, including those made on home itself.
 */
export const waitingSuggestionCount$ = computed(async (get) => {
  get(waitingSuggestionCountVersion$);
  if (!(await get(agentSuggestionsEnabled$))) {
    return 0;
  }
  const result = await accept(
    get(apiClient$)(suggestionsContract).list(),
    [200, 403],
    undefined,
    { showErrorToast: false },
  );
  if (result.status !== 200) {
    return 0;
  }
  return result.body.suggestions.filter((item) => {
    return getSuggestionExpiresAt(item) > now();
  }).length;
});
const reloadWaitingSuggestionCount$ = command(({ set }) => {
  set(waitingSuggestionCountVersion$, (version) => {
    return version + 1;
  });
});
/**
 * The count follows the API's notice of every committed suggestion change
 * while its row is shown. Each subscription reads it once more, so a row that
 * returns does not show a count from before it left.
 */
export const followWaitingSuggestionCountOnRef$ = onRef(
  command(({ set }, _row: HTMLElement, signal: AbortSignal) => {
    set(
      setAblyInvalidationLoop$,
      {
        scope: "credential",
        topic: "agentSuggestionsChanged",
        invalidations: [reloadWaitingSuggestionCount$],
        options: { runOnSubscribe: true },
      },
      signal,
    );
  }),
);

function createSuggestionSession() {
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
    entries$,
    listItems$,
    settled$,
    previewId$: state<string | null>(null),
    detailId$: state<string | null>(null),
    detailQueue$: state<readonly AgentSuggestionEntry[] | null>(null),
    // The handled card whose feedback reason is being edited.
    reasonOpen$: state<AgentSuggestionEntry | null>(null),
  };
}

const visit$ = state(0);
const session$ = computed((get) => {
  get(visit$);
  return createSuggestionSession();
});
export const agentSuggestionEntries$ = computed((get) => {
  return get(get(session$).entries$);
});
export const agentSuggestionListItems$ = computed((get) => {
  return get(get(session$).listItems$);
});
export const homeSuggestionCard$ = computed(async (get) => {
  const session = get(session$);
  const items = await get(session.listItems$);
  const waiting = items.filter(({ outcome }) => {
    return outcome === null;
  });
  const index = Math.max(
    0,
    waiting.findIndex(({ entry }) => {
      return entry.item.id === get(session.previewId$);
    }),
  );
  const queue = get(session.detailQueue$);
  const detailId = get(session.detailId$);
  return {
    count: waiting.length,
    index,
    item: waiting[index]?.entry.item,
    detail: items.find(({ entry }) => {
      return entry.item.id === detailId;
    }),
    detailsOpen: queue !== null,
    complete: queue !== null && detailId === null,
    detailCount: queue?.length ?? 0,
    detailIndex:
      queue?.findIndex((entry) => {
        return entry.item.id === detailId;
      }) ?? -1,
  };
});
export const moveHomeSuggestion$ = command(
  async ({ get, set }, step: -1 | 1, signal: AbortSignal) => {
    const session = get(session$);
    const items = (await get(session.listItems$)).filter(({ outcome }) => {
      return outcome === null;
    });
    signal.throwIfAborted();
    const index = Math.max(
      0,
      items.findIndex(({ entry }) => {
        return entry.item.id === get(session.previewId$);
      }),
    );
    const next = items[index + step];
    if (next) {
      set(session.previewId$, next.entry.item.id);
    }
  },
);
export const setHomeSuggestionDetailsOpen$ = command(
  async ({ get, set }, open: boolean, signal: AbortSignal) => {
    const session = get(session$);
    if (!open) {
      set(session.detailId$, null);
      set(session.detailQueue$, null);
      return;
    }
    const card = await get(homeSuggestionCard$);
    signal.throwIfAborted();
    const items = await get(session.listItems$);
    signal.throwIfAborted();
    if (!card.item) {
      return;
    }
    set(
      session.detailQueue$,
      items
        .filter(({ outcome }) => {
          return outcome === null;
        })
        .map(({ entry }) => {
          return entry;
        }),
    );
    set(session.detailId$, card.item?.id ?? null);
  },
);

/** A replaced review heading is the keyboard destination for the next card. */
export const focusSuggestionTitleOnRef$ = onRef<HTMLHeadingElement>(
  command((_context, title: HTMLHeadingElement) => {
    title.focus({ preventScroll: true });
  }),
);

/** Keep the open review's order and move only after the current action succeeds. */
export const advanceHomeSuggestion$ = command(
  ({ get, set }, entry: AgentSuggestionEntry) => {
    const session = get(session$);
    const queue = get(session.detailQueue$);
    if (
      !queue ||
      get(session.detailId$) !== entry.item.id ||
      !queue.includes(entry) ||
      (!get(entry.hidden$) && !get(entry.unavailable$))
    ) {
      return;
    }
    const index = queue.indexOf(entry);
    const remaining = [
      ...queue.slice(index + 1),
      ...queue.slice(0, index).reverse(),
    ];
    const next = remaining.find((candidate) => {
      return (
        !get(candidate.hidden$) &&
        !get(candidate.unavailable$) &&
        getSuggestionExpiresAt(candidate.item) > now()
      );
    });
    set(session.detailId$, next?.item.id ?? null);
    set(session.previewId$, next?.item.id ?? null);
  },
);
export const suggestionFeedbackReasonOpen$ = computed((get) => {
  return get(get(session$).reasonOpen$);
});
const loadAgentSuggestionEntries$ = command(
  async ({ set }, signal: AbortSignal) => {
    return (await set(readAgentSuggestions$, signal)).map(
      createSuggestionEntry,
    );
  },
);
/**
 * The default Agent's new-chat page lists the cards, because their options
 * start chats in that Agent. Each visit reads one snapshot.
 */
export const enterHomeSuggestions$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(suggestionsEnabled$)) {
      return;
    }
    const active = await get(defaultAgentChatPageActive$);
    signal.throwIfAborted();
    if (!active) {
      return;
    }
    set(visit$, get(visit$) + 1);
    const entries = set(loadAgentSuggestionEntries$, signal);
    set(get(session$).entries$, entries);
    await entries;
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
    const offered = await set(readAgentSuggestions$, signal);
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
    set(advanceHomeSuggestion$, entry);
  },
);

/** Records how a card was handled and moves it below the waiting cards. */
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
    set(advanceHomeSuggestion$, entry);
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
    if (get(session.reasonOpen$) === entry) {
      set(session.reasonOpen$, null);
    }
    if (get(session.detailQueue$)?.includes(entry)) {
      set(session.detailId$, entry.item.id);
      set(session.previewId$, entry.item.id);
    }
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
    if (get(session.reasonOpen$) === entry) {
      set(session.reasonOpen$, null);
    }
  },
);
export const openSuggestionFeedbackReason$ = command(
  ({ get, set }, entry: AgentSuggestionEntry) => {
    set(get(session$).reasonOpen$, entry);
  },
);

export const submitAgentSuggestionFeedback$ = command(
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
        reasonSaved: false,
        note: "",
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
    set(advanceHomeSuggestion$, entry);
  },
);
export const undoSuggestionFeedback$ = command(
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

/** Homepage feedback keeps the preview compact and offers the existing Undo. */
export const submitHomeSuggestionFeedback$ = command(
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
      id: "home-suggestion-feedback",
      action: {
        label: messages.undoFeedback,
        onClick: onDomEventFn(async () => {
          signal.throwIfAborted();
          set(session.previewId$, entry.item.id);
          await set(undoSuggestionFeedback$, entry, signal);
        }),
      },
    });
  },
);
export const saveSuggestionFeedbackReason$ = command(
  async (
    { get, set },
    entry: AgentSuggestionEntry,
    note: string,
    pageSignal: AbortSignal,
  ) => {
    pageSignal.throwIfAborted();
    const session = get(session$);
    const feedback = settledFeedback(get(session.settled$), entry);
    if (!feedback) {
      return;
    }
    set(updateSettledSuggestion$, entry, {
      ...feedback,
      reasonSaved: true,
      note,
    });
    set(session.reasonOpen$, null);
    await set(
      entry.enqueue$,
      {
        type: "feedback",
        request: {
          id: crypto.randomUUID(),
          kind: "reason",
          targetId: feedback.id,
          note,
        },
      },
      get(rootSignal$),
    );
  },
);
