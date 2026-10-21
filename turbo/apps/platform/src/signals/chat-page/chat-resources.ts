import { command, computed, state, type Computed } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../external/feature-switch.ts";
import type { ArtifactCatalogSignals } from "../artifacts-page/create-artifact-catalog-signals.ts";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import { publicAttachmentUrl } from "../../views/okou-page/attachment-url.ts";
import { writeToClipboard } from "../okou-page/clipboard.ts";
import {
  currentHostedSiteUrl,
  hostedSiteUrlChanges$,
} from "../hosted-site-url-changes.ts";
import {
  updateUserPreference$,
  userPreferences$,
} from "../okou-page/settings/user-preferences.ts";
import { onRef, withCleanup } from "../utils.ts";
import type { ChatRelationSignals } from "./chat-relations.ts";

export const chatResourcePanelEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.ChatResourcePanel] === true;
});

const RESOURCE_PANEL_MIN_GUTTER = 408;

// The header button is the preference, as in Codex: the latest press shows at
// once, and saves run one after another so the last press is the one kept.
const optimisticPreference$ = state<{
  readonly enabled: boolean;
  readonly write: number;
} | null>(null);
const preferenceWrites$ = state(0);
const preferenceSaves$ = state<Promise<unknown>>(Promise.resolve());

/** Whether the resource panel shows on its own when there is room beside the transcript. */
const chatResourcesEnabledByDefault$ = computed(async (get) => {
  const optimistic = get(optimisticPreference$);
  return optimistic
    ? optimistic.enabled
    : (await get(userPreferences$)).chatResourcesEnabledByDefault;
});

const savePreference$ = command(
  async ({ get, set }, enabled: boolean, signal: AbortSignal) => {
    const write = get(preferenceWrites$) + 1;
    set(preferenceWrites$, write);
    set(optimisticPreference$, { enabled, write });
    const previous = get(preferenceSaves$);
    const save = (async () => {
      // An earlier failed save has already been reported; only its order matters.
      await Promise.allSettled([previous]);
      await set(
        updateUserPreference$,
        { chatResourcesEnabledByDefault: enabled },
        signal,
      );
      signal.throwIfAborted();
      await get(userPreferences$);
      signal.throwIfAborted();
    })();
    set(preferenceSaves$, save);
    await withCleanup(save, () => {
      // A later press owns the shown value until its own save settles.
      if (get(optimisticPreference$)?.write === write) {
        set(optimisticPreference$, null);
      }
    });
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

// What this visit has asked of the resources: a press to open, and whether the
// panel ever had room to open by itself. Once asked, the resources load to the
// end even if the layout stops asking, so the wait is never cut short.
function createResourceDemand() {
  const pressedOpen$ = state(false);
  const hadRoom$ = state(false);
  return {
    /** Whether the resources should load. */
    wanted$: computed(async (get) => {
      return (
        get(pressedOpen$) ||
        (get(hadRoom$) && (await get(chatResourcesEnabledByDefault$)))
      );
    }),
    recordPress$: command(({ set }, open: boolean) => {
      if (open) {
        set(pressedOpen$, true);
      }
    }),
    recordGutter$: command(({ set }, width: number) => {
      if (width > RESOURCE_PANEL_MIN_GUTTER) {
        set(hadRoom$, true);
      }
    }),
    reset$: command(({ set }) => {
      set(pressedOpen$, false);
      set(hadRoom$, false);
    }),
  };
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
  const demand = createResourceDemand();
  const wide$ = computed((get) => {
    return get(gutterWidth$) > RESOURCE_PANEL_MIN_GUTTER;
  });
  const chosen$ = computed((get) => {
    const choice = get(choice$);
    return choice ? choice.open && (choice.narrow || get(wide$)) : null;
  });
  /** Whether the panel should show once its resources are ready. */
  const requested$ = computed(async (get) => {
    return (
      get(chosen$) ??
      (get(wide$) && (await get(chatResourcesEnabledByDefault$)))
    );
  });
  const setOpen$ = command(({ get, set }, open: boolean) => {
    set(demand.recordPress$, open);
    set(choice$, { open, narrow: !get(wide$) });
  });
  // With room beside the transcript a press is the preference, for every chat.
  // Without it, a press only peeks in this chat and leaves the preference alone.
  const press$ = command(
    async ({ get, set }, open: boolean, signal: AbortSignal) => {
      set(demand.recordPress$, open);
      if (!get(wide$)) {
        set(choice$, { open, narrow: true });
        return;
      }
      // An explicit open also shows a chat that has nothing to list yet.
      set(choice$, open ? { open, narrow: false } : null);
      await set(savePreference$, open, signal);
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
    set(gutterWidth$, width);
    set(demand.recordGutter$, width);
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
      set(demand.reset$);
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
          set(demand.reset$);
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
    requested$,
    wanted$: demand.wanted$,
    chosen$,
    wide$,
    setOpen$,
    press$,
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
  // Resources load only once the panel is wanted, and the panel draws only
  // once every source has answered, so it never opens empty or grows in steps.
  const settled$ = computed(async (get) => {
    if (!(await get(panel.wanted$))) {
      return null;
    }
    const origin = get(relations.origin$);
    const [page, chats] = await Promise.allSettled([
      get(content$),
      get(relations.chats.data$),
    ]);
    if (page.status === "fulfilled" && page.value === null) {
      return null;
    }
    return {
      hasContent:
        page.status === "rejected" ||
        Boolean(page.value?.artifacts.length) ||
        origin?.kind === "source" ||
        chats.status === "rejected" ||
        chats.value.items.length > 0 ||
        chats.value.failed,
    };
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
    settled$,
    catalog,
    ...panel,
  };
}

export type ChatResourceSignals = ReturnType<typeof createChatResourceSignals>;
