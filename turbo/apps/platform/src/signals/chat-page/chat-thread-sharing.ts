import { sharedThreadVisibilityContract } from "@okouai/api-contracts/client/shared-thread-visibility";
import type { SharedThreadAudience } from "@okouai/api-contracts/contracts/shared-thread-visibility";
import {
  createSharedThreadVisibilitySignals,
  type SharedThreadVisibilitySignals,
} from "../shared-thread-visibility.ts";
import { toast } from "@okouai/ui/components/ui/sonner";
import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { timeout } from "signal-timers";

import { i18n } from "../../i18n/index.ts";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { writeToClipboard } from "../okou-page/clipboard.ts";
import { resetSignal } from "../utils.ts";
import { featureSwitches$ } from "../external/feature-switch.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { ChatEventGroup, EnrichedChatEvent } from "./chat-event.ts";
import { messageDocumentToDisplayText } from "../okou-page/user-message-document-codec.ts";
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
  readonly selectableCount$: Computed<number>;
  readonly allSelected$: Computed<boolean>;
  readonly toggleAll$: Command<ToggleSharedThreadSelectionResult, []>;
  readonly createdSharedThreadId$: Computed<string | null>;
  readonly copiedMessageEventId$: Computed<string | null>;
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
   * inside the click gesture; the share is created afterwards. Reports copy
   * and creation failures at the action.
   */
  readonly shareMessage$: Command<
    Promise<void>,
    [readonly string[], SharedThreadAudience, AbortSignal]
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

export function shareableEventFromChatEvent(
  event: EnrichedChatEvent,
): { readonly id: string; readonly text: string } | null {
  if (event.seqId === undefined) {
    return null;
  }
  if (event.eventType === "output.message") {
    return event.content && event.content.length > 0
      ? { id: event.id, text: event.content }
      : null;
  }
  if (
    event.eventType !== "input.prompt" &&
    event.eventType !== "input.automation"
  ) {
    return null;
  }
  const displayText = messageDocumentToDisplayText(event.userMessage)?.trim();
  if (displayText) {
    return { id: event.id, text: displayText };
  }
  const automation = event.userMessage?.parts.find((part) => {
    return part.type === "automation";
  });
  if (automation?.type !== "automation") {
    return null;
  }
  const automationText =
    automation.automationBrief?.trim() || automation.workflowName.trim();
  return automationText.length > 0
    ? { id: event.id, text: automationText }
    : null;
}

function shareableGroups(
  groups: readonly ChatEventGroup[],
): ReadonlyMap<string, SelectedGroup> {
  const activeGroups = groups.flatMap((group) => {
    const events = group.events.filter((event) => {
      return !event.isQueued;
    });
    return events.length === 0 ? [] : [{ ...group, events }];
  });
  const shareable = new Map<string, SelectedGroup>();
  for (const group of buildRunWorkFolding(activeGroups).visibleGroups) {
    const events = chatGroupForSharing(group).events.flatMap((event) => {
      const shareableEvent = shareableEventFromChatEvent(event);
      return shareableEvent ? [shareableEvent] : [];
    });
    if (events.length > 0) {
      shareable.set(group.beginEventId, { events, bytes: groupBytes(events) });
    }
  }
  return shareable;
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

function createMessageSharingSignals(
  threadId: string,
  allChatGroups$: Computed<ChatEventGroup[]>,
): Pick<ChatThreadSharingSignals, "shareMessage$" | "copiedMessageEventId$"> {
  const copiedMessageEventId$ = state<string | null>(null);
  const resetCopied$ = resetSignal();
  const shareMessage$ = command(
    async (
      { get, set },
      assistantEventIds: readonly string[],
      audience: SharedThreadAudience,
      signal: AbortSignal,
    ): Promise<void> => {
      const firstEventId = assistantEventIds[0];
      if (firstEventId === undefined) {
        return;
      }
      const confirmationSignal = set(resetCopied$, signal);
      const eventIds = messageShareEventIds(
        get(allChatGroups$),
        assistantEventIds,
      );
      const id = crypto.randomUUID();
      // Start the clipboard write synchronously in the user gesture. Waiting
      // for the API first would lose the gesture in Safari.
      const copied = writeToClipboard(sharedThreadUrl(id));
      // Confirm and start resetting in the click while the server creates
      // the optimistically generated link.
      set(copiedMessageEventId$, firstEventId);
      timeout(
        () => {
          set(copiedMessageEventId$, null);
        },
        2000,
        { signal: confirmationSignal },
      );
      const creation = accept(
        get(apiClient$)(sharedThreadVisibilityContract).create({
          params: { threadId },
          body: { eventIds: [...eventIds], id, audience },
          fetchOptions: { signal },
        }),
        [201, 400, 403, 404, 409, 413],
        signal,
      );
      const [shared] = await Promise.allSettled([
        Promise.all([copied, creation]),
      ]);
      signal.throwIfAborted();
      if (shared.status === "rejected") {
        if (!confirmationSignal.aborted) {
          set(copiedMessageEventId$, null);
        }
        throw shared.reason;
      }
      const [copySucceeded, result] = shared.value;
      if (
        (!copySucceeded || result.status !== 201) &&
        !confirmationSignal.aborted
      ) {
        set(copiedMessageEventId$, null);
      }
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
        return;
      }
    },
  );
  return {
    shareMessage$,
    copiedMessageEventId$: computed((get) => {
      return get(copiedMessageEventId$);
    }),
  };
}

function createShareCommand({
  threadId,
  selectedGroups$,
  audience$,
  internalCreatedSharedThreadId$,
  internalPhase$,
  visibility$,
}: {
  readonly threadId: string;
  readonly selectedGroups$: Computed<ReadonlyMap<string, SelectedGroup>>;
  readonly audience$: Computed<SharedThreadAudience>;
  readonly internalCreatedSharedThreadId$: State<string | null>;
  readonly internalPhase$: State<SharedThreadSelectionPhase>;
  readonly visibility$: Computed<SharedThreadVisibilitySignals | null>;
}): ChatThreadSharingSignals["create$"] {
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const eventIds = [...get(selectedGroups$).values()].flatMap((group) => {
      return group.events.map((event) => {
        return event.id;
      });
    });
    if (eventIds.length === 0) {
      return;
    }
    const result = await accept(
      get(apiClient$)(sharedThreadVisibilityContract).create({
        params: { threadId },
        body: { eventIds, audience: get(audience$) },
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
    const refreshed =
      (await get(featureSwitches$))[FeatureSwitchKey.ChatShareRefresh] === true;
    signal.throwIfAborted();
    const session = get(visibility$);
    if (refreshed && session) {
      // Copy through the link's own Copy link action, so the confirmation is
      // that button reading "Copied" rather than a toast over the header. A
      // failed copy still toasts.
      await set(session.copy$, signal);
      return;
    }
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
    return id !== null ? createSharedThreadVisibilitySignals(id) : null;
  });
}

function createSharedThreadAudienceSignals() {
  const draft$ = state<SharedThreadAudience>("public");
  return {
    audience$: computed((get) => {
      return get(draft$);
    }),
    changeAudience$: command(({ set }, audience: SharedThreadAudience) => {
      set(draft$, audience);
    }),
  };
}

function createToggleSelectionCommand(
  selectedGroups$: Computed<ReadonlyMap<string, SelectedGroup>>,
  internalSelectedGroups$: State<ReadonlyMap<string, SelectedGroup>>,
) {
  return command(
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
}

function createBulkSelectionSignals(
  internalPhase$: State<SharedThreadSelectionPhase>,
  shareableGroups$: Computed<ReadonlyMap<string, SelectedGroup>>,
  selectedGroups$: Computed<ReadonlyMap<string, SelectedGroup>>,
  internalSelectedGroups$: State<ReadonlyMap<string, SelectedGroup>>,
) {
  const allSelected$ = computed((get) => {
    const shareable = get(shareableGroups$);
    const selected = get(selectedGroups$);
    return (
      shareable.size > 0 &&
      [...shareable].every(([key, group]) => {
        const selectedIds = new Set(
          selected.get(key)?.events.map((event) => {
            return event.id;
          }),
        );
        return group.events.every((event) => {
          return selectedIds.has(event.id);
        });
      })
    );
  });
  const toggleAll$ = command(
    ({ get, set }): ToggleSharedThreadSelectionResult => {
      if (get(internalPhase$) !== "selecting") {
        return "deselected";
      }
      if (get(allSelected$)) {
        set(internalSelectedGroups$, new Map());
        return "deselected";
      }
      const groups = get(shareableGroups$);
      const bytes = [...groups.values()].reduce((total, group) => {
        return total + group.bytes;
      }, 0);
      if (bytes > SHARED_THREAD_SELECTION_TEXT_LIMIT_BYTES) {
        return "too-large";
      }
      set(internalSelectedGroups$, groups);
      return "selected";
    },
  );

  return {
    allSelected$,
    toggleAll$,
    selectableCount$: computed((get) => {
      return get(shareableGroups$).size;
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
  // Selection covers the complete shareable transcript, including messages
  // outside the render window, but never queued messages or hidden run work.
  const shareableGroups$ = computed((get) => {
    return shareableGroups(get(allChatGroups$));
  });
  const sharingEventIds$ = computed((get) => {
    return new Set(
      [...get(shareableGroups$).values()].flatMap((group) => {
        return group.events.map((event) => {
          return event.id;
        });
      }),
    );
  });
  const selectedGroups$ = computed((get) => {
    const selected = get(internalSelectedGroups$);
    if (selected.size === 0) {
      return selected;
    }
    return filterSelectedGroups(selected, get(sharingEventIds$));
  });

  const bulkSelection = createBulkSelectionSignals(
    internalPhase$,
    shareableGroups$,
    selectedGroups$,
    internalSelectedGroups$,
  );

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

  const toggle$ = createToggleSelectionCommand(
    selectedGroups$,
    internalSelectedGroups$,
  );

  const visibility$ = createShareVisibility$(internalCreatedSharedThreadId$);
  const create$ = createShareCommand({
    threadId,
    selectedGroups$,
    audience$,
    internalCreatedSharedThreadId$,
    internalPhase$,
    visibility$,
  });

  const { shareMessage$, copiedMessageEventId$ } = createMessageSharingSignals(
    threadId,
    allChatGroups$,
  );

  return {
    audience$,
    changeAudience$,
    visibility$,
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
    ...bulkSelection,
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
    copiedMessageEventId$,
  };
}
