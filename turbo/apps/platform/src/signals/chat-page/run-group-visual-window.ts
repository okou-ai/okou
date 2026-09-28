import type { ChatEventGroup } from "./chat-event.ts";

interface RunSegment {
  readonly runId: string;
  runGroupId: string | undefined;
  readonly startGroupIndex: number;
  endGroupIndex: number;
}

interface LooseSegment {
  readonly runId: undefined;
  readonly runGroupId: undefined;
  readonly startGroupIndex: number;
  endGroupIndex: number;
}

type EventSegment = RunSegment | LooseSegment;

type GroupedRunSegment = RunSegment & { runGroupId: string };

function eventSegmentsFromGroups(
  groups: readonly ChatEventGroup[],
): EventSegment[] {
  const segments: EventSegment[] = [];

  for (const [groupIndex, group] of groups.entries()) {
    for (const event of group.events) {
      const runId = event.runId;
      if (runId === undefined) {
        segments.push({
          runId: undefined,
          runGroupId: undefined,
          startGroupIndex: groupIndex,
          endGroupIndex: groupIndex + 1,
        });
        continue;
      }

      const last = segments[segments.length - 1];
      if (last?.runId === runId) {
        last.endGroupIndex = groupIndex + 1;
        if (last.runGroupId === undefined) {
          last.runGroupId = event.runGroupId;
        }
        continue;
      }

      segments.push({
        runId,
        runGroupId: event.runGroupId,
        startGroupIndex: groupIndex,
        endGroupIndex: groupIndex + 1,
      });
    }
  }

  return segments;
}

function isGroupedRunSegment(
  segment: EventSegment | undefined,
): segment is GroupedRunSegment {
  return segment?.runId !== undefined && segment.runGroupId !== undefined;
}

function runGroupStreakEndIndex(
  segments: readonly EventSegment[],
  startIndex: number,
  runGroupId: string,
): number {
  let endIndex = startIndex + 1;
  while (
    endIndex < segments.length &&
    isGroupedRunSegment(segments[endIndex]) &&
    segments[endIndex].runGroupId === runGroupId
  ) {
    endIndex++;
  }
  return endIndex;
}

interface RunGroupVisualWindowItem {
  readonly startGroupIndex: number;
  readonly endGroupIndex: number;
}

function appendIndividualGroupWindowItems(
  groups: readonly ChatEventGroup[],
  items: RunGroupVisualWindowItem[],
  startGroupIndex: number,
  endGroupIndex: number,
  coveredGroupIndex: number,
): number {
  const start = Math.max(startGroupIndex, coveredGroupIndex);
  for (let groupIndex = start; groupIndex < endGroupIndex; groupIndex++) {
    const previous = items.at(-1);
    // A turn without events (the pending assistant turn) takes no window
    // slot of its own; it stays with the turn before it.
    if (groups[groupIndex]?.events.length === 0 && previous !== undefined) {
      items[items.length - 1] = {
        startGroupIndex: previous.startGroupIndex,
        endGroupIndex: groupIndex + 1,
      };
      continue;
    }
    items.push({
      startGroupIndex: groupIndex,
      endGroupIndex: groupIndex + 1,
    });
  }
  return Math.max(coveredGroupIndex, endGroupIndex);
}

function runGroupVisualWindowItems(
  groups: readonly ChatEventGroup[],
): RunGroupVisualWindowItem[] {
  const segments = eventSegmentsFromGroups(groups);
  const items: RunGroupVisualWindowItem[] = [];
  let coveredGroupIndex = 0;

  for (let index = 0; index < segments.length; ) {
    const segment = segments[index]!;
    if (segment.endGroupIndex <= coveredGroupIndex) {
      index++;
      continue;
    }

    if (coveredGroupIndex < segment.startGroupIndex) {
      coveredGroupIndex = appendIndividualGroupWindowItems(
        groups,
        items,
        coveredGroupIndex,
        segment.startGroupIndex,
        coveredGroupIndex,
      );
    }

    if (isGroupedRunSegment(segment)) {
      const endIndex = runGroupStreakEndIndex(
        segments,
        index,
        segment.runGroupId,
      );
      if (endIndex - index >= 2) {
        const finalSegment = segments[endIndex - 1]!;
        const startGroupIndex = Math.max(
          segment.startGroupIndex,
          coveredGroupIndex,
        );
        if (startGroupIndex < finalSegment.endGroupIndex) {
          items.push({
            startGroupIndex,
            endGroupIndex: finalSegment.endGroupIndex,
          });
          coveredGroupIndex = finalSegment.endGroupIndex;
        }
        index = endIndex;
        continue;
      }
    }

    coveredGroupIndex = appendIndividualGroupWindowItems(
      groups,
      items,
      segment.startGroupIndex,
      segment.endGroupIndex,
      coveredGroupIndex,
    );
    index++;
  }

  appendIndividualGroupWindowItems(
    groups,
    items,
    coveredGroupIndex,
    groups.length,
    coveredGroupIndex,
  );
  return items;
}

function visualWindowItemIndexForGroupIndex(
  items: readonly RunGroupVisualWindowItem[],
  groupIndex: number,
): number {
  return items.findIndex((item) => {
    return (
      groupIndex >= item.startGroupIndex && groupIndex < item.endGroupIndex
    );
  });
}

function trailingRunGroupVisualWindowStartIndex(
  items: readonly RunGroupVisualWindowItem[],
  visibleItemCount: number,
): number {
  if (items.length === 0) {
    return 0;
  }
  const startItemIndex = Math.max(0, items.length - visibleItemCount);
  return items[startItemIndex]?.startGroupIndex ?? 0;
}

export function runGroupVisualWindowStartIndex(
  groups: readonly ChatEventGroup[],
  cursorGroupId: string | null,
  visibleItemCount: number,
): number {
  if (groups.length === 0) {
    return 0;
  }
  if (visibleItemCount <= 0) {
    return groups.length;
  }

  const items = runGroupVisualWindowItems(groups);
  if (cursorGroupId === null) {
    return trailingRunGroupVisualWindowStartIndex(items, visibleItemCount);
  }

  const cursorGroupIndex = groups.findIndex((group) => {
    return group.beginEventId === cursorGroupId;
  });
  if (cursorGroupIndex === -1) {
    return trailingRunGroupVisualWindowStartIndex(items, visibleItemCount);
  }

  const cursorItemIndex = visualWindowItemIndexForGroupIndex(
    items,
    cursorGroupIndex,
  );
  return cursorItemIndex === -1
    ? trailingRunGroupVisualWindowStartIndex(items, visibleItemCount)
    : (items[cursorItemIndex]?.startGroupIndex ?? 0);
}

export function previousRunGroupVisualWindowStartIndex(
  groups: readonly ChatEventGroup[],
  currentStartGroupIndex: number,
  visibleItemCount: number,
): number {
  if (groups.length === 0) {
    return 0;
  }
  if (visibleItemCount <= 0) {
    return currentStartGroupIndex;
  }

  const items = runGroupVisualWindowItems(groups);
  const currentItemIndex = visualWindowItemIndexForGroupIndex(
    items,
    currentStartGroupIndex,
  );
  const normalizedCurrentItemIndex =
    currentItemIndex === -1
      ? Math.max(0, items.length - visibleItemCount)
      : currentItemIndex;
  const previousItemIndex = Math.max(
    0,
    normalizedCurrentItemIndex - visibleItemCount,
  );
  return items[previousItemIndex]?.startGroupIndex ?? 0;
}
