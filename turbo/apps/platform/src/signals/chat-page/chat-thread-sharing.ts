import { messageDocumentToDisplayText } from "../okou-page/user-message-document-codec.ts";
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
import type { ChatEventGroup, EnrichedChatEvent } from "./chat-event.ts";
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
  readonly audience$: Computed<SharedThreadAudience | null>;
  readonly creation$: Computed<Promise<void> | null>;
  readonly allSelected$: Computed<boolean>;
  readonly totalCount$: Computed<number>;
  readonly previewGroups$: Computed<ChatEventGroup[]>;
  readonly previewOpen$: Computed<boolean>;
  readonly setPreviewOpen$: Command<void, [boolean]>;
  readonly toggleAll$: Command<ToggleSharedThreadSelectionResult, []>;
  readonly editSelection$: Command<void, []>;
  readonly startMessage$: Command<
    Promise<void>,
    [readonly string[], AbortSignal]
  >;
  readonly changeAudience$: Command<void, [SharedThreadAudience]>;
  readonly visibility$: Computed<SharedThreadVisibilitySignals | null>;
  readonly selectedEventIds$: Computed<ReadonlySet<string>>;
  readonly selectedCount$: Computed<number>;
  readonly createdSharedThreadId$: Computed<string | null>;
  readonly copiedMessageEventId$: Computed<string | null>;
  readonly start$: Command<Promise<void>, [boolean, AbortSignal]>;
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
): ShareableChatEvent | null {
  if (event.seqId === undefined || event.isQueued) {
    return null;
  }
  if (event.eventType === "output.message") {
    return event.content ? { id: event.id, text: event.content } : null;
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
  const text =
    automation?.automationBrief?.trim() || automation?.workflowName.trim();
  return text ? { id: event.id, text } : null;
}

function shareableGroups(groups: readonly ChatEventGroup[]): ChatEventGroup[] {
  const activeGroups = groups.flatMap((group) => {
    const events = group.events.filter((event) => {
      return !event.isQueued;
    });
    return events.length === 0 ? [] : [{ ...group, events }];
  });
  return buildRunWorkFolding(activeGroups).visibleGroups.flatMap((group) => {
    const events = chatGroupForSharing(group).events.filter((event) => {
      return shareableEventFromChatEvent(event) !== null;
    });
    return events.length > 0 ? [{ ...group, events }] : [];
  });
}

function selectionForGroups(
  groups: readonly ChatEventGroup[],
): ReadonlyMap<string, SelectedGroup> {
  return new Map(
    groups.map((group) => {
      const events = group.events.flatMap((event) => {
        const shareable = shareableEventFromChatEvent(event);
        return shareable ? [shareable] : [];
      });
      return [group.beginEventId, { events, bytes: groupBytes(events) }];
    }),
  );
}

function selectionTooLarge(
  groups: ReadonlyMap<string, SelectedGroup>,
): boolean {
  return (
    [...groups.values()].reduce((total, group) => {
      return total + group.bytes;
    }, 0) > SHARED_THREAD_SELECTION_TEXT_LIMIT_BYTES
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

function createShareCommand(
  threadId: string,
  selectedGroups$: Computed<ReadonlyMap<string, SelectedGroup>>,
  audience$: Computed<SharedThreadAudience | null>,
  internalCreatedSharedThreadId$: State<string | null>,
  internalPhase$: State<SharedThreadSelectionPhase>,
): ChatThreadSharingSignals["create$"] {
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const eventIds = [...get(selectedGroups$).values()].flatMap((group) => {
      return group.events.map((event) => {
        return event.id;
      });
    });
    const audience = get(audience$);
    if (eventIds.length === 0 || audience === null) {
      return;
    }
    const result = await accept(
      get(apiClient$)(sharedThreadVisibilityContract).create({
        params: { threadId },
        body: { eventIds, audience },
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
    return id !== null ? createSharedThreadVisibilitySignals(id) : null;
  });
}

function createSharingDraft() {
  return {
    phase$: state<SharedThreadSelectionPhase>("idle"),
    audience$: state<SharedThreadAudience | null>(null),
    request$: state<Promise<void> | null>(null),
    previewOpen$: state(false),
    preserveDraft$: state(false),
    selected$: state<ReadonlyMap<string, SelectedGroup>>(new Map()),
    createdId$: state<string | null>(null),
  };
}
type SharingDraft = ReturnType<typeof createSharingDraft>;

function createSharingSelection(
  allChatGroups$: Computed<ChatEventGroup[]>,
  draft: SharingDraft,
) {
  const groups$ = computed((get) => {
    return shareableGroups(get(allChatGroups$));
  });
  const eventIds$ = computed((get) => {
    // Selection belongs to the complete transcript, including unmounted rows.
    return new Set(
      get(groups$).flatMap((group) => {
        return group.events.map((event) => {
          return event.id;
        });
      }),
    );
  });
  const selectedGroups$ = computed((get) => {
    const selected = get(draft.selected$);
    return selected.size > 0
      ? filterSelectedGroups(selected, get(eventIds$))
      : selected;
  });
  const selectedEventIds$ = computed((get) => {
    return new Set(
      [...get(selectedGroups$).values()].flatMap((group) => {
        return group.events.map((event) => {
          return event.id;
        });
      }),
    );
  });
  return {
    groups$,
    selectedGroups$,
    selectedEventIds$,
    selectedCount$: computed((get) => {
      return get(selectedGroups$).size;
    }),
    totalCount$: computed((get) => {
      return get(groups$).length;
    }),
    allSelected$: computed((get) => {
      const ids = get(eventIds$);
      const selected = get(selectedEventIds$);
      return (
        ids.size > 0 &&
        [...ids].every((id) => {
          return selected.has(id);
        })
      );
    }),
    previewGroups$: computed((get) => {
      const selected = get(selectedEventIds$);
      return get(groups$).flatMap((group) => {
        const events = group.events.filter((event) => {
          return selected.has(event.id);
        });
        return events.length > 0 ? [{ ...group, events }] : [];
      });
    }),
  };
}
type SharingSelection = ReturnType<typeof createSharingSelection>;

function createSharingSelectionCommands(
  draft: SharingDraft,
  selection: SharingSelection,
) {
  const toggle$ = command(
    (
      { get, set },
      groupKey: string,
      events: readonly ShareableChatEvent[],
    ): ToggleSharedThreadSelectionResult => {
      if (get(draft.request$) !== null || get(draft.phase$) !== "selecting") {
        return "deselected";
      }
      const selected = get(selection.selectedGroups$);
      const stored = selected.get(groupKey);
      // A growing group is partial; selecting it includes the newly arrived messages.
      const storedIds = new Set(
        stored?.events.map((event) => {
          return event.id;
        }),
      );
      const allSelected = events.every((event) => {
        return storedIds.has(event.id);
      });
      if (stored !== undefined && allSelected) {
        const next = new Map(selected);
        next.delete(groupKey);
        set(draft.selected$, next);
        return "deselected";
      }
      const next = new Map(selected).set(groupKey, {
        events,
        bytes: groupBytes(events),
      });
      if (selectionTooLarge(next)) {
        return "too-large";
      }
      set(draft.selected$, next);
      return "selected";
    },
  );
  const toggleAll$ = command(
    ({ get, set }): ToggleSharedThreadSelectionResult => {
      if (get(draft.request$) !== null || get(draft.phase$) !== "selecting") {
        return "deselected";
      }
      if (get(selection.allSelected$)) {
        set(draft.selected$, new Map());
        return "deselected";
      }
      const selected = selectionForGroups(get(selection.groups$));
      if (selectionTooLarge(selected)) {
        return "too-large";
      }
      set(draft.selected$, selected);
      return "selected";
    },
  );
  return { toggle$, toggleAll$ };
}

type SharingScroll = Pick<
  ChatThreadScrollSignals,
  "autoScroll$" | "readRenderedThreadScrollPosition$"
>;

function createSharingLifecycle(
  draft: SharingDraft,
  scroll: SharingScroll,
  closeFeedbackSelection$: Command<void, []>,
) {
  const reset$ = command(({ set }) => {
    set(draft.selected$, new Map());
    set(draft.createdId$, null);
    set(draft.audience$, "public");
  });
  return {
    start$: command(
      async ({ get, set }, preserveDraft: boolean, signal: AbortSignal) => {
        signal.throwIfAborted();
        if (get(draft.request$) !== null) {
          return;
        }
        set(draft.preserveDraft$, preserveDraft);
        const position = set(
          scroll.readRenderedThreadScrollPosition$,
          "[data-chat-run-work-history], [data-chat-run-status-tail]",
        );
        set(closeFeedbackSelection$);
        if (!preserveDraft) {
          set(reset$);
        }
        set(draft.phase$, get(draft.createdId$) ? "created" : "selecting");
        await set(scroll.autoScroll$, position, signal);
      },
    ),
    close$: command(async ({ get, set }, signal: AbortSignal) => {
      signal.throwIfAborted();
      if (get(draft.request$) !== null) {
        return;
      }
      const position = set(scroll.readRenderedThreadScrollPosition$);
      if (!get(draft.preserveDraft$)) {
        set(reset$);
      }
      set(draft.previewOpen$, false);
      set(draft.phase$, "idle");
      await set(scroll.autoScroll$, position, signal);
    }),
    editSelection$: command(({ get, set }) => {
      if (get(draft.request$) !== null) {
        return;
      }
      // The saved snapshot is immutable. Editing this draft creates a new link.
      set(draft.createdId$, null);
      set(draft.phase$, "selecting");
    }),
  };
}

function createMessageSelectionCommand(
  allChatGroups$: Computed<ChatEventGroup[]>,
  draft: SharingDraft,
  selection: SharingSelection,
  start$: ChatThreadSharingSignals["start$"],
) {
  return command(
    async ({ get, set }, eventIds: readonly string[], signal: AbortSignal) => {
      signal.throwIfAborted();
      if (get(draft.request$) !== null) {
        return;
      }
      const ids = new Set(messageShareEventIds(get(allChatGroups$), eventIds));
      const groups = get(selection.groups$).flatMap((group) => {
        const events = group.events.filter((event) => {
          return ids.has(event.id);
        });
        return events.length > 0 ? [{ ...group, events }] : [];
      });
      const selected = selectionForGroups(groups);
      if (selectionTooLarge(selected)) {
        toast.error(
          i18n.t(($) => {
            return $.chat.sharing.tooLarge;
          }),
        );
        return;
      }
      set(draft.selected$, selected);
      set(draft.createdId$, null);
      set(draft.audience$, null);
      await set(start$, true, signal);
    },
  );
}

export function createChatThreadSharingSignals(
  threadId: string,
  scroll: SharingScroll,
  allChatGroups$: Computed<ChatEventGroup[]>,
  closeFeedbackSelection$: Command<void, []>,
): ChatThreadSharingSignals {
  const draft = createSharingDraft();
  const selection = createSharingSelection(allChatGroups$, draft);
  const lifecycle = createSharingLifecycle(
    draft,
    scroll,
    closeFeedbackSelection$,
  );
  const audience$ = computed((get) => {
    return get(draft.audience$);
  });
  const createSnapshot$ = createShareCommand(
    threadId,
    selection.selectedGroups$,
    audience$,
    draft.createdId$,
    draft.phase$,
  );
  const create$ = command(async ({ get, set }, signal: AbortSignal) => {
    if (get(draft.request$) !== null || get(draft.phase$) !== "selecting") {
      return;
    }
    const request = set(createSnapshot$, signal);
    set(draft.request$, request);
    await request.finally(() => {
      set(draft.request$, null);
    });
  });
  return {
    ...lifecycle,
    ...createSharingSelectionCommands(draft, selection),
    ...createMessageSharingSignals(threadId, allChatGroups$),
    audience$,
    changeAudience$: command(({ get, set }, audience: SharedThreadAudience) => {
      if (get(draft.request$) === null) {
        set(draft.audience$, audience);
      }
    }),
    creation$: computed((get) => {
      return get(draft.request$);
    }),
    phase$: computed((get) => {
      return get(draft.phase$);
    }),
    createdSharedThreadId$: computed((get) => {
      return get(draft.createdId$);
    }),
    visibility$: createShareVisibility$(draft.createdId$),
    selectedEventIds$: selection.selectedEventIds$,
    selectedCount$: selection.selectedCount$,
    allSelected$: selection.allSelected$,
    totalCount$: selection.totalCount$,
    previewGroups$: selection.previewGroups$,
    previewOpen$: computed((get) => {
      return get(draft.previewOpen$);
    }),
    setPreviewOpen$: command(({ get, set }, open: boolean) => {
      if (
        !open ||
        (get(draft.request$) === null && get(selection.selectedCount$) > 0)
      ) {
        set(draft.previewOpen$, open);
      }
    }),
    startMessage$: createMessageSelectionCommand(
      allChatGroups$,
      draft,
      selection,
      lifecycle.start$,
    ),
    create$,
  };
}
