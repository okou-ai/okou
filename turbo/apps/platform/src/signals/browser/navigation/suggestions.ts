import { command, computed, state, type Computed } from "ccstate";
import type { BrowserTab } from "../browser.ts";
import { navigationAddress } from "../input/address.ts";
import { CdpFault } from "../cdp/errors.ts";

type AddressAction =
  | { readonly kind: "navigate"; readonly url: string }
  | { readonly kind: "search"; readonly text: string }
  | {
      readonly kind: "tab";
      readonly targetId: string;
      readonly title: string;
      readonly url: string;
    };

export type AddressSuggestion = AddressAction & {
  readonly id: string;
  readonly input: string;
  readonly scope: object;
  readonly available: boolean;
};

interface HighlightedSuggestion {
  readonly match: AddressSuggestion;
  readonly index: number;
}

function preserveSelection(
  matches: readonly AddressSuggestion[],
  selected: HighlightedSuggestion | null,
): readonly AddressSuggestion[] {
  if (!selected) {
    return matches;
  }
  const pinned = matches.find((match) => {
    return match.id === selected.match.id;
  }) ?? { ...selected.match, available: false };
  const remaining = matches.filter((match) => {
    return match.id !== pinned.id;
  });
  // Base UI owns virtual keyboard focus by index. Keep the explicitly chosen
  // identity in that slot while live metadata reranks the other candidates.
  // A removed choice is disabled until the user chooses again or edits input.
  remaining.splice(Math.min(selected.index, remaining.length), 0, pinned);
  return remaining;
}

function words(text: string, segmenter: Intl.Segmenter): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .flatMap((part) => {
      return [...segmenter.segment(part)]
        .filter((word) => {
          return word.isWordLike;
        })
        .map((word) => {
          return word.segment;
        });
    });
}

function tabScore(
  tab: BrowserTab,
  terms: readonly string[],
  query: string,
  segmenter: Intl.Segmenter,
): number {
  const title = tab.title.toLowerCase();
  const url = tab.url.toLowerCase().replace(/^https?:\/\/(?:www\.)?/, "");
  const tokens = [...words(title, segmenter), ...words(url, segmenter)];
  // Chromium OpenTabProvider requires every input term in title or URL.
  if (
    !terms.every((term) => {
      return tokens.some((token) => {
        return token.startsWith(term);
      });
    })
  ) {
    return 0;
  }
  return url.startsWith(query) ? 3 : title.startsWith(query) ? 2 : 1;
}

function literalAction(input: string): AddressAction | null {
  const url = navigationAddress(input);
  if (url) {
    return { kind: "navigate", url };
  }
  const text = input.trim();
  // Keep invalid explicit addresses as errors instead of sending them as searches.
  if (
    !text ||
    /^[a-z][\w+.-]*:/i.test(text) ||
    text.startsWith("/") ||
    text.startsWith("\\") ||
    Array.from(text).some((char) => {
      return char < " " || char === "\u007f";
    })
  ) {
    return null;
  }
  return { kind: "search", text };
}

function resolveSuggestion(
  candidates: readonly AddressSuggestion[],
  requested: AddressSuggestion | null,
  scope: object | null,
  input: string,
): AddressSuggestion | null {
  if (!requested) {
    return (
      candidates.find((candidate) => {
        return candidate.id === "literal";
      }) ?? null
    );
  }
  const match = candidates.find((candidate) => {
    return (
      candidate.id === requested.id &&
      candidate.available &&
      requested.scope === scope &&
      requested.input === input
    );
  });
  if (!match) {
    throw new CdpFault(
      "input",
      "The address suggestion is no longer available.",
    );
  }
  return match;
}

export function createAddressSuggestions(sources: {
  readonly address$: Computed<string>;
  readonly tabs$: Computed<readonly BrowserTab[]>;
  readonly scope$: Computed<object | null>;
  readonly enabled$: Computed<boolean>;
}) {
  const { address$, tabs$, scope$, enabled$ } = sources;
  const segmenter$ = computed((get) => {
    return get(enabled$)
      ? new Intl.Segmenter(undefined, { granularity: "word" })
      : null;
  });
  const openScope$ = state<object | null>(null);
  const highlightedState$ = state<HighlightedSuggestion | null>(null);
  const composing$ = state(false);
  const matches$ = computed((get): readonly AddressSuggestion[] => {
    const scope = get(scope$);
    const input = get(address$);
    if (!get(enabled$) || !scope || !input.trim()) {
      return [];
    }
    const action = literalAction(input);
    const segmenter = get(segmenter$)!;
    const query = input.trim().toLowerCase();
    const terms = words(query, segmenter);
    const tabs =
      terms.length === 0
        ? []
        : get(tabs$)
            .map((tab) => {
              return { tab, score: tabScore(tab, terms, query, segmenter) };
            })
            .filter(({ score }) => {
              return score > 0;
            })
            .sort((a, b) => {
              return b.score - a.score || a.tab.id.localeCompare(b.tab.id);
            })
            .map(({ tab }): AddressSuggestion => {
              return {
                kind: "tab",
                id: `tab:${tab.id}`,
                targetId: tab.id,
                title: tab.title,
                url: tab.url,
                input,
                scope,
                available: true,
              };
            });
    // Like Omnibox's default eligibility, tab matches don't silently replace the
    // literal action. They need an explicit keyboard/pointer selection.
    const matches = action
      ? [{ ...action, id: "literal", input, scope, available: true }, ...tabs]
      : tabs;
    const selected = get(highlightedState$);
    return preserveSelection(
      matches,
      selected?.match.scope === scope && selected.match.input === input
        ? selected
        : null,
    ).slice(0, action ? 6 : 5);
  });
  const open$ = computed((get) => {
    return (
      get(scope$) !== null &&
      get(openScope$) === get(scope$) &&
      get(matches$).length > 0
    );
  });
  const highlighted$ = computed((get) => {
    if (!get(enabled$)) {
      return null;
    }
    const match = get(highlightedState$)?.match;
    return match?.scope === get(scope$) && match.input === get(address$)
      ? match
      : null;
  });
  const setOpen$ = command(({ get, set }, open: boolean) => {
    set(openScope$, open ? get(scope$) : null);
    if (!open) {
      set(highlightedState$, null);
    }
  });
  const highlight$ = command(
    ({ get, set }, id: string | null, index: number) => {
      const match = get(matches$).find((match) => {
        return match.id === id;
      });
      set(highlightedState$, match ? { match, index } : null);
    },
  );
  const compose$ = command(({ set }, composing: boolean) => {
    set(composing$, composing);
  });
  const resolve$ = command(({ get }, requested: AddressSuggestion | null) => {
    return resolveSuggestion(
      get(matches$),
      requested,
      get(scope$),
      get(address$),
    );
  });
  return {
    scope$,
    enabled$,
    matches$,
    open$,
    highlighted$,
    composing$,
    setOpen$,
    highlight$,
    compose$,
    resolve$,
  };
}

export type AddressSuggestions = ReturnType<typeof createAddressSuggestions>;
