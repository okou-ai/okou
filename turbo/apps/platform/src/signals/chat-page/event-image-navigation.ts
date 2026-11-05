import { command, computed, type Command, type Computed } from "ccstate";
import type { ChatThreadArtifactRun } from "@okouai/api-contracts/contracts/chat-threads";

import {
  currentEventImageArtifactNavigation,
  type ImageArtifactNavigationItem,
} from "../../views/okou-page/artifact-image-navigation.ts";
import { lightboxUrl$ } from "../okou-page/attachment-chips.ts";
import type { EventImageGroupProjection } from "./chat-panel-signals.ts";
import type { ThreadSidebarTarget } from "./thread-sidebar.ts";

export type EventImageNavigationDirection = "previous" | "next";

/**
 * Previous/next navigation for one image preview surface. Navigation stays in
 * the chat group that contains the current image. The rendering values are
 * primitives so transcript updates elsewhere do not re-render the preview.
 */
export interface EventImageNavigationSignals {
  /** Role of the group holding the current image; null when it is not shown. */
  readonly role$: Computed<EventImageGroupProjection["role"] | null>;
  readonly hasPrevious$: Computed<boolean>;
  readonly hasNext$: Computed<boolean>;
  /** Resolves the neighbor on demand, enriched with the loaded run artifacts. */
  readonly target$: Command<
    ImageArtifactNavigationItem | undefined,
    [EventImageNavigationDirection, readonly ChatThreadArtifactRun[]]
  >;
}

export interface ThreadImageNavigationSignals {
  /** The image open in the lightbox dialog. */
  readonly lightbox: EventImageNavigationSignals;
  /** The attachment open in this thread's artifact sidebar. */
  readonly sidebar: EventImageNavigationSignals;
}

function createEventImageNavigation(
  groups$: Computed<readonly EventImageGroupProjection[]>,
  url$: Computed<string | null>,
): EventImageNavigationSignals {
  // Without a current image the groups are not read, so a closed preview does
  // not follow transcript updates.
  const neighbors$ = computed((get) => {
    const url = get(url$);
    return url === null
      ? {}
      : currentEventImageArtifactNavigation([], get(groups$), url);
  });
  return {
    role$: computed((get) => {
      return get(neighbors$).role ?? null;
    }),
    hasPrevious$: computed((get) => {
      return get(neighbors$).previous !== undefined;
    }),
    hasNext$: computed((get) => {
      return get(neighbors$).next !== undefined;
    }),
    target$: command(({ get }, direction, runs) => {
      const url = get(url$);
      return url === null
        ? undefined
        : currentEventImageArtifactNavigation(runs, get(groups$), url)[
            direction
          ];
    }),
  };
}

export function createThreadImageNavigationSignals(
  groups$: Computed<readonly EventImageGroupProjection[]>,
  sidebarTarget$: Computed<ThreadSidebarTarget | null>,
): ThreadImageNavigationSignals {
  return {
    lightbox: createEventImageNavigation(
      groups$,
      computed((get) => {
        const preview = get(lightboxUrl$);
        return preview?.kind === "image" ? preview.url : null;
      }),
    ),
    sidebar: createEventImageNavigation(
      groups$,
      computed((get) => {
        const target = get(sidebarTarget$);
        return target?.type === "artifact" &&
          target.source.kind === "attachment"
          ? target.source.ref.url
          : null;
      }),
    ),
  };
}
