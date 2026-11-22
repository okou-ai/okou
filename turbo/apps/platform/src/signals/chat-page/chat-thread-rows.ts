import { command, computed, state, type Computed, type State } from "ccstate";
import {
  chatThreadDateDividers,
  type ChatDateDivider,
} from "../../lib/chat-thread-date-dividers.ts";
import { equalArrays } from "../../lib/equality.ts";
import { locale$ } from "../locale.ts";
import type { ChatEventGroup, EnrichedChatEvent } from "./chat-event.ts";
import {
  isRenderableAssistantEvent,
  rendersUserBubble,
} from "./chat-event-display.ts";
import { chatEventGroupKeys } from "./chat-event-group-keys.ts";
import type { ThreadScrollPosition } from "./chat-thread-scroll.ts";
import {
  modelChangesByEventId,
  sameRunModelChange,
  type RunModelChange,
} from "./run-model-changes.ts";
import {
  buildRunWorkFolding,
  runWorkExpandedKeys$,
  runWorkSectionForGroup,
  type RunWorkFolding,
  type RunWorkSection,
} from "./run-work-folding.ts";

/**
 * One rendered transcript row: a group after queued input left for the queue
 * bar and run work folded behind its anchor, plus the row-level facts that
 * depend on its neighbours.
 */
export interface ChatThreadRowModel {
  readonly group: ChatEventGroup;
  readonly runWorkSection: RunWorkSection | null;
  readonly statusTailEvents: readonly EnrichedChatEvent[] | undefined;
  /** The previous row on screen ends with a user bubble to stack against. */
  readonly stackFirstOnPrevious: boolean;
  /** The run status row (thinking or finished) renders in this row. */
  readonly holdsStatusRow: boolean;
  readonly dateDividers: ReadonlyMap<string, ChatDateDivider>;
  readonly modelChanges: ReadonlyMap<string, RunModelChange>;
}

export interface ChatThreadRowSignals {
  readonly model$: Computed<ChatThreadRowModel>;
  /** The row's folded run work is open, by the reader or the held position. */
  readonly runWorkExpanded$: Computed<boolean>;
}

interface ChatThreadRow extends ChatThreadRowSignals {
  readonly internalModel$: State<ChatThreadRowModel>;
}

interface ChatThreadRowDraft {
  readonly key: string;
  readonly model: ChatThreadRowModel;
}

type RunWorkArtifactCard = RunWorkSection["remainingArtifactCards"][number];

/** Rows without the status row read these instead of the run's status. */
export const idleThinkingIndicatorsShown$ = computed((): Promise<boolean> => {
  return Promise.resolve(false);
});

export const idleRunFinished$ = computed((): Promise<boolean> => {
  return Promise.resolve(false);
});

export function splitQueuedEventsForThinkingIndicator(
  groups: readonly ChatEventGroup[],
): {
  activeGroups: ChatEventGroup[];
  queuedGroups: ChatEventGroup[];
} {
  const activeGroups: ChatEventGroup[] = [];
  const queuedEvents: EnrichedChatEvent[] = [];

  for (const group of groups) {
    if (group.role !== "user") {
      activeGroups.push(group);
      continue;
    }

    const activeEvents: EnrichedChatEvent[] = [];
    for (const event of group.events) {
      if (event.isQueued) {
        queuedEvents.push(event);
      } else {
        activeEvents.push(event);
      }
    }

    if (activeEvents.length > 0) {
      activeGroups.push({
        ...group,
        beginEventId: activeEvents[0]!.id,
        events: activeEvents,
      });
    }
  }

  return {
    activeGroups,
    queuedGroups:
      queuedEvents.length > 0
        ? [
            {
              beginEventId: queuedEvents[0]!.id,
              role: "user",
              events: queuedEvents,
            },
          ]
        : [],
  };
}

// An assistant group whose events are all bookkeeping — a run's terminal event,
// usage — puts nothing on screen, so it must not break a stack of user
// messages that visually sit right on top of each other.
function groupRendersContent(
  group: ChatEventGroup,
  runWorkSection: RunWorkSection | null,
): boolean {
  if (runWorkSection !== null) {
    return true;
  }
  if (group.role === "user") {
    return group.events.some(rendersUserBubble);
  }
  return group.events.some(isRenderableAssistantEvent);
}

// A user group can be on screen for its fold alone, with every message in it
// rendering as a card or as nothing, and there is no bubble to stack against.
function groupHasUserBubble(group: ChatEventGroup): boolean {
  return group.events.some(rendersUserBubble);
}

// The status row belongs to the run's work anchor group, otherwise to the
// latest assistant turn. A status tail event (such as a run error) replaces it.
function statusRowGroupId(
  groups: readonly ChatEventGroup[],
  runWorkFolding: RunWorkFolding,
): string | null {
  const { statusTail } = runWorkFolding;
  if (statusTail?.events.length) {
    return null;
  }
  const anchorEventId = statusTail?.anchorEventId;
  if (anchorEventId !== undefined) {
    const anchorGroup = groups.find((group) => {
      return group.events.some((event) => {
        return event.id === anchorEventId;
      });
    });
    if (anchorGroup !== undefined) {
      return anchorGroup.beginEventId;
    }
  }
  const lastGroup = groups.at(-1);
  return lastGroup?.role === "assistant" ? lastGroup.beginEventId : null;
}

function buildChatThreadRowDrafts(
  renderedGroups: readonly ChatEventGroup[],
  locale: string,
): ChatThreadRowDraft[] {
  const { activeGroups } =
    splitQueuedEventsForThinkingIndicator(renderedGroups);
  const modelChanges = modelChangesByEventId(activeGroups);
  const runWorkFolding = buildRunWorkFolding(activeGroups);
  const groups = runWorkFolding.visibleGroups;
  const sections = groups.map((group) => {
    return runWorkSectionForGroup(runWorkFolding, group);
  });
  const timelineEvents = groups.flatMap((group, index) => {
    if (!groupRendersContent(group, sections[index] ?? null)) {
      return [];
    }
    if (group.role === "user") {
      return group.events;
    }
    const firstVisibleEvent =
      group.events.find(isRenderableAssistantEvent) ?? group.events[0];
    return firstVisibleEvent === undefined ? [] : [firstVisibleEvent];
  });
  const dateDividers = chatThreadDateDividers(timelineEvents, locale);
  const keys = chatEventGroupKeys(groups, runWorkFolding);
  const statusRowOwnerId = statusRowGroupId(groups, runWorkFolding);
  // A run that ends re-forms the groups around it, so the messages the user
  // sent back to back can land in separate groups with nothing rendered in
  // between. Tracking the last group that actually put something on screen
  // keeps the stack from springing open the moment a run finishes.
  let previousVisibleGroup: ChatEventGroup | undefined;
  return groups.map((group, index) => {
    const runWorkSection = sections[index] ?? null;
    const stackFirstOnPrevious =
      previousVisibleGroup !== undefined &&
      previousVisibleGroup.role === "user" &&
      groupHasUserBubble(previousVisibleGroup);
    if (groupRendersContent(group, runWorkSection)) {
      previousVisibleGroup = group;
    }
    return {
      key: keys[index]!,
      model: {
        group,
        runWorkSection,
        statusTailEvents: runWorkFolding.statusTail?.events.filter((event) => {
          return group.events.includes(event);
        }),
        stackFirstOnPrevious,
        holdsStatusRow: group.beginEventId === statusRowOwnerId,
        dateDividers,
        modelChanges,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Structural sharing: a rebuilt row keeps every object whose fields are
// unchanged, so a row whose content did not change keeps its model identity.
// ---------------------------------------------------------------------------

function sameFields(previous: object, next: object): boolean {
  const nextFields = new Map(Object.entries(next));
  const previousFields = Object.entries(previous);
  return (
    previousFields.length === nextFields.size &&
    previousFields.every(([key, value]) => {
      return nextFields.has(key) && Object.is(nextFields.get(key), value);
    })
  );
}

function sameArtifactCard(
  previous: RunWorkArtifactCard,
  next: RunWorkArtifactCard,
): boolean {
  const { tree: previousTree, ...previousFields } = previous;
  const { tree: nextTree, ...nextFields } = next;
  return (
    sameFields(previousFields, nextFields) &&
    equalArrays(previousTree.children, nextTree.children)
  );
}

function reuseItems<T>(
  previous: readonly T[] | undefined,
  next: readonly T[],
): readonly T[] {
  return previous !== undefined && equalArrays(previous, next)
    ? previous
    : next;
}

function reconcileMap<T>(
  previous: ReadonlyMap<string, T> | undefined,
  next: ReadonlyMap<string, T>,
  sameValue: (previous: T, next: T) => boolean,
): ReadonlyMap<string, T> {
  if (previous === undefined || previous.size !== next.size) {
    return next;
  }
  for (const [key, value] of next) {
    const previousValue = previous.get(key);
    if (previousValue === undefined || !sameValue(previousValue, value)) {
      return next;
    }
  }
  return previous;
}

function rowEventsById(
  models: readonly ChatThreadRowModel[],
): ReadonlyMap<string, EnrichedChatEvent> {
  const events = new Map<string, EnrichedChatEvent>();
  for (const model of models) {
    const groups = [model.group, ...(model.runWorkSection?.hiddenGroups ?? [])];
    for (const group of groups) {
      for (const event of group.events) {
        events.set(event.id, event);
      }
    }
  }
  return events;
}

function reuseEvent(
  previousEvents: ReadonlyMap<string, EnrichedChatEvent>,
  event: EnrichedChatEvent,
): EnrichedChatEvent {
  const previous = previousEvents.get(event.id);
  return previous !== undefined && sameFields(previous, event)
    ? previous
    : event;
}

function reconcileGroup(
  previous: ChatEventGroup | undefined,
  next: ChatEventGroup,
  previousEvents: ReadonlyMap<string, EnrichedChatEvent>,
): ChatEventGroup {
  const events = next.events.map((event) => {
    return reuseEvent(previousEvents, event);
  });
  const candidate =
    previous !== undefined && equalArrays(previous.events, events)
      ? { ...next, events: previous.events }
      : { ...next, events };
  return previous !== undefined && sameFields(previous, candidate)
    ? previous
    : candidate;
}

function reconcileRunWorkSection(
  previous: RunWorkSection | null | undefined,
  next: RunWorkSection | null,
  previousEvents: ReadonlyMap<string, EnrichedChatEvent>,
): RunWorkSection | null {
  if (next === null) {
    return null;
  }
  const hiddenGroups = next.hiddenGroups.map((group, index) => {
    return reconcileGroup(previous?.hiddenGroups[index], group, previousEvents);
  });
  const remainingArtifactCards = next.remainingArtifactCards.map(
    (card, index) => {
      const previousCard = previous?.remainingArtifactCards[index];
      return previousCard !== undefined && sameArtifactCard(previousCard, card)
        ? previousCard
        : card;
    },
  );
  if (previous === undefined || previous === null) {
    return { ...next, hiddenGroups, remainingArtifactCards };
  }
  const candidate: RunWorkSection = {
    ...next,
    hiddenGroups: equalArrays(previous.hiddenGroups, hiddenGroups)
      ? previous.hiddenGroups
      : hiddenGroups,
    remainingArtifactCards: reuseItems(
      previous.remainingArtifactCards,
      remainingArtifactCards,
    ),
  };
  return sameFields(previous, candidate) ? previous : candidate;
}

function reconcileRowModel(
  previous: ChatThreadRowModel | undefined,
  next: ChatThreadRowModel,
  previousEvents: ReadonlyMap<string, EnrichedChatEvent>,
): ChatThreadRowModel {
  const statusTailEvents = next.statusTailEvents?.map((event) => {
    return reuseEvent(previousEvents, event);
  });
  const candidate: ChatThreadRowModel = {
    ...next,
    group: reconcileGroup(previous?.group, next.group, previousEvents),
    runWorkSection: reconcileRunWorkSection(
      previous?.runWorkSection,
      next.runWorkSection,
      previousEvents,
    ),
    statusTailEvents:
      statusTailEvents === undefined
        ? undefined
        : reuseItems(previous?.statusTailEvents, statusTailEvents),
  };
  return previous !== undefined && sameFields(previous, candidate)
    ? previous
    : candidate;
}

function createChatThreadRow(
  model: ChatThreadRowModel,
  scrollTargetEventId$: Computed<string | null>,
): ChatThreadRow {
  const internalModel$ = state(model);
  const model$ = computed((get) => {
    return get(internalModel$);
  });
  const runWorkExpanded$ = computed((get): boolean => {
    const section = get(model$).runWorkSection;
    if (section === null) {
      return false;
    }
    if (get(runWorkExpandedKeys$).has(section.key)) {
      return true;
    }
    // A held reading position inside folded work keeps that work open.
    const targetEventId = get(scrollTargetEventId$);
    return (
      targetEventId !== null &&
      section.hiddenGroups.some((group) => {
        return group.events.some((event) => {
          return event.id === targetEventId;
        });
      })
    );
  });
  return { internalModel$, model$, runWorkExpanded$ };
}

/**
 * The render window's rows with stable signal identities. Rows are derived
 * from the window in `computed`; `syncVisibleRows$` only reconciles that
 * derivation into the rows, so the list changes when rows are added, removed
 * or reordered, and each row changes only when its own content does.
 *
 * The render window syncs after every write that changes it or its prepared
 * resources. Rows keep the identity they were created with while the pane
 * keeps this panel.
 */
export function createChatThreadRows({
  renderedGroups$,
  threadScrollPosition$,
}: {
  readonly renderedGroups$: Computed<readonly ChatEventGroup[]>;
  readonly threadScrollPosition$: Computed<ThreadScrollPosition | null>;
}) {
  const rowDrafts$ = computed((get): ChatThreadRowDraft[] => {
    return buildChatThreadRowDrafts(get(renderedGroups$), get(locale$));
  });
  const scrollTargetEventId$ = computed((get): string | null => {
    return get(threadScrollPosition$)?.targetEventId ?? null;
  });
  const internalRowsByKey$ = state<ReadonlyMap<string, ChatThreadRow>>(
    new Map(),
  );
  const internalVisibleRows$ = state<readonly ChatThreadRow[]>([]);
  const visibleRows$ = computed((get): readonly ChatThreadRowSignals[] => {
    return get(internalVisibleRows$);
  });

  const syncVisibleRows$ = command(({ get, set }): void => {
    const drafts = get(rowDrafts$);
    const previousRows = get(internalVisibleRows$);
    const previousModels = previousRows.map((row) => {
      return get(row.internalModel$);
    });
    const previousEvents = rowEventsById(previousModels);
    // Every draft shares the window's divider and model-change maps.
    const firstDraft = drafts[0]?.model;
    const dateDividers =
      firstDraft === undefined
        ? undefined
        : reconcileMap(
            previousModels[0]?.dateDividers,
            firstDraft.dateDividers,
            sameFields,
          );
    const modelChanges =
      firstDraft === undefined
        ? undefined
        : reconcileMap(
            previousModels[0]?.modelChanges,
            firstDraft.modelChanges,
            sameRunModelChange,
          );
    const rowsByKey = get(internalRowsByKey$);
    let nextRowsByKey: Map<string, ChatThreadRow> | undefined;
    const rows = drafts.map(({ key, model }) => {
      const draft: ChatThreadRowModel = {
        ...model,
        dateDividers: dateDividers ?? model.dateDividers,
        modelChanges: modelChanges ?? model.modelChanges,
      };
      const existing = rowsByKey.get(key);
      if (existing !== undefined) {
        const current = get(existing.internalModel$);
        const next = reconcileRowModel(current, draft, previousEvents);
        if (next !== current) {
          set(existing.internalModel$, next);
        }
        return existing;
      }
      const row = createChatThreadRow(
        reconcileRowModel(undefined, draft, previousEvents),
        scrollTargetEventId$,
      );
      nextRowsByKey ??= new Map(rowsByKey);
      nextRowsByKey.set(key, row);
      return row;
    });
    if (nextRowsByKey) {
      set(internalRowsByKey$, nextRowsByKey);
    }
    if (!equalArrays(previousRows, rows)) {
      set(internalVisibleRows$, rows);
    }
  });

  return { visibleRows$, syncVisibleRows$ };
}
