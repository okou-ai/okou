import { command, computed, type Command, type Computed } from "ccstate";
import {
  currentEventImageArtifactNavigation,
  eventImageCandidates,
  type ImageArtifactNavigationItem,
  type ImageArtifactNavigation,
} from "../../views/okou-page/artifact-image-navigation.ts";
import {
  lightboxUrl$,
  navigateImageLightbox$,
} from "../okou-page/attachment-chips.ts";
import { pageSignal$ } from "../page-signal.ts";
import type { EventImageGroupProjection } from "./chat-panel-signals.ts";
import type { ThreadSidebarSignals } from "./thread-sidebar.ts";

export type EventImageNavigationDirection = "previous" | "next";

interface ImageSelection {
  readonly groupId?: string;
  readonly url: string;
}

export interface EventImageNavigationSignals {
  readonly neighbors$: Computed<Promise<ImageArtifactNavigation>>;
  readonly navigate$: Command<
    Promise<void>,
    [EventImageNavigationDirection, AbortSignal]
  >;
}

export interface ThreadImageNavigationSignals {
  readonly openGroupForImage$: Command<string | undefined, [string]>;
  readonly lightbox: EventImageNavigationSignals;
  readonly sidebar: EventImageNavigationSignals;
}

function createEventImageNavigation(
  groups$: Computed<readonly EventImageGroupProjection[]>,
  selection$: Computed<ImageSelection | null>,
  select$: Command<void, [ImageArtifactNavigationItem, string, boolean]>,
): EventImageNavigationSignals {
  const neighbors$ = computed(async (get): Promise<ImageArtifactNavigation> => {
    const selection = get(selection$);
    if (!selection?.groupId) {
      return {};
    }
    const group = get(groups$).find((candidate) => {
      return candidate.id === selection.groupId;
    });
    if (!group) {
      return {};
    }
    // Unclassified links use their own card read. Already typed images require no detail read.
    const candidates = await Promise.all(
      eventImageCandidates(group.events).map(async (item) => {
        const { descriptor$, ...image } = item;
        if (!descriptor$) {
          return image;
        }
        const descriptor = await get(descriptor$);
        return descriptor.kind === "image"
          ? {
              ...image,
              filename: descriptor.filename,
              contentType: descriptor.contentType,
            }
          : undefined;
      }),
    );
    const images = candidates.filter((item) => {
      return item !== undefined;
    });
    return currentEventImageArtifactNavigation(group, selection.url, images);
  });
  return {
    neighbors$,
    navigate$: command(
      async (
        { get, set },
        direction: EventImageNavigationDirection,
        signal: AbortSignal,
      ) => {
        const selection = get(selection$);
        const groupId = selection?.groupId;
        const neighbors = await get(neighbors$);
        signal.throwIfAborted();
        const item = neighbors[direction];
        if (groupId && item && get(selection$) === selection) {
          set(select$, item, groupId, neighbors.role !== "user");
        }
      },
    ),
  };
}

/** Each surface owns its current URL and group. Switching never enumerates thread artifacts. */
export function createThreadImageNavigationSignals(
  threadId: string,
  groups$: Computed<readonly EventImageGroupProjection[]>,
  sidebar: Pick<ThreadSidebarSignals, "target$" | "openAttachment$">,
): ThreadImageNavigationSignals {
  return {
    openGroupForImage$: command(({ get }, eventId) => {
      return get(groups$).find((group) => {
        return group.events.some((event) => {
          return event.id === eventId;
        });
      })?.id;
    }),
    lightbox: createEventImageNavigation(
      groups$,
      computed((get) => {
        const preview = get(lightboxUrl$);
        return preview?.kind === "image" && preview.threadId === threadId
          ? preview
          : null;
      }),
      command(({ set }, item, groupId, shareAvailable) => {
        set(navigateImageLightbox$, {
          ...item,
          groupId,
          threadId,
          shareAvailable,
        });
      }),
    ),
    sidebar: createEventImageNavigation(
      groups$,
      computed((get) => {
        const target = get(sidebar.target$);
        return target?.type === "artifact" &&
          target.source.kind === "attachment"
          ? target.source.ref
          : null;
      }),
      command(({ get, set }, item, groupId, shareAvailable) => {
        set(
          sidebar.openAttachment$,
          { ...item, groupId, shareAvailable },
          get(pageSignal$),
        );
      }),
    ),
  };
}
