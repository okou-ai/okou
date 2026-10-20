import { command, computed, state, type Computed } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { marked } from "marked";
import type { ArtifactSummary } from "@okouai/api-contracts/contracts/artifact-catalog";
import type { ArtifactCatalogSignals } from "../artifacts-page/create-artifact-catalog-signals.ts";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import { publicAttachmentUrl } from "../../views/okou-page/attachment-url.ts";
import { writeToClipboard } from "../okou-page/clipboard.ts";
import {
  currentHostedSiteUrl,
  hostedSiteUrlChanges$,
} from "../hosted-site-url-changes.ts";
import { messageDocumentToDisplayText } from "../okou-page/user-message-document-codec.ts";
import { userPreferences$ } from "../okou-page/settings/user-preferences.ts";
import { onRef } from "../utils.ts";
import type { ChatEventGroup } from "./chat-event.ts";

export const chatResourcePanelEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.ChatResourcePanel] === true;
});

const RESOURCE_PANEL_MIN_GUTTER = 408;

/** Whether the resource panel opens on its own in chats with resources. */
export const chatResourcesEnabledByDefault$ = computed(async (get) => {
  return (await get(userPreferences$)).chatResourcesEnabledByDefault;
});

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
  async ({ get }, url: string, signal: AbortSignal) => {
    const currentUrl = currentHostedSiteUrl(url, get(hostedSiteUrlChanges$));
    const copied = await writeToClipboard(publicAttachmentUrl(currentUrl));
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
    const url = preview ? await get(preview.shareUrl$) : null;
    signal.throwIfAborted();
    if (url === null) {
      toast.error(
        i18n.t(($) => {
          return $.chat.sharing.copyFailed;
        }),
      );
      return;
    }
    await set(copyChatResourceLink$, url, signal);
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
        // Source/alias URLs are optional metadata: shared snapshots can have
        // neither. Only known URLs deduplicate links; do not hydrate details.
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
  // The user's choice in this chat. A close always holds; an open made with
  // room beside the transcript steps aside while that room is gone.
  const choice$ = state<{
    readonly open: boolean;
    readonly narrow: boolean;
  } | null>(null);
  const wide$ = computed((get) => {
    return get(gutterWidth$) > RESOURCE_PANEL_MIN_GUTTER;
  });
  const automatic$ = computed(async (get) => {
    return get(wide$) && (await get(chatResourcesEnabledByDefault$));
  });
  const chosen$ = computed((get) => {
    const choice = get(choice$);
    return choice ? choice.open && (choice.narrow || get(wide$)) : null;
  });
  const setOpen$ = command(({ get, set }, open: boolean) => {
    set(choice$, { open, narrow: !get(wide$) });
  });
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
      set(choice$, null);
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
          set(choice$, null);
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
    automatic$,
    chosen$,
    wide$,
    setOpen$,
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
  };
}

export function createChatResourceSignals(
  groups$: Computed<readonly ChatEventGroup[]>,
  catalog: ArtifactCatalogSignals,
  initialEventsReady$: Computed<boolean>,
) {
  const panel = createChatResourcePanelSignals();
  const expandedSections$ = state({
    chats: false,
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
        section: "chats" | "artifacts" | "links",
        trigger: HTMLElement,
      ) => {
        if (get(expandedSections$)[section]) {
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
