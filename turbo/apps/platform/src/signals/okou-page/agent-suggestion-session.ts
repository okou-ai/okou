import { command, computed, state } from "ccstate";
import { feedContract } from "@okouai/api-contracts/client/feed";
import { getSuggestionExpiresAt } from "@okouai/api-contracts/validators/suggestions";
import type {
  Suggestion,
  SuggestionFeedbackRequest,
  ActiveFeedItem,
} from "@okouai/api-contracts/contracts/feed";
import { TEXT_TOAST_ACTION, toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import {
  captureSuggestionCard,
  type SuggestionImpression,
  type SuggestionFeedbackKind as FeedbackKind,
} from "../../lib/posthog.ts";
import { accept } from "../../lib/accept.ts";
import { now } from "../../lib/time.ts";

import { apiClient$ } from "../api-client.ts";
import { authenticatedSessionKey$ } from "../auth.ts";
import { rootSignal$ } from "../root-signal.ts";
import { searchParams$ } from "../route.ts";
import {
  detach,
  onDomEventFn,
  onRef,
  Reason,
  resetSignal,
  waitForToken,
} from "../utils.ts";
import { createDraftSignals } from "./chat-draft.ts";
import { createPlatformEventEntry } from "./platform-feed-events.ts";
import {
  activeSuggestionImpression$,
  createForYouReadRef,
  forYouSummary$,
} from "./for-you-sources.ts";

type SuggestionMutation =
  | {
      readonly type: "feedback";
      readonly request: SuggestionFeedbackRequest;
      readonly impression: SuggestionImpression;
      readonly kind: FeedbackKind;
    }
  | { readonly type: "consume"; readonly optionId: string };

function createSuggestionImpression(item: Suggestion) {
  // A click can precede the first intersection notification. Both paths use
  // the same impression for the lifetime of the active card.
  const show$ = command(({ get, set }) => {
    const activeImpression$ = get(activeSuggestionImpression$);
    const previous = get(activeImpression$);
    if (previous?.suggestion_id === item.id) {
      return previous;
    }
    const impression = {
      suggestion_id: item.id,
      impression_id: crypto.randomUUID(),
    };
    const ids = item.content.options.map((option) => {
      return option.id;
    });
    set(activeImpression$, impression);
    captureSuggestionCard({
      eventName: "suggestion_card_shown",
      properties: { ...impression, option_ids: ids, option_count: ids.length },
    });
    return impression;
  });
  const observe$ = command(
    ({ set }, element: HTMLElement, signal: AbortSignal) => {
      let intersecting = false;
      const report = () => {
        if (intersecting && !document.hidden && !signal.aborted) {
          set(show$);
        }
      };
      const observer = new IntersectionObserver(([entry]) => {
        intersecting = entry?.isIntersecting === true;
        report();
      });
      observer.observe(element);
      document.addEventListener("visibilitychange", report, { signal });
      signal.addEventListener(
        "abort",
        () => {
          observer.disconnect();
        },
        { once: true },
      );
    },
  );
  return { show$, readOnRef$: createForYouReadRef(item.id, observe$) };
}

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
        } else {
          captureSuggestionCard(
            {
              eventName: "suggestion_card_feedback_recorded",
              properties: {
                ...mutation.impression,
                feedback_kind: mutation.kind,
                operation: kind === "undo" ? "undo" : "apply",
              },
            },
            mutation.request.id,
          );
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
  // workspace composer is neither read nor replaced.
  const optionDraft = createDraftSignals();
  // The chosen action's send, whose progress and failure its sent row shows.
  const sending$ = state<Promise<void> | undefined>(undefined);
  return {
    item,
    ...createSuggestionImpression(item),
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
  readonly impression: SuggestionImpression;
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

/** A member can start a custom response while only the summary card is available. */
export interface SuggestionDirectionSession {
  readonly entry: AgentSuggestionEntry;
  readonly impression: SuggestionImpression;
}
type ForYouEntry =
  AgentSuggestionEntry | ReturnType<typeof createPlatformEventEntry>;

function createSuggestionSession() {
  const direction$ = state<SuggestionDirectionSession | null>(null);
  const settledOrder$ = state<readonly string[]>([]);
  const snapshot$ = state<{
    readonly source: "preview" | "list";
    readonly entries: readonly ForYouEntry[];
  } | null>(null);
  const request$ = state<Promise<void> | undefined>(undefined);
  const entries$ = computed((get) => {
    return (get(snapshot$)?.entries ?? []).filter((entry) => {
      return "unavailable$" in entry;
    });
  });

  function createEntry(item: ActiveFeedItem): ForYouEntry {
    return item.type === "suggestion"
      ? createSuggestionEntry(item)
      : createPlatformEventEntry(item, settledOrder$);
  }

  // Reuse entries across the preview and list so drafts, feedback and Undo
  // stay attached to their cards. A completed empty list supersedes the preview.
  const applyCards$ = command(
    ({ get, set }, items: readonly ActiveFeedItem[]) => {
      const editing = get(direction$)?.entry;
      const offered = new Map(
        items.map((item) => {
          return [item.id, item] as const;
        }),
      );
      const byId = new Map<string, ForYouEntry>();
      for (const entry of get(snapshot$)?.entries ?? []) {
        const id = entry.item.id;
        const current = offered.get(id);
        if ("unavailable$" in entry) {
          const keepAction = entry === editing || get(entry.acted$);
          if (get(entry.unavailable$) || (!current && !keepAction)) {
            set(entry.unavailable$, true);
            continue;
          }
          // An untouched card uses the authoritative revision. Writes and drafts
          // keep the exact signed content on which the member acted.
          if (
            !keepAction &&
            current?.type === "suggestion" &&
            (entry.item.consumeToken !== current.consumeToken ||
              entry.item.updatedAt !== current.updatedAt)
          ) {
            continue;
          }
        } else if (current?.type === "event") {
          // The workflow description may change while dismissal is in flight.
          byId.set(id, { ...entry, item: current });
          continue;
        } else if (!get(entry.dismissed$)) {
          continue;
        }
        byId.set(id, entry);
      }
      for (const item of offered.values()) {
        if (!byId.has(item.id)) {
          byId.set(item.id, createEntry(item));
        }
      }
      const cards = [...byId.values()].sort((left, right) => {
        return (
          right.item.priority - left.item.priority ||
          left.item.createdAt.localeCompare(right.item.createdAt) ||
          left.item.id.localeCompare(right.item.id)
        );
      });
      set(snapshot$, { source: "list", entries: cards });
    },
  );

  const readList$ = command(async ({ get, set }, signal: AbortSignal) => {
    const client = get(apiClient$)(feedContract);
    const items: ActiveFeedItem[] = [];
    let cursor: string | undefined;
    do {
      const result = await accept(
        client.list({ query: { cursor }, fetchOptions: { signal } }),
        [200, 403],
        signal,
        { showErrorToast: false },
      );
      signal.throwIfAborted();
      if (result.status === 403) {
        return set(applyCards$, []);
      }
      items.push(...result.body.items);
      cursor = result.body.nextCursor;
    } while (cursor);
    return set(applyCards$, items);
  });
  const resetRead$ = resetSignal();
  const reload$ = command(({ set }, pageSignal: AbortSignal) => {
    const load = set(readList$, set(resetRead$, pageSignal));
    set(request$, load);
    return load;
  });
  const showPreview$ = command(async ({ get, set }, signal: AbortSignal) => {
    const summary = get(forYouSummary$);
    const { firstItem } = await waitForToken(summary, signal);
    signal.throwIfAborted();
    const target = get(searchParams$).get("suggestion");
    if (
      firstItem &&
      (!target || firstItem.id === target) &&
      !get(snapshot$) &&
      get(forYouSummary$) === summary
    ) {
      set(snapshot$, { source: "preview", entries: [createEntry(firstItem)] });
    }
  });
  // Handled cards, in the order the member handled them.
  const settled$ = state<readonly SettledSuggestion[]>([]);
  return {
    direction$,
    showPreview$,
    reload$,
    request$,
    snapshot$,
    settledOrder$,
    entries$,
    settled$,
  };
}

const visit$ = state(0);
const session$ = computed((get) => {
  get(authenticatedSessionKey$);
  get(visit$);
  return createSuggestionSession();
});
export const suggestionDirectionSession$ = computed((get) => {
  return get(session$).direction$;
});
export const suggestionDirectionItemId$ = computed((get) => {
  return get(get(suggestionDirectionSession$))?.entry.item.id ?? null;
});
export const agentSuggestionEntries$ = computed((get) => {
  return get(get(session$).entries$);
});
export const agentSuggestionListItems$ = computed(
  (get): readonly AgentSuggestionListItem[] => {
    const session = get(session$);
    const entries = get(session.entries$);
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
    const settled = get(session.settled$).filter(({ entry }) => {
      return !get(entry.unavailable$);
    });
    return [...waiting, ...settled];
  },
);
export const forYouVisitSnapshot$ = computed((get) => {
  return get(get(session$).snapshot$);
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

/** The current request can fail while a previous complete list remains usable. */
export const forYouListRequest$ = computed((get) => {
  return get(get(session$).request$);
});

export const enterSuggestionSession$ = command(
  ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(visit$, get(visit$) + 1);
    const session = get(session$);
    detach(set(session.showPreview$, signal), Reason.Daemon, "For you preview");
    return set(session.reload$, signal);
  },
);

export const reloadSuggestionSession$ = command(
  ({ get, set }, signal: AbortSignal) => {
    return set(get(session$).reload$, signal);
  },
);

const SUGGESTION_UNAVAILABLE_TOAST_ID = "agent-suggestion-unavailable";
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
    await set(reloadSuggestionSession$, pageSignal);
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
    const impression$ = get(activeSuggestionImpression$);
    if (get(impression$)?.suggestion_id === entry.item.id) {
      set(impression$, null);
    }
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
    const entries = get(session.entries$);
    pageSignal.throwIfAborted();
    const entry = entries.find((candidate) => {
      return candidate.item.id === suggestionId;
    });
    if (!entry || get(entry.hidden$)) {
      return;
    }
    const impression = set(entry.show$);
    const id = crypto.randomUUID();
    set(
      settleAgentSuggestion$,
      entry,
      {
        type: "feedback",
        id,
        undoId: crypto.randomUUID(),
        impression,
        kind,
      },
      pageSignal,
    );
    await set(
      entry.enqueue$,
      {
        type: "feedback",
        impression,
        kind,
        request: {
          id,
          kind: kind === "dont_nudge" ? "not_planned" : kind,
          targetId: null,
          note:
            kind === "dont_nudge" ? "Do not nudge me about this again." : "",
        },
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
        impression: feedback.impression,
        kind: feedback.kind,
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
    const entry = get(session.entries$).find((candidate) => {
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
      dont_nudge: messages.dontNudgeRecorded,
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
