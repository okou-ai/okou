import {
  sharedThreadVisibilityContract,
  type SharedThreadAudience,
} from "@okouai/api-contracts/contracts/shared-thread-visibility";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../external/feature-switch.ts";
import {
  createSharedThreadVisibilitySignals,
  type SharedThreadVisibilitySignals,
} from "../shared-thread-visibility.ts";
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
  "selected" | "deselected" | "too-large";

export interface ChatThreadSharingSignals {
  readonly phase$: Computed<SharedThreadSelectionPhase>;
  readonly audience$: Computed<SharedThreadAudience>;
  readonly changeAudience$: Command<void, [SharedThreadAudience]>;
  readonly visibility$: Computed<SharedThreadVisibilitySignals | null>;
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
  /**
   * Share persisted assistant events with the user prompt that precedes them.
   * The link is copied before the first await so the clipboard write stays
   * inside the click gesture; the share is created afterwards. Resolves false
   * when the copied link is unusable, after reporting why.
   */
  readonly shareMessage$: Command<
    Promise<boolean>,
    [readonly string[], AbortSignal]
  >;
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

function isPersistedPrompt(event: ChatEventGroup["events"][number]): boolean {
  return (
    event.seqId !== undefined &&
    (event.eventType === "input.prompt" ||
      event.eventType === "input.automation")
  );
}

/** The assistant events plus the prompt events of the preceding user group. */
function messageShareEventIds(
  groups: readonly ChatEventGroup[],
  assistantEventIds: readonly string[],
): readonly string[] {
  const firstEventId = assistantEventIds[0];
  const groupIndex = groups.findIndex((group) => {
    return group.events.some((event) => {
      return event.id === firstEventId;
    });
  });
  let userGroup: ChatEventGroup | undefined;
  for (let index = groupIndex - 1; index >= 0 && !userGroup; index -= 1) {
    if (groups[index]?.role === "user") {
      userGroup = groups[index];
    }
  }
  const promptEventIds = (userGroup?.events ?? [])
    .filter(isPersistedPrompt)
    .map((event) => {
      return event.id;
    });
  return [...promptEventIds, ...assistantEventIds];
}

function sharedThreadUrl(id: string): string {
  return `${window.location.origin}/share/threads/${id}`;
}

function createShareMessageCommand(
  threadId: string,
  allChatGroups$: Computed<ChatEventGroup[]>,
  audience$: Computed<SharedThreadAudience>,
  internalCreatedSharedThreadId$: State<string | null>,
): ChatThreadSharingSignals["shareMessage$"] {
  return command(
    async (
      { get, set },
      assistantEventIds: readonly string[],
      signal: AbortSignal,
    ): Promise<boolean> => {
      if (assistantEventIds.length === 0) {
        return false;
      }
      const eventIds = messageShareEventIds(
        get(allChatGroups$),
        assistantEventIds,
      );
      const id = crypto.randomUUID();
      // Start the clipboard write synchronously in the user gesture. Waiting
      // for the API first would lose the gesture in Safari.
      const copied = writeToClipboard(sharedThreadUrl(id));
      const client = get(apiClient$)(sharedThreadsContract);
      const visibilityEnabled =
        get(featureSwitch$)[FeatureSwitchKey.SharedThreadVisibility];
      const creation = visibilityEnabled
        ? accept(
            get(apiClient$)(sharedThreadVisibilityContract).create({
              params: { threadId },
              body: { eventIds: [...eventIds], id, audience: get(audience$) },
              fetchOptions: { signal },
            }),
            [201, 400, 403, 404, 409, 413],
            signal,
          )
        : accept(
            client.create({
              params: { threadId },
              body: { eventIds: [...eventIds], id },
              fetchOptions: { signal },
            }),
            [201, 400, 403, 404, 409, 413],
            signal,
          );
      const [copySucceeded, result] = await Promise.all([copied, creation]);
      signal.throwIfAborted();
      if (!copySucceeded) {
        toast.error(
          i18n.t(($) => {
            return $.chat.sharing.copyFailed;
          }),
        );
      }
      if (result.status !== 201) {
        toast.error(
          i18n.t(($) => {
            return $.chat.sharing.messageShareFailed;
          }),
        );
        return false;
      }
      if (visibilityEnabled) {
        set(internalCreatedSharedThreadId$, result.body.id);
      }
      return copySucceeded;
    },
  );
}

function createShareCommand(
  threadId: string,
  selectedGroups$: Computed<ReadonlyMap<string, SelectedGroup>>,
  audience$: Computed<SharedThreadAudience>,
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
    const result = get(featureSwitch$)[FeatureSwitchKey.SharedThreadVisibility]
      ? await accept(
          get(apiClient$)(sharedThreadVisibilityContract).create({
            params: { threadId },
            body: { eventIds, audience: get(audience$) },
            fetchOptions: { signal },
          }),
          [201, 400, 413],
          signal,
        )
      : await accept(
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

function createShareVisibility$(id$: State<string | null>) {
  return computed((get) => {
    const id = get(id$);
    return id !== null &&
      get(featureSwitch$)[FeatureSwitchKey.SharedThreadVisibility]
      ? createSharedThreadVisibilitySignals(id)
      : null;
  });
}

function createSharedThreadAudienceSignals() {
  const draft$ = state<SharedThreadAudience>("public");
  return {
    audience$: computed((get) => {
      return get(featureSwitch$)[FeatureSwitchKey.SharedThreadVisibility]
        ? get(draft$)
        : "public";
    }),
    changeAudience$: command(({ set }, audience: SharedThreadAudience) => {
      set(draft$, audience);
    }),
  };
}

export function createChatThreadSharingSignals(
  threadId: string,
  scroll: Pick<
    ChatThreadScrollSignals,
    "autoScroll$" | "readRenderedThreadScrollPosition$"
  >,
  allChatGroups$: Computed<ChatEventGroup[]>,
  closeFeedbackSelection$: Command<void, []>,
): ChatThreadSharingSignals {
  const internalPhase$ = state<SharedThreadSelectionPhase>("idle");
  const { audience$, changeAudience$ } = createSharedThreadAudienceSignals();
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
    set(closeFeedbackSelection$);
    set(internalSelectedGroups$, new Map());
    set(internalCreatedSharedThreadId$, null);
    set(changeAudience$, "public");
    set(internalPhase$, "selecting");
    return set(scroll.autoScroll$, position, signal);
  });

  const close$ = command(({ set }, signal: AbortSignal) => {
    const position = set(scroll.readRenderedThreadScrollPosition$);
    set(internalSelectedGroups$, new Map());
    set(internalCreatedSharedThreadId$, null);
    set(changeAudience$, "public");
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
    audience$,
    internalCreatedSharedThreadId$,
    internalPhase$,
  );

  const shareMessage$ = createShareMessageCommand(
    threadId,
    allChatGroups$,
    audience$,
    internalCreatedSharedThreadId$,
  );

  return {
    audience$,
    changeAudience$,
    visibility$: createShareVisibility$(internalCreatedSharedThreadId$),
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
    shareMessage$,
  };
}
