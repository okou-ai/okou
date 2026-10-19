import { command, computed, state, type Command, type Computed } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { marked } from "marked";
import type { ArtifactSummary } from "@okouai/api-contracts/contracts/artifact-catalog";
import type { ArtifactCatalogSignals } from "../artifacts-page/create-artifact-catalog-signals.ts";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import { publicAttachmentUrl } from "../../views/okou-page/attachment-url.ts";
import { writeToClipboard } from "../okou-page/clipboard.ts";
import { messageDocumentToDisplayText } from "../okou-page/user-message-document-codec.ts";
import {
  userPreferences$,
  updateUserPreference$,
} from "../okou-page/settings/user-preferences.ts";
import { onRef, onRejection, withCleanup } from "../utils.ts";
import type { ChatEventGroup } from "./chat-event.ts";

export const chatResourcePanelEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.ChatResourcePanel] === true;
});

const RESOURCE_PANEL_MIN_GUTTER = 408;
const optimisticPreference$ = state<boolean | null>(null);
const preferenceRevision$ = state(0);
const savingPreference$ = computed((get) => {
  return get(optimisticPreference$) !== null;
});

const resourcePreference$ = computed(async (get) => {
  const optimistic = get(optimisticPreference$);
  return (
    optimistic ?? (await get(userPreferences$)).chatResourcesEnabledByDefault
  );
});

const saveResourcePreference$ = command(
  async ({ get, set }, enabled: boolean, signal: AbortSignal) => {
    if (get(savingPreference$)) {
      return;
    }
    set(optimisticPreference$, enabled);
    set(preferenceRevision$, (revision) => {
      return revision + 1;
    });
    await withCleanup(
      onRejection(
        async () => {
          await set(
            updateUserPreference$,
            { chatResourcesEnabledByDefault: enabled },
            signal,
          );
          signal.throwIfAborted();
          await get(userPreferences$);
          signal.throwIfAborted();
        },
        () => {
          set(preferenceRevision$, (revision) => {
            return revision + 1;
          });
        },
      ),
      () => {
        set(optimisticPreference$, null);
      },
    );
  },
);

export interface ChatResourceLink {
  readonly url: string;
  readonly title: string;
}

export interface ChatResourceContent {
  readonly artifacts: readonly ArtifactSummary[];
  readonly nextCursor: string | null;
  readonly links: readonly ChatResourceLink[];
}

async function messageLinks(content: string): Promise<ChatResourceLink[]> {
  const links: ChatResourceLink[] = [];
  await Promise.all(
    marked.walkTokens(marked.lexer(content), (token) => {
      if (token.type !== "link" || !URL.canParse(token.href)) {
        return;
      }
      const parsed = new URL(token.href);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return;
      }
      links.push({
        url: token.href,
        title: token.text.trim() || parsed.hostname,
      });
    }),
  );
  return links;
}

export const copyChatResourceLink$ = command(
  async (_context, url: string, signal: AbortSignal) => {
    const copied = await writeToClipboard(publicAttachmentUrl(url));
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

export const copyChatResourceArtifact$ = command(
  async (
    { get, set },
    catalog: ArtifactCatalogSignals,
    artifactId: string,
    signal: AbortSignal,
  ) => {
    set(catalog.selectArtifact$, artifactId);
    const preview = await set(
      catalog.ensureSelectedArtifactPreview$,
      artifactId,
      signal,
    );
    signal.throwIfAborted();
    if (preview) {
      const url = await get(preview.shareUrl$);
      signal.throwIfAborted();
      await set(copyChatResourceLink$, url, signal);
    }
  },
);

function createChatResourceContentSignals(
  groups$: Computed<readonly ChatEventGroup[]>,
  catalog: ArtifactCatalogSignals,
  initialEventsReady$: Computed<boolean>,
) {
  const links$ = computed(async (get) => {
    // The complete event projection is independent of the transcript render window.
    const groups = get(groups$);
    const { artifacts } = await get(catalog.catalog$);
    const seen = new Set(
      artifacts.flatMap((artifact) => {
        // Older APIs omit source URLs. Never hydrate summaries to dedup links.
        return [artifact.sourceUrl, artifact.aliasUrl].flatMap((url) => {
          return url ? [publicAttachmentUrl(url)] : [];
        });
      }),
    );
    const links: ChatResourceLink[] = [];
    for (const group of [...groups].reverse()) {
      for (const event of [...group.events].reverse()) {
        if (event.isQueued) {
          continue;
        }
        const text =
          event.eventType === "output.message"
            ? event.content
            : "userMessage" in event
              ? messageDocumentToDisplayText(event.userMessage)
              : "";
        for (const link of await messageLinks(text ?? "")) {
          const key = publicAttachmentUrl(link.url);
          if (!seen.has(key)) {
            seen.add(key);
            links.push(link);
          }
        }
      }
    }
    return links;
  });

  const content$ = computed(
    async (get): Promise<ChatResourceContent | null> => {
      if (!get(initialEventsReady$)) {
        return null;
      }
      const [page, links] = await Promise.all([
        get(catalog.catalog$),
        get(links$),
      ]);
      return { artifacts: page.artifacts, nextCursor: page.nextCursor, links };
    },
  );

  return { content$, links$ };
}

function createResourceElementRef() {
  const element$ = state<HTMLElement | null>(null);
  const onRef$ = onRef(
    command(({ get, set }, element: HTMLElement, signal: AbortSignal) => {
      set(element$, element);
      signal.addEventListener(
        "abort",
        () => {
          // A closing desktop popup can detach after its mobile replacement.
          if (get(element$) !== element) {
            return;
          }
          set(element$, null);
        },
        { once: true },
      );
    }),
  );
  return {
    element$: computed((get) => {
      return get(element$);
    }),
    onRef$,
  };
}

function resourcePopupAnchor(boundary: HTMLElement | null) {
  return boundary
    ? {
        contextElement: boundary,
        getBoundingClientRect: () => {
          const rect = boundary.getBoundingClientRect();
          return new DOMRect(rect.right - 16, rect.top + 16, 0, 0);
        },
      }
    : null;
}

function createChatResourcePanelSignals() {
  const gutterWidth$ = state(0);
  const anchor = createResourceElementRef();
  const popup = createResourceElementRef();
  const boundary$ = state<HTMLElement | null>(null);
  const collisionBoundary$ = state<HTMLElement | null>(null);
  const messageColumn$ = state<HTMLElement | null>(null);
  const temporary$ = state<{
    readonly open: boolean;
    readonly revision: number;
  } | null>(null);
  const wide$ = computed((get) => {
    return get(gutterWidth$) > RESOURCE_PANEL_MIN_GUTTER;
  });
  const open$ = computed(async (get) => {
    const temporary = get(temporary$);
    const revision = get(preferenceRevision$);
    const wide = get(wide$);
    const preferred = await get(resourcePreference$);
    return temporary?.revision === revision
      ? temporary.open
      : preferred && wide;
  });
  const setOpen$ = command(({ get, set }, open: boolean) => {
    set(temporary$, { open, revision: get(preferenceRevision$) });
  });
  const changePreference$ = command(
    async ({ get, set }, enabled: boolean, signal: AbortSignal) => {
      if (get(savingPreference$)) {
        return;
      }
      // Apply immediately, even when the narrow layout would normally be closed.
      set(temporary$, {
        open: enabled,
        revision: get(preferenceRevision$) + 1,
      });
      await set(saveResourcePreference$, enabled, signal);
    },
  );
  const measure$ = command(({ get, set }) => {
    const viewport = get(boundary$);
    const column = get(messageColumn$);
    if (!viewport || !column) {
      return;
    }
    const width = Math.max(
      0,
      viewport.getBoundingClientRect().right -
        column.getBoundingClientRect().right,
    );
    if (width > RESOURCE_PANEL_MIN_GUTTER !== get(wide$)) {
      set(temporary$, null);
    }
    set(gutterWidth$, width);
  });
  const layoutOnRef$ = onRef(
    command(({ set }, element: HTMLElement, signal: AbortSignal) => {
      const viewport = element.querySelector<HTMLElement>(
        "[data-scroll-container]",
      );
      const column = element.querySelector<HTMLElement>(
        "[data-message-container]",
      );
      if (!viewport || !column) {
        return;
      }
      set(boundary$, viewport);
      // Use the whole pane so the composer does not shorten the resource list.
      set(collisionBoundary$, element);
      set(messageColumn$, column);
      set(temporary$, null);
      const measure = () => {
        set(measure$);
      };
      // Shell commits and width transitions call measure$ after applying
      // application-owned layout. Native viewport changes have their own event.
      window.addEventListener("resize", measure, { signal });
      window.visualViewport?.addEventListener("resize", measure, { signal });
      measure();
      signal.addEventListener(
        "abort",
        () => {
          set(boundary$, null);
          set(collisionBoundary$, null);
          set(messageColumn$, null);
          set(temporary$, null);
        },
        { once: true },
      );
    }),
  );
  const blurControl$ = command(({ get, set }, target: EventTarget | null) => {
    if (get(wide$)) {
      return;
    }
    if (
      target instanceof Node &&
      (get(anchor.element$)?.contains(target) ||
        get(popup.element$)?.contains(target))
    ) {
      return;
    }
    set(setOpen$, false);
  });

  return {
    open$,
    wide$,
    setOpen$,
    changePreference$,
    measure$,
    layoutOnRef$,
    anchorOnRef$: anchor.onRef$,
    popupOnRef$: popup.onRef$,
    blurControl$,
    anchor$: anchor.element$,
    boundary$: computed((get) => {
      return get(boundary$);
    }),
    collisionBoundary$: computed((get) => {
      return get(collisionBoundary$);
    }),
    popupAnchor$: computed((get) => {
      return resourcePopupAnchor(get(boundary$));
    }),
    saving$: computed((get) => {
      return get(savingPreference$);
    }),
  };
}

export function createChatResourceSignals(
  groups$: Computed<readonly ChatEventGroup[]>,
  catalog: ArtifactCatalogSignals,
  initialEventsReady$: Computed<boolean>,
  closeMessages$: Command<void, []>,
) {
  const panel = createChatResourcePanelSignals();
  const expandedSections$ = state({
    messages: false,
    artifacts: false,
    links: false,
  });
  return {
    expandedSections$: computed((get) => {
      return get(expandedSections$);
    }),
    toggleSection$: command(
      (
        { get, set },
        section: "messages" | "artifacts" | "links",
        trigger: HTMLElement,
      ) => {
        if (get(expandedSections$)[section]) {
          if (section === "messages") {
            set(closeMessages$);
          }
          const group = trigger.closest("section");
          const scroll = trigger.closest<HTMLElement>("[data-resource-scroll]");
          if (group && scroll) {
            const top =
              group.getBoundingClientRect().top -
              scroll.getBoundingClientRect().top;
            if (top < 0 || top > scroll.clientHeight - 28) {
              scroll.scrollTop += top;
            }
          }
        }
        set(expandedSections$, (expanded) => {
          return { ...expanded, [section]: !expanded[section] };
        });
      },
    ),
    ...createChatResourceContentSignals(groups$, catalog, initialEventsReady$),
    catalog,
    ...panel,
  };
}

export type ChatResourceSignals = ReturnType<typeof createChatResourceSignals>;
