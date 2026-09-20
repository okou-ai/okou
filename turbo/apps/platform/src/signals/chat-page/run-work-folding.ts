import { command, computed, state } from "ccstate";
import type { ChatEventUsagePayload } from "@okouai/api-contracts/contracts/chat-threads";
import type { Element, Root } from "hast";
import {
  chatEventCompatibilityRole,
  foldLatestChatUsageByRunId,
  isChatEventContentTextType,
  isChatInputEventType,
  isChatRunTerminalEventType,
} from "@okouai/api-contracts/contracts/chat-events";
import { hasChatEventBodyContent } from "./chat-event-body-blocks.ts";
import type { ChatEventGroup, EnrichedChatEvent } from "./chat-event.ts";
import { isGoalContinuationInput, type ChatEvent } from "./chat-event-types.ts";
import { mergeChatEventUsagePayloads } from "./chat-event-usage.ts";
import { isCancelledRunEvent } from "./chat-run-lifecycle.ts";
import type { MarkdownCardRef } from "./markdown-card-ref.ts";

const internalRunWorkExpandedKeys$ = state<Set<string>>(new Set());

export const runWorkExpandedKeys$ = computed((get): Set<string> => {
  return get(internalRunWorkExpandedKeys$);
});

export const toggleRunWorkExpanded$ = command(({ set }, key: string) => {
  set(internalRunWorkExpandedKeys$, (prev) => {
    const next = new Set(prev);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    return next;
  });
});

export interface RunWorkSection {
  readonly key: string;
  readonly runGroupId: string | undefined;
  readonly runIds: readonly string[];
  readonly anchorEventId: string;
  readonly collapsible: boolean;
  readonly stepCount: number;
  readonly hiddenGroups: ChatEventGroup[];
  readonly hiddenGroupsAfterAnchor: ChatEventGroup[];
  readonly remainingArtifactCards: readonly RunWorkArtifactCard[];
  readonly startTime: number;
  readonly endTime?: number;
}

type RunWorkArtifactCard = Extract<
  MarkdownCardRef,
  { readonly kind: "artifact" }
> & { readonly label?: string; readonly tree: Root };

export interface RunWorkFolding {
  readonly visibleGroups: ChatEventGroup[];
  readonly sectionsByAnchorEventId: Map<string, RunWorkSection>;
  readonly statusTail: RunWorkStatusTail | null;
}

interface RunWorkStatusTail {
  readonly anchorEventId: string | undefined;
  readonly events: readonly EnrichedChatEvent[];
}

function chatEventDisplayError(event: ChatEvent): string | undefined {
  if (
    event.eventType === "input.rejected" ||
    event.eventType === "output.error" ||
    event.eventType === "run.failed" ||
    event.eventType === "run.cancelled"
  ) {
    return event.error;
  }
  return undefined;
}

function chatEventHasAttachments(event: EnrichedChatEvent): boolean {
  return (
    "userMessage" in event &&
    (event.userMessage?.parts.some((part) => {
      return part.type === "file";
    }) ??
      false)
  );
}

function isRenderableAssistantEvent(event: EnrichedChatEvent): boolean {
  return (
    chatEventCompatibilityRole(event.eventType) === "assistant" &&
    ((isChatEventContentTextType(event.eventType) && Boolean(event.content)) ||
      Boolean(chatEventDisplayError(event)) ||
      hasChatEventBodyContent(event) ||
      chatEventHasAttachments(event))
  );
}

function isRunWorkAssistantOutput(event: EnrichedChatEvent): boolean {
  return (
    event.eventType !== "run.queued" &&
    !isCancelledRunEvent(event) &&
    isRenderableAssistantEvent(event)
  );
}

function isRunWorkMessage(event: EnrichedChatEvent): boolean {
  return event.eventType === "output.message";
}

function artifactNodeText(node: Element): string {
  return node.children
    .map((child) => {
      if (child.type === "text") {
        return child.value;
      }
      return child.type === "element" ? artifactNodeText(child) : "";
    })
    .join("");
}

function artifactNodeLabel(node: Element): string | undefined {
  const label =
    node.tagName === "img" && typeof node.properties.alt === "string"
      ? node.properties.alt
      : artifactNodeText(node);
  const normalized = label.trim().replace(/\s+/g, " ");
  return normalized || undefined;
}

function artifactCardsInTree(
  tree: Root | undefined,
): readonly RunWorkArtifactCard[] {
  if (tree === undefined) {
    return [];
  }
  const cards: RunWorkArtifactCard[] = [];
  const visit = (node: Root | Element): void => {
    if (node.type === "element" && node.data?.card?.kind === "artifact") {
      const label = artifactNodeLabel(node);
      cards.push({
        ...node.data.card,
        ...(label === undefined ? {} : { label }),
        tree: { type: "root", children: [node] },
      });
      return;
    }
    for (const child of node.children) {
      if (child.type === "element") {
        visit(child);
      }
    }
  };
  visit(tree);
  return cards;
}

function remainingArtifactCards(
  outputMessages: readonly EnrichedChatEvent[],
): readonly RunWorkArtifactCard[] {
  const finalUrls = new Set(
    artifactCardsInTree(outputMessages.at(-1)?.tree).map((card) => {
      return card.signals.url;
    }),
  );
  const seenUrls = new Set<string>();
  const remaining: RunWorkArtifactCard[] = [];
  for (const message of outputMessages) {
    for (const card of artifactCardsInTree(message.tree)) {
      const { url } = card.signals;
      if (seenUrls.has(url)) {
        continue;
      }
      seenUrls.add(url);
      if (!finalUrls.has(url)) {
        remaining.push(card);
      }
    }
  }
  return remaining;
}

export function runWorkSectionForGroup(
  runWorkFolding: RunWorkFolding | null,
  group: ChatEventGroup,
): RunWorkSection | null {
  if (runWorkFolding === null) {
    return null;
  }
  return (
    group.events
      .map((event) => {
        return runWorkFolding.sectionsByAnchorEventId.get(event.id);
      })
      .find((section) => {
        return section !== undefined;
      }) ?? null
  );
}

export function runWorkExpandedKeysForScrollTarget(
  folding: RunWorkFolding | null,
  expandedKeys: ReadonlySet<string>,
  targetEventId: string | null,
): ReadonlySet<string> {
  if (folding === null || targetEventId === null) {
    return expandedKeys;
  }
  const targetSection = Array.from(
    folding.sectionsByAnchorEventId.values(),
  ).find((section) => {
    return [...section.hiddenGroups, ...section.hiddenGroupsAfterAnchor].some(
      (group) => {
        return group.events.some((event) => {
          return event.id === targetEventId;
        });
      },
    );
  });
  if (!targetSection || expandedKeys.has(targetSection.key)) {
    return expandedKeys;
  }
  const next = new Set(expandedKeys);
  next.add(targetSection.key);
  return next;
}

function groupEventsByRole(
  events: readonly EnrichedChatEvent[],
): ChatEventGroup[] {
  const groups: ChatEventGroup[] = [];
  for (const event of events) {
    const role = chatEventCompatibilityRole(event.eventType);
    const last = groups[groups.length - 1];
    if (last && last.role === role) {
      last.events.push(event);
      continue;
    }
    groups.push({
      beginEventId: event.id,
      role,
      events: [event],
    });
  }
  return groups;
}

function groupEventsForRunWorkDisplay(
  events: readonly EnrichedChatEvent[],
  workAnchorEventIds: ReadonlySet<string>,
): ChatEventGroup[] {
  const groups: ChatEventGroup[] = [];
  for (const event of events) {
    const role = chatEventCompatibilityRole(event.eventType);
    const forceStandalone = workAnchorEventIds.has(event.id);
    const last = groups[groups.length - 1];

    if (!forceStandalone && last && last.role === role) {
      last.events.push(event);
      continue;
    }

    groups.push({
      beginEventId: event.id,
      role,
      events: [event],
    });
  }
  return groups;
}

function firstRunIdForEvents(
  events: readonly EnrichedChatEvent[],
): string | undefined {
  return events.find((event) => {
    return event.runId !== undefined;
  })?.runId;
}

function usageByRunIdFromGroups(
  groups: readonly ChatEventGroup[],
): Map<string, ChatEventUsagePayload> {
  return foldLatestChatUsageByRunId(
    groups.flatMap((group) => {
      const runId = firstRunIdForEvents(group.events);
      return group.role === "assistant" &&
        group.usage !== undefined &&
        runId !== undefined
        ? [
            {
              eventType: "usage.recorded" as const,
              runId,
              usage: group.usage,
            },
          ]
        : [];
    }),
  );
}

function attachUsageToRunWorkGroups(
  groups: readonly ChatEventGroup[],
  usageByRunId: ReadonlyMap<string, ChatEventUsagePayload>,
  usageByAnchorEventId: ReadonlyMap<string, ChatEventUsagePayload>,
  workAnchorEventIds: ReadonlySet<string>,
): ChatEventGroup[] {
  const lastAssistantGroupIndexByRunId = new Map<string, number>();
  for (const [index, group] of groups.entries()) {
    if (
      group.role !== "assistant" ||
      (!group.events.some(isRenderableAssistantEvent) &&
        !group.events.some((event) => {
          return workAnchorEventIds.has(event.id);
        }))
    ) {
      continue;
    }
    const runId = firstRunIdForEvents(group.events);
    if (runId !== undefined) {
      lastAssistantGroupIndexByRunId.set(runId, index);
    }
  }
  return groups.map((group, index) => {
    if (group.role !== "assistant") {
      return group;
    }
    const anchorUsage = group.events
      .map((event) => {
        return usageByAnchorEventId.get(event.id);
      })
      .find((usage) => {
        return usage !== undefined;
      });
    if (anchorUsage !== undefined) {
      return { ...group, usage: anchorUsage };
    }
    const runId = firstRunIdForEvents(group.events);
    if (
      runId === undefined ||
      lastAssistantGroupIndexByRunId.get(runId) !== index
    ) {
      return group;
    }
    const usage = usageByRunId.get(runId);
    return usage === undefined ? group : { ...group, usage };
  });
}

interface RunWorkEventSegment {
  readonly runId: string | undefined;
  runGroupId: string | undefined;
  readonly events: EnrichedChatEvent[];
}

interface RunWorkUnit {
  readonly key: string | undefined;
  readonly runGroupId: string | undefined;
  readonly events: readonly EnrichedChatEvent[];
  readonly runIds: readonly string[];
  readonly hiddenUserEventIds: ReadonlySet<string>;
  readonly isGoal: boolean;
}

function runWorkEventSegments(
  events: readonly EnrichedChatEvent[],
): RunWorkEventSegment[] {
  const segments: RunWorkEventSegment[] = [];
  for (const event of events) {
    const runId =
      event.runId ??
      (event.eventType === "control.interrupt"
        ? event.interruptsRunId
        : undefined);
    const last = segments[segments.length - 1];
    if (runId !== undefined && last?.runId === runId) {
      last.events.push(event);
      if (last.runGroupId === undefined) {
        last.runGroupId = event.runGroupId;
      }
      continue;
    }
    segments.push({
      runId,
      runGroupId: event.runGroupId,
      events: [event],
    });
  }
  return segments;
}

function runGroupStreakEndIndex(
  segments: readonly RunWorkEventSegment[],
  startIndex: number,
  runGroupId: string,
): number {
  let endIndex = startIndex + 1;
  while (
    endIndex < segments.length &&
    segments[endIndex]?.runGroupId === runGroupId
  ) {
    endIndex++;
  }
  return endIndex;
}

function uniqueRunIds(segments: readonly RunWorkEventSegment[]): string[] {
  return Array.from(
    new Set(
      segments.flatMap((segment) => {
        return segment.runId === undefined ? [] : [segment.runId];
      }),
    ),
  );
}

function standaloneRunWorkUnit(segment: RunWorkEventSegment): RunWorkUnit {
  return {
    key: segment.runId,
    runGroupId: segment.runGroupId,
    events: segment.events,
    runIds: segment.runId === undefined ? [] : [segment.runId],
    hiddenUserEventIds: new Set(),
    isGoal: false,
  };
}

function isRunGroupInternalInput(event: EnrichedChatEvent): boolean {
  return (
    event.eventType === "input.automation" || isGoalContinuationInput(event)
  );
}

function canAnchorGoalRun(unit: RunWorkUnit | undefined): boolean {
  return (
    unit !== undefined &&
    unit.runIds.length > 0 &&
    !unit.isGoal &&
    unit.runGroupId === undefined
  );
}

function runWorkUnits(events: readonly EnrichedChatEvent[]): RunWorkUnit[] {
  const segments = runWorkEventSegments(events);
  const units: RunWorkUnit[] = [];

  for (let index = 0; index < segments.length; ) {
    const segment = segments[index]!;
    if (segment.runGroupId === undefined) {
      units.push(standaloneRunWorkUnit(segment));
      index++;
      continue;
    }

    const endIndex = runGroupStreakEndIndex(
      segments,
      index,
      segment.runGroupId,
    );
    const streak = segments.slice(index, endIndex);
    const goalInputEvents = streak.flatMap((item) => {
      return item.events.filter(isGoalContinuationInput);
    });
    if (goalInputEvents.length === 0) {
      const events = streak.flatMap((item) => {
        return item.events;
      });
      units.push({
        key: `group:${segment.runGroupId}`,
        runGroupId: segment.runGroupId,
        events,
        runIds: uniqueRunIds(streak),
        hiddenUserEventIds: new Set(
          events.filter(isRunGroupInternalInput).map((event) => {
            return event.id;
          }),
        ),
        isGoal: false,
      });
      index = endIndex;
      continue;
    }

    // Historical goal continuations are synthetic user turns. Attach their
    // contiguous streak to the nearest preceding ungrouped run; an intervening
    // run then naturally starts a new visual work section after an
    // interruption.
    const previousUnit = units[units.length - 1];
    const anchorUnit = canAnchorGoalRun(previousUnit) ? units.pop() : undefined;
    const groupedEvents = streak.flatMap((item) => {
      return item.events;
    });
    const hiddenUserEventIds = new Set(
      groupedEvents.filter(isRunGroupInternalInput).map((event) => {
        return event.id;
      }),
    );
    // A render window can begin inside a goal streak. Keep one context row when
    // its triggering run is outside the window instead of orphaning the work.
    if (anchorUnit === undefined) {
      hiddenUserEventIds.delete(goalInputEvents[0]!.id);
    }
    const goalRunIds = uniqueRunIds(streak);
    units.push({
      key: `goal:${segment.runGroupId}`,
      runGroupId: segment.runGroupId,
      events: [...(anchorUnit?.events ?? []), ...groupedEvents],
      runIds: [...(anchorUnit?.runIds ?? []), ...goalRunIds],
      hiddenUserEventIds,
      isGoal: true,
    });
    index = endIndex;
  }

  return units;
}

function visibleRunWorkUserEvent(
  event: EnrichedChatEvent,
  hiddenUserEventIds: ReadonlySet<string>,
): boolean {
  return (
    isChatInputEventType(event.eventType) && !hiddenUserEventIds.has(event.id)
  );
}

function splitRunWorkEventsAtUsers(
  events: readonly EnrichedChatEvent[],
  hiddenUserEventIds: ReadonlySet<string>,
): EnrichedChatEvent[][] {
  const phases: EnrichedChatEvent[][] = [];
  let phase: EnrichedChatEvent[] = [];
  for (const event of events) {
    if (
      phase.length > 0 &&
      visibleRunWorkUserEvent(event, hiddenUserEventIds)
    ) {
      phases.push(phase);
      phase = [];
    }
    phase.push(event);
  }
  if (phase.length > 0) {
    phases.push(phase);
  }
  return phases;
}

function eventTime(event: EnrichedChatEvent | undefined): number | null {
  if (event === undefined) {
    return null;
  }
  const timestamp = Date.parse(event.inputCreatedAt ?? event.createdAt);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function firstEventTime(events: readonly EnrichedChatEvent[]): number | null {
  for (const event of events) {
    const timestamp = eventTime(event);
    if (timestamp !== null) {
      return timestamp;
    }
  }
  return null;
}

function lastEventMatching(
  events: readonly EnrichedChatEvent[],
  predicate: (event: EnrichedChatEvent) => boolean,
): EnrichedChatEvent | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (predicate(event)) {
      return event;
    }
  }
  return undefined;
}

interface RunWorkGroupFolding {
  readonly visibleEvents: readonly EnrichedChatEvent[];
  readonly section: RunWorkSection | null;
  readonly statusTail: RunWorkStatusTail;
}

// A work group is bounded by visible user inputs, independently of execution:
// one run can span several groups, and historical goal continuations can span
// several runs.
interface RunWorkGroup {
  readonly unit: RunWorkUnit;
  readonly events: readonly EnrichedChatEvent[];
  readonly endTime: number | undefined;
}

function foldRunWorkGroup(
  group: RunWorkGroup,
  foldedEventIds: ReadonlySet<string>,
): RunWorkGroupFolding {
  const { unit, events, endTime } = group;
  const { hiddenUserEventIds } = unit;
  const outputMessages = events.filter(isRunWorkMessage);
  const anchorEvent = outputMessages.at(-1);
  const anchorIndex =
    anchorEvent === undefined ? -1 : events.indexOf(anchorEvent);
  const latestRunId = latestRunIdForEvents(events);
  const trailingStatusEvents = events.slice(anchorIndex + 1).filter((event) => {
    return (
      isRenderableAssistantEvent(event) && Boolean(chatEventDisplayError(event))
    );
  });
  const statusTail = {
    anchorEventId: anchorEvent?.id,
    events: trailingStatusEvents.filter((event) => {
      return event.runId === latestRunId;
    }),
  };
  const startTime = firstEventTime(events);
  if (
    unit.runIds.length === 0 ||
    anchorEvent === undefined ||
    startTime === null
  ) {
    return {
      visibleEvents: events.filter((event) => {
        return (
          !hiddenUserEventIds.has(event.id) &&
          !trailingStatusEvents.includes(event)
        );
      }),
      section: null,
      statusTail,
    };
  }
  const stepCount = outputMessages.length - 1;

  const hiddenEvents = events.slice(0, anchorIndex).filter((event) => {
    return (
      isRunWorkAssistantOutput(event) ||
      (hiddenUserEventIds.has(event.id) && foldedEventIds.has(event.id))
    );
  });
  const hiddenEventsAfterAnchor = events
    .slice(anchorIndex + 1)
    .filter((event) => {
      return hiddenUserEventIds.has(event.id) && foldedEventIds.has(event.id);
    });
  const userEvents = events.filter((event) => {
    return visibleRunWorkUserEvent(event, hiddenUserEventIds);
  });

  return {
    visibleEvents: [...userEvents, anchorEvent],
    statusTail,
    section: {
      key: `${unit.key ?? events[0]!.id}:${events[0]!.id}`,
      runGroupId: unit.runGroupId,
      runIds: unit.runIds,
      anchorEventId: anchorEvent.id,
      collapsible: stepCount > 0,
      stepCount,
      hiddenGroups: groupEventsByRole(hiddenEvents),
      hiddenGroupsAfterAnchor: groupEventsByRole(hiddenEventsAfterAnchor),
      remainingArtifactCards: remainingArtifactCards(outputMessages),
      startTime,
      ...(endTime === undefined ? {} : { endTime }),
    },
  };
}

function latestRunIdForEvents(
  events: readonly EnrichedChatEvent[],
): string | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const runId = events[index]?.runId;
    if (runId !== undefined) {
      return runId;
    }
  }
  return undefined;
}

function terminalEventForLatestRun(
  events: readonly EnrichedChatEvent[],
): EnrichedChatEvent | undefined {
  const latestRunId = latestRunIdForEvents(events);
  if (latestRunId === undefined) {
    return undefined;
  }
  return lastEventMatching(events, (event) => {
    return (
      event.runId === latestRunId && isChatRunTerminalEventType(event.eventType)
    );
  });
}

function mergedUsageForRunIds(
  runIds: readonly string[],
  usageByRunId: ReadonlyMap<string, ChatEventUsagePayload>,
): ChatEventUsagePayload | undefined {
  return mergeChatEventUsagePayloads(
    runIds.flatMap((runId) => {
      const usage = usageByRunId.get(runId);
      return usage === undefined ? [] : [usage];
    }),
  );
}

function runWorkGroups(events: readonly EnrichedChatEvent[]): RunWorkGroup[] {
  const groups = runWorkUnits(events).flatMap((unit) => {
    return splitRunWorkEventsAtUsers(unit.events, unit.hiddenUserEventIds).map(
      (events) => {
        return { unit, events };
      },
    );
  });
  const workGroups: RunWorkGroup[] = [];
  let nextInputTime: number | undefined;
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index]!;
    const terminalTime =
      eventTime(terminalEventForLatestRun(group.events)) ?? undefined;
    const endTime =
      terminalTime === undefined
        ? nextInputTime
        : nextInputTime === undefined
          ? terminalTime
          : Math.min(terminalTime, nextInputTime);
    workGroups.push({ ...group, endTime });

    const input = group.events.find((event) => {
      return visibleRunWorkUserEvent(event, group.unit.hiddenUserEventIds);
    });
    if (input !== undefined) {
      nextInputTime = eventTime(input) ?? undefined;
    }
  }
  return workGroups.reverse();
}

export function buildRunWorkFolding(
  groups: readonly ChatEventGroup[],
  foldedEventIds: ReadonlySet<string> = new Set(),
): RunWorkFolding {
  const usageByRunId = usageByRunIdFromGroups(groups);
  const events = groups.flatMap((group) => {
    return group.events;
  });
  const visibleEvents: EnrichedChatEvent[] = [];
  const sections: RunWorkSection[] = [];
  let statusTail: RunWorkStatusTail | null = null;
  const usageByAnchorEventId = new Map<string, ChatEventUsagePayload>();
  const finalSectionByUnit = new Map<RunWorkUnit, RunWorkSection>();

  for (const group of runWorkGroups(events)) {
    const folding = foldRunWorkGroup(group, foldedEventIds);
    visibleEvents.push(...folding.visibleEvents);
    // Work groups exist before their first output, so a pending input retires
    // the previous tail immediately. Bookkeeping alone does not start a group.
    if (
      group.events.some((event) => {
        return (
          isChatInputEventType(event.eventType) ||
          isRenderableAssistantEvent(event) ||
          event.eventType === "output.thinking"
        );
      })
    ) {
      statusTail = folding.statusTail;
    }
    if (folding.section !== null) {
      sections.push(folding.section);
      finalSectionByUnit.set(group.unit, folding.section);
    }
  }
  for (const [unit, finalSection] of finalSectionByUnit) {
    if (unit.runGroupId !== undefined) {
      const mergedUsage = mergedUsageForRunIds(unit.runIds, usageByRunId);
      if (mergedUsage !== undefined) {
        usageByAnchorEventId.set(finalSection.anchorEventId, mergedUsage);
      }
    }
  }

  // Historical errors stay in the source events; only the latest tail is rendered.
  visibleEvents.push(...(statusTail?.events ?? []));

  const workAnchorEventIds = new Set(
    sections.map((section) => {
      return section.anchorEventId;
    }),
  );
  return {
    statusTail,
    visibleGroups: attachUsageToRunWorkGroups(
      groupEventsForRunWorkDisplay(visibleEvents, workAnchorEventIds),
      usageByRunId,
      usageByAnchorEventId,
      workAnchorEventIds,
    ),
    sectionsByAnchorEventId: new Map(
      sections.map((section) => {
        return [section.anchorEventId, section];
      }),
    ),
  };
}
