import { messageDocumentToDisplayText } from "../okou-page/user-message-document-codec.ts";
import { chatShareSelectionContract } from "@okouai/api-contracts/client/chat-share-selection";
import type { ChatShareSelection } from "@okouai/api-contracts/contracts/chat-share-selection-types";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../external/feature-switch.ts";
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
  readonly selection$: Computed<ChatShareSelection | null>;
  readonly startFromMessage$: Command<
    Promise<void>,
    [readonly string[], AbortSignal]
  >;
  readonly audience$: Computed<SharedThreadAudience>;
  readonly changeAudience$: Command<void, [SharedThreadAudience]>;
  readonly visibility$: Computed<SharedThreadVisibilitySignals | null>;
  readonly selectedEventIds$: Computed<ReadonlySet<string>>;
  readonly selectedCount$: Computed<number>;
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
   * The unified flow confirms creation before copying and retains the link
   * when clipboard access is denied. The gated legacy flow stays compatible.
   */
  readonly shareMessage$: Command<
    Promise<void>,
    [readonly string[], SharedThreadAudience, AbortSignal]
  >;
}

// Legacy selection counts visual groups. Unified selection creates one entry
// per canonical message, so both flows count the units the reader can tick.
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

function selectedGroupsFromEvents(
  groups: readonly ChatEventGroup[],
  ids: readonly string[],
): ReadonlyMap<string, SelectedGroup> {
  // Keep canonical order and prompts outside the loaded history page.
  // The API validates snapshot size and eligibility for every selected ID.
  const selected = new Map<string, SelectedGroup>();
  for (const id of ids) {
    selected.set(id, { events: [{ id, text: "" }], bytes: 0 });
  }
  for (const group of groups) {
    for (const event of group.events) {
      if (selected.has(event.id)) {
        const events = [
          {
            id: event.id,
            text:
              event.content ??
              messageDocumentToDisplayText(
                "userMessage" in event ? event.userMessage : undefined,
              ) ??
              "",
          },
        ];
        selected.set(event.id, { events, bytes: groupBytes(events) });
      }
    }
  }
  return selected;
}

function createSelectionStates() {
  return {
    internalPhase$: state<SharedThreadSelectionPhase>("idle"),
    selection$: state<ChatShareSelection | null>(null),
    attempt$: state<string | null>(null),
    internalSelectedGroups$: state<ReadonlyMap<string, SelectedGroup>>(
      new Map(),
    ),
    internalCreatedSharedThreadId$: state<string | null>(null),
  };
}

type SelectionStates = ReturnType<typeof createSelectionStates>;

function createUnifiedMessageShareCommand(
  threadId: string,
  allChatGroups$: Computed<ChatEventGroup[]>,
  states: SelectionStates,
  confirmation: {
    copiedMessageEventId$: State<string | null>;
    resetCopied$: ReturnType<typeof resetSignal>;
  },
): ChatThreadSharingSignals["shareMessage$"] {
  const {
    selection$: selectionState$,
    internalSelectedGroups$: selectedState$,
    internalCreatedSharedThreadId$: createdState$,
    internalPhase$: phaseState$,
  } = states;
  const { copiedMessageEventId$, resetCopied$ } = confirmation;
  const messageAttempt$ = state<{ key: string; id: string } | null>(null);
  return command(
    async (
      { get, set },
      assistantEventIds: readonly string[],
      audience: SharedThreadAudience,
      signal: AbortSignal,
    ): Promise<void> => {
      const selection = await accept(
        get(apiClient$)(chatShareSelectionContract).get({
          params: { threadId },
          fetchOptions: { signal },
        }),
        [200],
        signal,
      );
      const answer = [...selection.body.messages].reverse().find((message) => {
        return (
          message.role === "assistant" &&
          assistantEventIds.includes(message.eventId)
        );
      });
      if (!answer) {
        throw new Error("This answer is no longer available for sharing.");
      }
      const key = JSON.stringify([audience, answer.turnEventIds]);
      const previous = get(messageAttempt$);
      const id = previous?.key === key ? previous.id : crypto.randomUUID();
      set(messageAttempt$, { key, id });
      let recovered = false;
      if (previous?.key === key) {
        const existing = await accept(
          get(apiClient$)(sharedThreadVisibilityContract).get({
            params: { id },
            fetchOptions: { signal },
          }),
          [200, 404],
          signal,
        );
        if (existing.status === 200) {
          if (existing.body.audience !== audience) {
            await accept(
              get(apiClient$)(sharedThreadVisibilityContract).update({
                params: { id },
                body: { audience, expectedRevision: existing.body.revision },
                fetchOptions: { signal },
              }),
              [200],
              signal,
            );
          }
          recovered = true;
        }
      }
      if (!recovered) {
        await accept(
          get(apiClient$)(chatShareSelectionContract).create({
            params: { threadId },
            body: { id, audience, eventIds: answer.turnEventIds },
            fetchOptions: { signal },
          }),
          [201],
          signal,
        );
      }
      const copied = await writeToClipboard(sharedThreadUrl(id));
      signal.throwIfAborted();
      if (copied) {
        set(messageAttempt$, null);
        set(copiedMessageEventId$, answer.eventId);
        timeout(
          () => {
            return set(copiedMessageEventId$, null);
          },
          2000,
          {
            signal: set(resetCopied$, signal),
          },
        );
      } else {
        set(selectionState$, selection.body);
        set(
          selectedState$,
          selectedGroupsFromEvents(get(allChatGroups$), answer.turnEventIds),
        );
        set(createdState$, id);
        set(phaseState$, "created");
        toast.error(
          i18n.t(($) => {
            return $.chat.sharing.copyFailed;
          }),
        );
      }
    },
  );
}

function createMessageSharingSignals(
  threadId: string,
  allChatGroups$: Computed<ChatEventGroup[]>,
  states: SelectionStates,
): Pick<ChatThreadSharingSignals, "shareMessage$" | "copiedMessageEventId$"> {
  const copiedMessageEventId$ = state<string | null>(null);
  const resetCopied$ = resetSignal();
  const unifiedShare$ = createUnifiedMessageShareCommand(
    threadId,
    allChatGroups$,
    states,
    { copiedMessageEventId$, resetCopied$ },
  );
  const shareMessage$ = command(
    async (
      { get, set },
      assistantEventIds: readonly string[],
      audience: SharedThreadAudience,
      signal: AbortSignal,
    ): Promise<void> => {
      if (get(featureSwitch$)[FeatureSwitchKey.ChatSharingSelection]) {
        return set(unifiedShare$, assistantEventIds, audience, signal);
      }
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

const finishCreatedShare$ = command(
  async (
    { set },
    id: string,
    created$: State<string | null>,
    phase$: State<SharedThreadSelectionPhase>,
    signal: AbortSignal,
  ) => {
    set(created$, id);
    set(phase$, "created");
    const copied = await writeToClipboard(sharedThreadUrl(id));
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
  },
);

function createShareCommand(
  threadId: string,
  selectedGroups$: Computed<ReadonlyMap<string, SelectedGroup>>,
  audience$: Computed<SharedThreadAudience>,
  states: SelectionStates,
): ChatThreadSharingSignals["create$"] {
  const {
    internalCreatedSharedThreadId$,
    internalPhase$,
    selection$,
    internalSelectedGroups$: selectedState$,
    attempt$,
  } = states;
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const previousAttempt = get(attempt$);
    if (
      previousAttempt &&
      get(featureSwitch$)[FeatureSwitchKey.ChatSharingSelection]
    ) {
      const existing = await accept(
        get(apiClient$)(sharedThreadVisibilityContract).get({
          params: { id: previousAttempt },
          fetchOptions: { signal },
        }),
        [200, 404],
        signal,
      );
      if (existing.status === 200) {
        const audience = get(audience$);
        if (existing.body.audience !== audience) {
          await accept(
            get(apiClient$)(sharedThreadVisibilityContract).update({
              params: { id: existing.body.id },
              body: { audience, expectedRevision: existing.body.revision },
              fetchOptions: { signal },
            }),
            [200],
            signal,
          );
        }
        await set(
          finishCreatedShare$,
          existing.body.id,
          internalCreatedSharedThreadId$,
          internalPhase$,
          signal,
        );
        return;
      }
    }
    const eventIds = [...get(selectedGroups$).values()].flatMap((group) => {
      return group.events.map((event) => {
        return event.id;
      });
    });
    if (eventIds.length === 0) {
      return;
    }
    const unified = get(featureSwitch$)[FeatureSwitchKey.ChatSharingSelection];
    if (unified) {
      const current = await accept(
        get(apiClient$)(chatShareSelectionContract).get({
          params: { threadId },
          fetchOptions: { signal },
        }),
        [200],
        signal,
      );
      set(selection$, current.body);
      const valid = new Set(
        current.body.messages.map((message) => {
          return message.eventId;
        }),
      );
      if (
        eventIds.some((id) => {
          return !valid.has(id);
        })
      ) {
        set(selectedState$, filterSelectedGroups(get(selectedState$), valid));
        throw new Error(
          "Selected messages changed. Review your selection and try again.",
        );
      }
    }
    const attempt = get(attempt$) ?? crypto.randomUUID();
    set(attempt$, attempt);
    const client = unified
      ? get(apiClient$)(chatShareSelectionContract)
      : get(apiClient$)(sharedThreadVisibilityContract);
    const result = await accept(
      client.create({
        params: { threadId },
        body: { eventIds, id: attempt, audience: get(audience$) },
        fetchOptions: { signal },
      }),
      [201, 400, 413],
      signal,
    );
    if (result.status !== 201) {
      throw new Error(result.body.error.message);
    }
    await set(
      finishCreatedShare$,
      result.body.id,
      internalCreatedSharedThreadId$,
      internalPhase$,
      signal,
    );
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

function createToggleShareCommand(
  selectedGroups$: Computed<ReadonlyMap<string, SelectedGroup>>,
  states: SelectionStates,
): ChatThreadSharingSignals["toggle$"] {
  const { attempt$, internalSelectedGroups$ } = states;
  return command(
    (
      { get, set },
      groupKey: string,
      events: readonly ShareableChatEvent[],
    ): ToggleSharedThreadSelectionResult => {
      set(attempt$, null);
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

function createStartFromMessageCommand(
  start$: ChatThreadSharingSignals["start$"],
  states: SelectionStates,
  allChatGroups$: Computed<ChatEventGroup[]>,
): ChatThreadSharingSignals["startFromMessage$"] {
  const { selection$, internalSelectedGroups$ } = states;
  return command(
    async ({ get, set }, ids: readonly string[], signal: AbortSignal) => {
      await set(start$, signal);
      const answer = get(selection$)
        ?.messages.slice()
        .reverse()
        .find((message) => {
          return message.role === "assistant" && ids.includes(message.eventId);
        });
      if (!answer) {
        throw new Error("This answer is no longer available for sharing.");
      }
      set(
        internalSelectedGroups$,
        selectedGroupsFromEvents(get(allChatGroups$), answer.turnEventIds),
      );
    },
  );
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
  const states = createSelectionStates();
  const {
    internalPhase$,
    selection$,
    attempt$,
    internalSelectedGroups$,
    internalCreatedSharedThreadId$,
  } = states;
  const { audience$, changeAudience$ } = createSharedThreadAudienceSignals();
  const sharingEventIds$ = computed((get) => {
    // Use the complete transcript: scrolling a selected row out of the render
    // window must not remove it from the share.
    const selection = get(selection$);
    return selection !== null
      ? new Set(
          selection.messages.map((message) => {
            return message.eventId;
          }),
        )
      : shareableEventIds(get(allChatGroups$));
  });
  const selectedGroups$ = computed((get) => {
    const selected = get(internalSelectedGroups$);
    if (selected.size === 0) {
      return selected;
    }
    return get(featureSwitch$)[FeatureSwitchKey.ChatSharingSelection]
      ? selected
      : filterSelectedGroups(selected, get(sharingEventIds$));
  });

  const start$ = command(async ({ get, set }, signal: AbortSignal) => {
    if (get(featureSwitch$)[FeatureSwitchKey.ChatSharingSelection]) {
      const result = await accept(
        get(apiClient$)(chatShareSelectionContract).get({
          params: { threadId },
          fetchOptions: { signal },
        }),
        [200],
        signal,
      );
      set(selection$, result.body);
    }
    set(attempt$, null);
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
    set(selection$, null);
    set(attempt$, null);
    set(internalCreatedSharedThreadId$, null);
    set(changeAudience$, "public");
    set(internalPhase$, "idle");
    return set(scroll.autoScroll$, position, signal);
  });

  const toggle$ = createToggleShareCommand(selectedGroups$, states);

  const create$ = createShareCommand(
    threadId,
    selectedGroups$,
    audience$,
    states,
  );

  const { shareMessage$, copiedMessageEventId$ } = createMessageSharingSignals(
    threadId,
    allChatGroups$,
    states,
  );

  const startFromMessage$ = createStartFromMessageCommand(
    start$,
    states,
    allChatGroups$,
  );

  return {
    selection$: computed((get) => {
      return get(selection$);
    }),
    startFromMessage$,
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
    copiedMessageEventId$,
  };
}
