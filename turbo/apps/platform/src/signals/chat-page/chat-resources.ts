import { command, computed, state, type Computed } from "ccstate";
import type { ArtifactCatalogSignals } from "../artifacts-page/create-artifact-catalog-signals.ts";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import { publicAttachmentUrl } from "../../views/okou-page/attachment-url.ts";
import { writeToClipboard } from "../okou-page/clipboard.ts";
import {
  currentHostedSiteUrl,
  hostedSiteUrlChanges$,
} from "../hosted-site-url-changes.ts";
import { onRef } from "../utils.ts";
import type { ChatRelationSignals } from "./chat-relations.ts";

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
  // A header panel like the others: a press opens it, any outside press,
  // focus leaving or Escape closes it, and each chat starts closed.
  const open$ = state(false);
  const anchor = createResourceElementRef();
  const popup = createResourceElementRef();
  const boundary$ = state<HTMLElement | null>(null);
  const collisionBoundary$ = state<HTMLElement | null>(null);
  const setOpen$ = command(({ set }, open: boolean) => {
    set(open$, open);
  });
  const layoutOnRef$ = onRef(
    command(({ set }, element: HTMLElement, signal: AbortSignal) => {
      const viewport = element.querySelector<HTMLElement>(
        "[data-scroll-container]",
      );
      if (!viewport) {
        return;
      }
      set(boundary$, viewport);
      // Use the whole pane so the composer does not shorten the resource list.
      set(collisionBoundary$, element);
      set(open$, false);
      signal.addEventListener(
        "abort",
        () => {
          set(boundary$, null);
          set(collisionBoundary$, null);
          set(open$, false);
        },
        { once: true },
      );
    }),
  );
  const blurControl$ = command(({ get, set }, target: EventTarget | null) => {
    if (
      target instanceof Node &&
      (get(anchor.element$)?.contains(target) ||
        get(popup.element$)?.contains(target))
    ) {
      return;
    }
    set(open$, false);
  });

  return {
    open$: computed((get) => {
      return get(open$);
    }),
    setOpen$,
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
  catalog: ArtifactCatalogSignals,
  initialEventsReady$: Computed<boolean>,
  relations: Pick<ChatRelationSignals, "origin$" | "chats" | "closeMessages$">,
) {
  const panel = createChatResourcePanelSignals();
  const content$ = computed(async (get) => {
    if (!get(initialEventsReady$)) {
      return null;
    }
    return await get(catalog.catalog$);
  });
  // Draw only once every source has answered so the panel never grows in
  // steps. The panel reads this only while it shows, so a chat whose panel
  // never opens loads nothing; a reopened panel reuses the cached answer.
  const ready$ = computed(async (get) => {
    // Initial events change the relation revision, invalidating earlier reads.
    if (!get(initialEventsReady$)) {
      return false;
    }
    const [page] = await Promise.allSettled([
      get(content$),
      get(relations.chats.data$),
    ]);
    return page.status === "rejected" || page.value !== null;
  });
  const expandedSections$ = state({
    chats: false,
    artifacts: false,
  });
  return {
    expandedSections$: computed((get) => {
      return get(expandedSections$);
    }),
    toggleSection$: command(
      ({ get, set }, section: "chats" | "artifacts", trigger: HTMLElement) => {
        if (get(expandedSections$)[section]) {
          // A collapsed preview may hide the chat whose messages are open.
          if (section === "chats") {
            set(relations.closeMessages$);
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
    content$,
    ready$,
    catalog,
    ...panel,
  };
}

export type ChatResourceSignals = ReturnType<typeof createChatResourceSignals>;
