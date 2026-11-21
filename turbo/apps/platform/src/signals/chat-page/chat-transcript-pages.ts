import type { ChatThreadRowSignals } from "./chat-thread-rows.ts";
import { command, computed, state, type Computed, type State } from "ccstate";
import { onRef } from "../utils.ts";
import type { ChatEventGroup } from "./chat-event.ts";
import { isRenderableAssistantEvent } from "./chat-event-display.ts";
import type { ThreadScrollPosition } from "./chat-thread-scroll.ts";

// Measure whole stretches of natural-flow rows, including their gaps and folded
// work. An event can have no DOM of its own. Keep each run in a single page.
const GROUPS_PER_PAGE = 8;
const MIN_VIRTUAL_GROUPS = 40;
const ESTIMATED_GROUP_HEIGHT = 144;

interface TranscriptPage {
  readonly key: string;
  readonly start: number;
  readonly end: number;
}

function transcriptPages(groups: readonly ChatEventGroup[]) {
  const pages: TranscriptPage[] = [];
  const pageByEvent = new Map<string, number>();
  let start = 0;
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!;
    const first = group.events[0];
    if (
      i - start >= GROUPS_PER_PAGE &&
      (group.role === "user" || groups[i - 1]?.role === "assistant") &&
      first &&
      !first.isQueued &&
      !(
        first.runId &&
        groups[i - 1]!.events.some((event) => {
          return event.runId === first.runId;
        })
      )
    ) {
      pages.push({ key: groups[start]!.beginEventId, start, end: i });
      start = i;
    }
    pageByEvent.set(group.beginEventId, pages.length);
    for (const event of group.events) {
      pageByEvent.set(event.id, pages.length);
    }
  }
  pages.push({ key: groups[start]!.beginEventId, start, end: groups.length });
  return { pages, pageByEvent, groups };
}

function createPageMeasurements() {
  const sizes$ = state({ width: 0, heights: new Map<string, number>() });
  const container$ = state<HTMLElement | null>(null);
  const containerOnRef$ = onRef(
    command(({ get, set }, element: HTMLElement, signal: AbortSignal) => {
      set(container$, element);
      signal.addEventListener(
        "abort",
        () => {
          if (get(container$) === element) {
            set(container$, null);
          }
        },
        { once: true },
      );
    }),
  );
  // While mounted, pages occupy their actual height in normal flow. A cached
  // measurement is only needed when we exchange them for an offscreen spacer.
  const measureOutgoingPages$ = command(({ get, set }) => {
    const container = get(container$);
    if (
      !container ||
      !container.closest<HTMLElement>("[data-scroll-container]")?.clientHeight
    ) {
      return;
    }
    const width = container.getBoundingClientRect().width;
    if (!width) {
      return;
    }
    const old = get(sizes$);
    const heights = new Map(old.width === width ? old.heights : []);
    for (const page of container.querySelectorAll<HTMLElement>(
      "[data-transcript-page]",
    )) {
      heights.set(
        page.dataset.transcriptPage!,
        page.getBoundingClientRect().height,
      );
    }
    set(sizes$, { width, heights });
  });
  return { sizes$, container$, containerOnRef$, measureOutgoingPages$ };
}

function positionAtOffset(
  index: ReturnType<typeof transcriptPages>,
  offsets: readonly number[],
  offset: number,
): ThreadScrollPosition | null {
  const pageIndex =
    offsets.findIndex((end) => {
      return end > offset;
    }) - 1;
  const page = index.pages[pageIndex];
  if (!page) {
    return null;
  }
  const fraction =
    (offset - offsets[pageIndex]!) /
    (offsets[pageIndex + 1]! - offsets[pageIndex]!);
  const approximate = Math.min(
    page.end - 1,
    page.start + Math.floor(fraction * (page.end - page.start)),
  );
  const groups = index.groups;
  for (let i = approximate; i >= page.start; i--) {
    const group = groups[i]!;
    const anchor =
      group.role === "user"
        ? group.events.find((event) => {
            return !event.isQueued;
          })
        : group.events.find(isRenderableAssistantEvent);
    if (anchor) {
      return { targetEventId: anchor.id, viewportOffsetTop: 0 };
    }
  }
  return {
    targetEventId: groups[page.start]!.beginEventId,
    viewportOffsetTop: 0,
  };
}

interface PageCoverage {
  readonly center: string;
  readonly before: number;
  readonly after: number;
}

export function visibleTranscriptSpacer(
  viewport: HTMLElement,
): "before" | "after" | null {
  const bounds = viewport.getBoundingClientRect();
  for (const spacer of viewport.querySelectorAll<HTMLElement>(
    "[data-transcript-spacer]",
  )) {
    const rect = spacer.getBoundingClientRect();
    if (
      rect.height > 0 &&
      rect.top < bounds.bottom - 1 &&
      rect.bottom > bounds.top + 1
    ) {
      return spacer.dataset.transcriptSpacer === "before" ? "before" : "after";
    }
  }
  return null;
}

function pageRange(
  index: ReturnType<typeof transcriptPages> | null,
  target: ThreadScrollPosition | null,
  coverage: PageCoverage | null,
) {
  if (!index) {
    return null;
  }
  const { pages, pageByEvent } = index;

  const center =
    (target && pageByEvent.get(target.targetEventId)) ?? pages.length - 1;
  const key = pages[center]!.key;
  const extra = coverage?.center === key ? coverage : null;
  const first = Math.max(0, center - 1 - (extra?.before ?? 0));
  const last = Math.min(pages.length - 1, center + 1 + (extra?.after ?? 0));
  return {
    center: key,
    first,
    last,
    start: pages[first]!.start,
    end: pages[last]!.end,
  };
}

function offsetInsideSpacer(
  spacer: HTMLElement,
  viewportTop: number,
  viewportHeight: number,
): number | null {
  const rect = spacer.getBoundingClientRect();
  if (!rect.height || viewportTop >= rect.bottom) {
    return null;
  }
  if (
    viewportTop < rect.top &&
    (spacer.dataset.transcriptSpacer !== "before" ||
      rect.top >= viewportTop + viewportHeight)
  ) {
    return null;
  }
  return Math.max(0, viewportTop - rect.top);
}

interface MountedTranscript {
  index: ReturnType<typeof transcriptPages>;
  first: number;
  last: number;
  rows: ChatThreadRowSignals[][];
}

function createPageGeometry(
  mounted$: State<MountedTranscript | null>,
  sizes$: ReturnType<typeof createPageMeasurements>["sizes$"],
) {
  const offsets$ = computed((get) => {
    const offsets = [0];
    const sizes = get(sizes$);
    for (const page of get(mounted$)?.index.pages ?? []) {
      const size =
        sizes.heights.get(page.key) ??
        (page.end - page.start) * ESTIMATED_GROUP_HEIGHT;
      offsets.push(offsets[offsets.length - 1]! + size);
    }
    return offsets;
  });
  const layout$ = computed((get) => {
    const range = get(mounted$);
    if (!range) {
      return null;
    }
    const index = range.index;
    const offsets = get(offsets$);
    return {
      pages: index.pages.slice(range.first, range.last + 1),
      rows: range.rows,
      first: range.first,
      before: offsets[range.first]!,
      after: offsets[index.pages.length]! - offsets[range.last + 1]!,
    };
  });
  // Ordinary scrolling captures a mounted event. A thumb drag can land
  // entirely inside a spacer; use its estimated coordinate to open a page
  // directly without walking or preparing the intervening history.
  const positionInSpacer$ = command(
    ({ get }, viewport: HTMLElement): ThreadScrollPosition | null => {
      const layout = get(layout$);
      if (!layout || !viewport.clientHeight) {
        return null;
      }
      const top = viewport.getBoundingClientRect().top;
      for (const spacer of viewport.querySelectorAll<HTMLElement>(
        "[data-transcript-spacer]",
      )) {
        const localOffset = offsetInsideSpacer(
          spacer,
          top,
          viewport.clientHeight,
        );
        if (localOffset === null) {
          continue;
        }
        const offsets = get(offsets$);
        const index = get(mounted$)!.index;
        const start =
          spacer.dataset.transcriptSpacer === "before"
            ? 0
            : layout.first + layout.pages.length;
        const offset = offsets[start]! + localOffset;
        return positionAtOffset(index, offsets, offset);
      }
      return null;
    },
  );
  return { layout$, positionInSpacer$ };
}

export function createTranscriptPages(
  groups$: Computed<ChatEventGroup[]>,
  position$: Computed<ThreadScrollPosition | null>,
) {
  const index$ = computed((get) => {
    const groups = get(groups$);
    return groups.length < MIN_VIRTUAL_GROUPS ? null : transcriptPages(groups);
  });
  const coverage$ = state<PageCoverage | null>(null);
  const range$ = computed((get) => {
    return pageRange(get(index$), get(position$), get(coverage$));
  });
  // A range can change before its markdown is ready. Publish the row
  // assignment and its two spacers together, after reconciling the new rows.
  const mounted$ = state<MountedTranscript | null>(null);
  const { sizes$, container$, containerOnRef$, measureOutgoingPages$ } =
    createPageMeasurements();
  const fillViewport$ = command(({ get, set }) => {
    const viewport = get(container$)?.closest<HTMLElement>(
      "[data-scroll-container]",
    );
    const range = get(range$);
    const side = viewport && visibleTranscriptSpacer(viewport);
    if (!range || !side) {
      return false;
    }
    if (
      side === "before" ? range.start === 0 : range.end === get(groups$).length
    ) {
      return false;
    }
    const prior = get(coverage$);
    const coverage =
      prior?.center === range.center
        ? prior
        : { center: range.center, before: 0, after: 0 };
    set(coverage$, { ...coverage, [side]: coverage[side] + 1 });
    return true;
  });
  const commitRows$ = command(
    ({ get, set }, rows: readonly ChatThreadRowSignals[]) => {
      const index = get(index$);
      const range = get(range$);
      if (!index || !range) {
        set(mounted$, null);
        return;
      }
      const previous = get(mounted$);
      if (
        previous &&
        (range.first !== previous.first || range.last !== previous.last)
      ) {
        set(measureOutgoingPages$);
      }
      const pages = index.pages
        .slice(range.first, range.last + 1)
        .map((): ChatThreadRowSignals[] => {
          return [];
        });
      for (const row of rows) {
        const page = index.pageByEvent.get(get(row.model$).group.beginEventId);
        if (page !== undefined) {
          pages[page - range.first]!.push(row);
        }
      }
      set(mounted$, {
        index,
        first: range.first,
        last: range.last,
        rows: pages,
      });
    },
  );
  const tailMounted$ = computed((get) => {
    const mounted = get(mounted$);
    return !mounted || mounted.last === mounted.index.pages.length - 1;
  });
  const awaitingAnchor$ = computed((get) => {
    const target = get(position$);
    const index = get(index$);
    if (!target || !index) {
      return false;
    }
    const mounted = get(mounted$);
    const page = index.pageByEvent.get(target.targetEventId);
    return (
      page !== undefined &&
      (!mounted ||
        mounted.index !== index ||
        page < mounted.first ||
        page > mounted.last)
    );
  });
  const rangePrepared$ = computed((get) => {
    const mounted = get(mounted$);
    const range = get(range$);
    return (
      !!mounted &&
      !!range &&
      mounted.index === get(index$) &&
      mounted.first === range.first &&
      mounted.last === range.last
    );
  });
  const { layout$, positionInSpacer$ } = createPageGeometry(mounted$, sizes$);
  return {
    range$,
    rangePrepared$,
    awaitingAnchor$,
    tailMounted$,
    fillViewport$,
    layout$,
    containerOnRef$,
    positionInSpacer$,
    commitRows$,
  };
}

export type TranscriptPages = ReturnType<typeof createTranscriptPages>;
