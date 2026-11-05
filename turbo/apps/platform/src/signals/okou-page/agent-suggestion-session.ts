import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { suggestionsContract } from "@okouai/api-contracts/client/suggestions";
import { getSuggestionExpiresAt } from "@okouai/api-contracts/validators/suggestions";
import type {
  Suggestion,
  SuggestionFeedbackRequest,
} from "@okouai/api-contracts/contracts/suggestions";
import { accept } from "../../lib/accept.ts";
import { now } from "../../lib/time.ts";
import { defaultAgentId$ } from "../agent.ts";
import { apiClient$ } from "../api-client.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { rootSignal$ } from "../root-signal.ts";
import { slideSuggestionRows$ } from "./agent-suggestion-motion.ts";
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

  // Each card has its own ordered outbox. A reason or Undo must follow its
  // feedback, while another card can save independently. Keep the accepted
  // prefix so an explicit retry reuses the remaining request identities.
  const persist$ = command(async ({ get, set }, signal: AbortSignal) => {
    const mutations = get(mutations$);
    for (let index = get(acknowledged$); index < mutations.length; index++) {
      signal.throwIfAborted();
      const mutation = mutations[index];
      const client = get(apiClient$)(suggestionsContract);
      if (mutation.type === "feedback") {
        await accept(
          client.feedback({
            params: { id: item.id },
            body: {
              ...mutation.request,
              snapshot: item.consumeToken ? item : undefined,
            },
            fetchOptions: { signal },
          }),
          [200],
          signal,
        );
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
  return { item, hidden$, result$, enqueue$, retry$, optionDraft, sending$ };
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

/** A Feed row: a waiting card, or a handled one below every waiting card. */
interface AgentSuggestionFeedItem {
  readonly entry: AgentSuggestionEntry;
  readonly outcome: SuggestionOutcome | null;
}
interface SettledSuggestion extends AgentSuggestionFeedItem {
  readonly outcome: SuggestionOutcome;
}

/** The Feed page and its sidebar entry follow the Suggestions rollout. */
export const suggestionFeedEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.AgentSuggestion] === true;
});

const agentSuggestionsEnabled$ = computed(async (get) => {
  if (!get(suggestionFeedEnabled$)) {
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

function createSuggestionSession() {
  // A visit owns one snapshot, independent of reactive metadata invalidations.
  const snapshot$ = state<
    readonly Suggestion[] | Promise<readonly Suggestion[]>
  >([]);
  const entries$ = computed(async (get) => {
    return (await get(snapshot$)).map(createSuggestionEntry);
  });
  // Handled cards, in the order the member handled them.
  const settled$ = state<readonly SettledSuggestion[]>([]);
  const feedItems$ = computed(
    async (get): Promise<readonly AgentSuggestionFeedItem[]> => {
      const entries = await get(entries$);
      const waiting = entries
        .filter((entry) => {
          return (
            !get(entry.hidden$) && getSuggestionExpiresAt(entry.item) > now()
          );
        })
        .map((entry) => {
          return { entry, outcome: null };
        });
      return [...waiting, ...get(settled$)];
    },
  );
  return {
    snapshot$,
    entries$,
    feedItems$,
    settled$,
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
export const agentSuggestionFeedItems$ = computed((get) => {
  return get(get(session$).feedItems$);
});
export const suggestionFeedbackReasonOpen$ = computed((get) => {
  return get(get(session$).reasonOpen$);
});
export const enterAgentSuggestions$ = command(
  ({ get, set }, signal: AbortSignal) => {
    set(visit$, get(visit$) + 1);
    const snapshot = set(readAgentSuggestions$, signal);
    set(get(session$).snapshot$, snapshot);
    return snapshot;
  },
);

/** Records how a card was handled and slides it below the waiting cards. */
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
    set(slideSuggestionRows$);
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
  },
);

/** Returns a handled card to its original place among the waiting cards. */
export const restoreAgentSuggestion$ = command(
  ({ get, set }, entry: AgentSuggestionEntry) => {
    const session = get(session$);
    set(slideSuggestionRows$);
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

/** Clears a handled card from the Feed; the card stays handled. */
export const closeSettledSuggestion$ = command(
  ({ get, set }, entry: AgentSuggestionEntry) => {
    const session = get(session$);
    set(slideSuggestionRows$);
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
    item: Suggestion,
    kind: FeedbackKind,
    pageSignal: AbortSignal,
  ) => {
    const session = get(session$);
    const entries = await get(session.entries$);
    pageSignal.throwIfAborted();
    const entry = entries.find((candidate) => {
      return candidate.item.id === item.id;
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
