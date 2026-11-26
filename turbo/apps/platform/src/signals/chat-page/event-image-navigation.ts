import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { messageArtifactKey } from "../../views/okou-page/attachment-url.ts";
import {
  currentEventImageArtifactNavigation,
  type ImageArtifactNavigationItem,
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
  readonly hasPrevious$: Computed<boolean>;
  readonly hasNext$: Computed<boolean>;
  readonly navigate$: Command<void, [EventImageNavigationDirection]>;
}

export interface ThreadImageNavigationSignals {
  readonly openGroupForImage$: Command<
    string | undefined,
    [string, ImageArtifactNavigationItem]
  >;
  readonly lightbox: EventImageNavigationSignals;
  readonly sidebar: EventImageNavigationSignals;
}

function createEventImageNavigation(
  groups$: Computed<readonly EventImageGroupProjection[]>,
  knownImages$: State<ReadonlyMap<string, ImageArtifactNavigationItem>>,
  selection$: Computed<ImageSelection | null>,
  select$: Command<void, [ImageArtifactNavigationItem, string, boolean]>,
): EventImageNavigationSignals {
  const neighbors$ = computed((get) => {
    const selection = get(selection$);
    if (!selection?.groupId) {
      return {};
    }
    const group = get(groups$).find((candidate) => {
      return candidate.id === selection.groupId;
    });
    return currentEventImageArtifactNavigation(
      group,
      selection.url,
      get(knownImages$),
    );
  });
  return {
    hasPrevious$: computed((get) => {
      return get(neighbors$).previous !== undefined;
    }),
    hasNext$: computed((get) => {
      return get(neighbors$).next !== undefined;
    }),
    navigate$: command(({ get, set }, direction) => {
      const groupId = get(selection$)?.groupId;
      const neighbors = get(neighbors$);
      const item = neighbors[direction];
      if (groupId && item) {
        set(select$, item, groupId, neighbors.role !== "user");
      }
    }),
  };
}

/** Each surface owns its current URL and group. Switching never enumerates thread artifacts. */
export function createThreadImageNavigationSignals(
  threadId: string,
  groups$: Computed<readonly EventImageGroupProjection[]>,
  sidebar: Pick<ThreadSidebarSignals, "target$" | "openAttachment$">,
): ThreadImageNavigationSignals {
  // A link without an extension joins the gallery once its own detail identifies it as an image.
  const knownImages$ = state<ReadonlyMap<string, ImageArtifactNavigationItem>>(
    new Map(),
  );
  return {
    openGroupForImage$: command(({ get, set }, eventId, item) => {
      const id = messageArtifactKey(item.url);
      const previous = get(knownImages$);
      if (!previous.has(id)) {
        set(knownImages$, new Map(previous).set(id, item));
      }
      return get(groups$).find((group) => {
        return group.events.some((event) => {
          return event.id === eventId;
        });
      })?.id;
    }),
    lightbox: createEventImageNavigation(
      groups$,
      knownImages$,
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
      knownImages$,
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
