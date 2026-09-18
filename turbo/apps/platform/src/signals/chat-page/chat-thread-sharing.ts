import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { toast } from "@okouai/ui/components/ui/sonner";
import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";

import { i18n } from "../../i18n/index.ts";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { writeToClipboard } from "../okou-page/clipboard.ts";
import type { ChatEventGroup } from "./chat-event.ts";
import type { ChatThreadScrollSignals } from "./chat-thread-scroll.ts";
import { buildRunWorkFolding } from "./run-work-folding.ts";

const SHARED_THREAD_SELECTION_TEXT_LIMIT_BYTES = 1.5 * 1024 * 1024;

export interface ShareableChatEvent {
  readonly id: string;
  readonly text: string;
}

export type SharedThreadSelectionPhase = "idle" | "selecting" | "created";
export type ToggleSharedThreadSelectionResult =
  | "selected"
  | "deselected"
  | "too-large";

export interface ChatThreadSharingSignals {
  readonly phase$: Computed<SharedThreadSelectionPhase>;
  readonly selectedEventIds$: Computed<ReadonlySet<string>>;
  readonly selectedCount$: Computed<number>;
  readonly createdSharedThreadId$: Computed<string | null>;
  readonly start$: Command<Promise<void>, [AbortSignal]>;
  readonly close$: Command<Promise<void>, [AbortSignal]>;
  readonly toggle$: Command<
    ToggleSharedThreadSelectionResult,
    [string, readonly ShareableChatEvent[]]
  >;
  readonly create$: Command<Promise<void>, [AbortSignal]>;
}

// A visual message group is the only thing the reader can tick, so it is also
// the unit the selection stores and counts. A single assistant run group can
// hold a dozen output messages; counting those instead made one click jump the
// counter from "3 selected" to "13 selected".
interface SelectedGroup {
  readonly events: readonly ShareableChatEvent[];
  readonly bytes: number;
}

function groupBytes(events: readonly ShareableChatEvent[]): number {
  const encoder = new TextEncoder();
  return events.reduce((total, event) => {
    return total + encoder.encode(event.text).byteLength;
  }, 0);
}

export function chatGroupForSharing(group: ChatEventGroup): ChatEventGroup {
  return group.role === "assistant"
    ? {
        ...group,
        events: group.events
          .filter((event) => {
            return event.eventType === "output.message";
          })
          .slice(-1),
      }
    : group;
}

function shareableEventIds(
  groups: readonly ChatEventGroup[],
): ReadonlySet<string> {
  const activeGroups = groups.flatMap((group) => {
    const events = group.events.filter((event) => {
      return !event.isQueued;
    });
    return events.length === 0 ? [] : [{ ...group, events }];
  });
  return new Set(
    buildRunWorkFolding(activeGroups).visibleGroups.flatMap((group) => {
      return chatGroupForSharing(group).events.map((event) => {
        return event.id;
      });
    }),
  );
}

function filterSelectedGroups(
  selected: ReadonlyMap<string, SelectedGroup>,
  sharingEventIds: ReadonlySet<string>,
): ReadonlyMap<string, SelectedGroup> {
  const next = new Map<string, SelectedGroup>();
  let changed = false;
  for (const [key, group] of selected) {
    const events = group.events.filter((event) => {
      return sharingEventIds.has(event.id);
    });
    if (events.length === group.events.length) {
      next.set(key, group);
      continue;
    }
    changed = true;
    if (events.length > 0) {
      next.set(key, { events, bytes: groupBytes(events) });
    }
  }
  return changed ? next : selected;
}

function createShareCommand(
  threadId: string,
  selectedGroups$: Computed<ReadonlyMap<string, SelectedGroup>>,
  internalCreatedSharedThreadId$: State<string | null>,
  internalPhase$: State<SharedThreadSelectionPhase>,
): ChatThreadSharingSignals["create$"] {
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const eventIds = [...get(selectedGroups$).values()].flatMap((group) => {
      return group.events.map((event) => {
        return event.id;
      });
    });
    if (eventIds.length === 0) {
      return;
    }
    const client = get(apiClient$)(sharedThreadsContract);
    const result = await accept(
      client.create({
        params: { threadId },
        body: { eventIds },
        fetchOptions: { signal },
      }),
      [201, 400, 413],
      signal,
    );
    if (result.status !== 201) {
      throw new Error(result.body.error.message);
    }
    set(internalCreatedSharedThreadId$, result.body.id);
    set(internalPhase$, "created");
    const copied = await writeToClipboard(
      `${window.location.origin}/share/threads/${result.body.id}`,
    );
    signal.throwIfAborted();
    if (copied) {
      toast.success(
        i18n.t(($) => {
          return $.chat.sharing.linkCopied;
        }),
      );
    } else {
      toast.error(
        i18n.t(($) => {
          return $.chat.sharing.copyFailed;
        }),
      );
    }
  });
}

export function createChatThreadSharingSignals(
  threadId: string,
  scroll: Pick<
    ChatThreadScrollSignals,
    "autoScroll$" | "readRenderedThreadScrollPosition$"
  >,
  allChatGroups$: Computed<ChatEventGroup[]>,
): ChatThreadSharingSignals {
  const internalPhase$ = state<SharedThreadSelectionPhase>("idle");
  const internalSelectedGroups$ = state<ReadonlyMap<string, SelectedGroup>>(
    new Map(),
  );
  const internalCreatedSharedThreadId$ = state<string | null>(null);
  const sharingEventIds$ = computed((get) => {
    // Use the complete transcript: scrolling a selected row out of the render
    // window must not remove it from the share.
    return shareableEventIds(get(allChatGroups$));
  });
  const selectedGroups$ = computed((get) => {
    const selected = get(internalSelectedGroups$);
    if (selected.size === 0) {
      return selected;
    }
    return filterSelectedGroups(selected, get(sharingEventIds$));
  });

  const start$ = command(({ set }, signal: AbortSignal) => {
    // History and status-tail messages disappear in the sharing projection.
    // Capture a surviving message before the phase changes the rendered DOM.
    const position = set(
      scroll.readRenderedThreadScrollPosition$,
      "[data-chat-run-work-history], [data-chat-run-status-tail]",
    );
    set(internalSelectedGroups$, new Map());
    set(internalCreatedSharedThreadId$, null);
    set(internalPhase$, "selecting");
    return set(scroll.autoScroll$, position, signal);
  });

  const close$ = command(({ set }, signal: AbortSignal) => {
    const position = set(scroll.readRenderedThreadScrollPosition$);
    set(internalSelectedGroups$, new Map());
    set(internalCreatedSharedThreadId$, null);
    set(internalPhase$, "idle");
    return set(scroll.autoScroll$, position, signal);
  });

  const toggle$ = command(
    (
      { get, set },
      groupKey: string,
      events: readonly ShareableChatEvent[],
    ): ToggleSharedThreadSelectionResult => {
      const selected = get(selectedGroups$);
      const stored = selected.get(groupKey);
      // A group that grew while it was selected reads as partially selected,
      // so ticking it again covers the new messages instead of clearing it.
      const storedEventIds = new Set(
        stored?.events.map((event) => {
          return event.id;
        }),
      );
      const allSelected = events.every((event) => {
        return storedEventIds.has(event.id);
      });
      if (stored !== undefined && allSelected) {
        const next = new Map(selected);
        next.delete(groupKey);
        set(internalSelectedGroups$, next);
        return "deselected";
      }

      const next = new Map(selected).set(groupKey, {
        events,
        bytes: groupBytes(events),
      });
      const selectedBytes = [...next.values()].reduce((total, group) => {
        return total + group.bytes;
      }, 0);
      if (selectedBytes > SHARED_THREAD_SELECTION_TEXT_LIMIT_BYTES) {
        return "too-large";
      }
      set(internalSelectedGroups$, next);
      return "selected";
    },
  );

  const create$ = createShareCommand(
    threadId,
    selectedGroups$,
    internalCreatedSharedThreadId$,
    internalPhase$,
  );

  return {
    phase$: computed((get) => {
      return get(internalPhase$);
    }),
    selectedEventIds$: computed((get) => {
      const ids = new Set<string>();
      for (const group of get(selectedGroups$).values()) {
        for (const event of group.events) {
          ids.add(event.id);
        }
      }
      return ids;
    }),
    selectedCount$: computed((get) => {
      return get(selectedGroups$).size;
    }),
    createdSharedThreadId$: computed((get) => {
      return get(internalCreatedSharedThreadId$);
    }),
    start$,
    close$,
    toggle$,
    create$,
  };
}
