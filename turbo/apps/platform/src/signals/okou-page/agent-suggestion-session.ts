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
import { currentChatAgentId$ } from "../agent-chat.ts";
import { defaultAgentId$ } from "../agent.ts";
import { apiClient$ } from "../api-client.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { rootSignal$ } from "../root-signal.ts";

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
  return { item, hidden$, result$, enqueue$, retry$ };
}
export type AgentSuggestionEntry = ReturnType<typeof createSuggestionEntry>;

interface FeedbackConfirmation {
  readonly entry: AgentSuggestionEntry;
  readonly item: Suggestion;
  readonly id: string;
  readonly undoId: string;
  readonly kind: FeedbackKind;
  readonly reasonSaved: boolean;
  readonly note: string;
}

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
  const visible$ = computed(async (get) => {
    return (await get(entries$))
      .filter((entry) => {
        return (
          !get(entry.hidden$) && getSuggestionExpiresAt(entry.item) > now()
        );
      })
      .map((entry) => {
        return entry.item;
      });
  });
  return {
    snapshot$,
    entries$,
    visible$,
    index$: state(0),
    confirmation$: state<FeedbackConfirmation | null>(null),
    reasonOpen$: state(false),
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
export const visibleAgentSuggestions$ = computed((get) => {
  return get(get(session$).visible$);
});
export const agentSuggestionIndex$ = computed((get) => {
  return get(get(session$).index$);
});
export const suggestionFeedbackConfirmation$ = computed((get) => {
  return get(get(session$).confirmation$);
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
export const showAgentSuggestion$ = command(({ get, set }, index: number) => {
  set(get(session$).index$, index);
});
export const closeSuggestionFeedback$ = command(({ get, set }) => {
  const session = get(session$);
  set(session.confirmation$, null);
  set(session.reasonOpen$, false);
});
export const openSuggestionFeedbackReason$ = command(({ get, set }) => {
  set(get(session$).reasonOpen$, true);
});

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
    set(entry.hidden$, true);
    set(session.confirmation$, {
      entry,
      item,
      id,
      undoId: crypto.randomUUID(),
      kind,
      reasonSaved: false,
      note: "",
    });
    set(session.reasonOpen$, false);
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
  async ({ get, set }, pageSignal: AbortSignal) => {
    pageSignal.throwIfAborted();
    const session = get(session$);
    const last = get(session.confirmation$);
    if (!last) {
      return;
    }
    const entries = await get(session.entries$);
    pageSignal.throwIfAborted();
    if (get(session.confirmation$)?.id !== last.id) {
      return;
    }
    set(last.entry.hidden$, false);
    set(
      session.index$,
      entries.slice(0, entries.indexOf(last.entry)).filter((entry) => {
        return (
          !get(entry.hidden$) && getSuggestionExpiresAt(entry.item) > now()
        );
      }).length,
    );
    set(session.confirmation$, null);
    set(session.reasonOpen$, false);
    await set(
      last.entry.enqueue$,
      {
        type: "feedback",
        request: {
          id: last.undoId,
          kind: "undo",
          targetId: last.id,
          note: "",
        },
      },
      get(rootSignal$),
    );
  },
);
export const saveSuggestionFeedbackReason$ = command(
  async ({ get, set }, note: string, pageSignal: AbortSignal) => {
    pageSignal.throwIfAborted();
    const session = get(session$);
    const last = get(session.confirmation$);
    if (!last) {
      return;
    }
    set(session.confirmation$, { ...last, reasonSaved: true, note });
    set(session.reasonOpen$, false);
    await set(
      last.entry.enqueue$,
      {
        type: "feedback",
        request: {
          id: crypto.randomUUID(),
          kind: "reason",
          targetId: last.id,
          note,
        },
      },
      get(rootSignal$),
    );
  },
);
