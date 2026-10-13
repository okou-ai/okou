import { command, computed, state, type Computed } from "ccstate";
import { marked } from "marked";
import type { ChatThreadArtifactRun } from "@okouai/api-contracts/contracts/chat-threads";
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

const RESOURCE_PANEL_MIN_GUTTER = 408;
const optimisticPreference$ = state<boolean | null>(null);
const preferenceRevision$ = state(0);
const savingPreference$ = state(false);

const resourcePreference$ = computed(async (get) => {
  const optimistic = get(optimisticPreference$);
  return (
    optimistic ??
    (await get(userPreferences$)).chatResourcesEnabledByDefault ??
    true
  );
});

const saveResourcePreference$ = command(
  async ({ get, set }, enabled: boolean, signal: AbortSignal) => {
    if (get(savingPreference$)) {
      return;
    }
    set(savingPreference$, true);
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
          if (!signal.aborted) {
            toast.error(
              i18n.t(($) => {
                return $.chat.resources.saveFailed;
              }),
            );
          }
        },
      ),
      () => {
        set(optimisticPreference$, null);
        set(savingPreference$, false);
      },
    );
  },
);

export interface ChatResourceLink {
  readonly url: string;
  readonly title: string;
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

function createChatResourceContentSignals(
  groups$: Computed<readonly ChatEventGroup[]>,
  artifacts$: Computed<Promise<ChatThreadArtifactRun[]>>,
) {
  const outputs$ = computed(async (get) => {
    const files = (await get(artifacts$)).flatMap((run) => {
      return run.files;
    });
    const seen = new Set<string>();
    return files
      .sort((left, right) => {
        return right.createdAt.localeCompare(left.createdAt);
      })
      .filter((file) => {
        const key = file.artifactId ?? file.id;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
  });
  const links$ = computed(async (get) => {
    // The complete event projection is independent of the transcript render window.
    const groups = get(groups$);
    const outputs = await get(outputs$);
    const seen = new Set(
      outputs.flatMap((file) => {
        return [
          publicAttachmentUrl(file.url),
          ...(file.aliasUrl ? [file.aliasUrl] : []),
        ];
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

  return { outputs$, links$ };
}

function createResourceElementRef() {
  const element$ = state<HTMLElement | null>(null);
  const onRef$ = onRef(
    command(({ set }, element: HTMLElement, signal: AbortSignal) => {
      set(element$, element);
      signal.addEventListener(
        "abort",
        () => {
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
  const layoutOnRef$ = onRef(
    command(({ get, set }, element: HTMLElement, signal: AbortSignal) => {
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
      set(temporary$, null);
      const measure = () => {
        const width = Math.max(
          0,
          viewport.getBoundingClientRect().right -
            column.getBoundingClientRect().right,
        );
        if (width > RESOURCE_PANEL_MIN_GUTTER !== get(wide$)) {
          set(temporary$, null);
        }
        set(gutterWidth$, width);
      };
      const observer = new ResizeObserver(measure);
      observer.observe(viewport);
      observer.observe(column);
      measure();
      signal.addEventListener(
        "abort",
        () => {
          observer.disconnect();
          set(boundary$, null);
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
    layoutOnRef$,
    anchorOnRef$: anchor.onRef$,
    popupOnRef$: popup.onRef$,
    blurControl$,
    anchor$: anchor.element$,
    boundary$: computed((get) => {
      return get(boundary$);
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
  artifacts$: Computed<Promise<ChatThreadArtifactRun[]>>,
) {
  return {
    ...createChatResourceContentSignals(groups$, artifacts$),
    ...createChatResourcePanelSignals(),
  };
}

export type ChatResourceSignals = ReturnType<typeof createChatResourceSignals>;
