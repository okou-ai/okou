import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import type { IntroVideoOptions } from "@okouai/api-contracts/contracts/intro-video-options";
import { introVideoTemplateOptions } from "@okouai/core/intro-video-template";
import { type State, command, computed, state } from "ccstate";

import { onRef } from "../utils.ts";

/**
 * The advanced panel's own view. `root` offers the few choices most people
 * take — a default voice, no presenter, the first of each library — and the
 * two library views replace it in place, so the panel keeps one back stack
 * instead of opening a second dialog.
 */
type IntroVideoPickerPanelView = "root" | "voice" | "avatar";

/**
 * Which edge of a scroller still has content under it. A fade is drawn on that
 * edge alone: fading an edge that is already at the end of the content dims
 * content for no reason.
 */
export type ScrollFade = "none" | "start" | "end" | "both";

function scrollFade(node: HTMLElement): ScrollFade {
  const max = node.scrollWidth - node.clientWidth;
  if (max <= 1) {
    return "none";
  }
  const position = node.scrollLeft;
  return position <= 1 ? "end" : position >= max - 1 ? "start" : "both";
}

/**
 * Keeps one scroller's fade state current. The width of both scrollers changes
 * when the options layer opens — the section gives up its right-hand gutter —
 * so a scroll listener alone would keep a stale value; the observer is what
 * covers a resize the user never scrolled for.
 */
function createScrollFadeRef(fade$: State<ScrollFade>) {
  return onRef<HTMLDivElement>(
    command(({ set }, node: HTMLDivElement, signal: AbortSignal) => {
      const sync = () => {
        set(fade$, scrollFade(node));
      };
      sync();
      node.addEventListener("scroll", sync, { passive: true, signal });
      const observer = new ResizeObserver(sync);
      observer.observe(node);
      signal.addEventListener("abort", () => {
        observer.disconnect();
      });
    }),
  );
}

/**
 * The style is the only required choice. A voice the user never opened is
 * `{ kind: "default" }` — the system picks one that fits — so the picker can
 * state the default instead of holding the primary action hostage to it.
 */
function defaultVoice(): IntroVideoOptions["voice"] {
  return { kind: "default" };
}

export function createIntroVideoPickerSignals() {
  const style$ = state<IntroVideoOptions["style"] | null>(null);
  const avatar$ = state<IntroVideoOptions["avatar"]>({ kind: "none" });
  const voice$ = state<IntroVideoOptions["voice"]>(defaultVoice());
  const group$ = state("all");
  const query$ = state("");
  const libraryQuery$ = state("");
  const panelOpen$ = state(false);
  const panelView$ = state<IntroVideoPickerPanelView>("root");
  const filterFade$ = state<ScrollFade>("none");
  return {
    style$: computed((get) => {
      return get(style$);
    }),
    avatar$: computed((get) => {
      return get(avatar$);
    }),
    voice$: computed((get) => {
      return get(voice$);
    }),
    group$: computed((get) => {
      return get(group$);
    }),
    query$: computed((get) => {
      return get(query$);
    }),
    libraryQuery$: computed((get) => {
      return get(libraryQuery$);
    }),
    panelOpen$: computed((get) => {
      return get(panelOpen$);
    }),
    panelView$: computed((get) => {
      return get(panelView$);
    }),
    filterFade$: computed((get) => {
      return get(filterFade$);
    }),
    template$: computed((get): GenerationTemplateRequest | null => {
      const style = get(style$);
      return style
        ? {
            type: "intro-video",
            selection: {
              options: { style, avatar: get(avatar$), voice: get(voice$) },
            },
          }
        : null;
    }),
    setStyle$: command(({ set }, style: IntroVideoOptions["style"]) => {
      set(style$, style);
    }),
    setAvatar$: command(({ set }, avatar: IntroVideoOptions["avatar"]) => {
      set(avatar$, avatar);
    }),
    setVoice$: command(({ set }, voice: IntroVideoOptions["voice"]) => {
      set(voice$, voice);
    }),
    setGroup$: command(({ set }, group: string) => {
      set(group$, group);
    }),
    setQuery$: command(({ set }, query: string) => {
      set(query$, query);
    }),
    setLibraryQuery$: command(({ set }, query: string) => {
      set(libraryQuery$, query);
    }),
    /** Brings a style filtered out of the wall back into view. */
    clearFilters$: command(({ set }) => {
      set(group$, "all");
      set(query$, "");
    }),
    /** Returns both optional settings to what the picker opens with. */
    resetOptions$: command(({ set }) => {
      set(voice$, defaultVoice());
      set(avatar$, { kind: "none" });
    }),
    setPanelOpen$: command(({ set }, open: boolean) => {
      set(panelOpen$, open);
      if (!open) {
        set(panelView$, "root");
        set(libraryQuery$, "");
      }
    }),
    setPanelView$: command(({ set }, view: IntroVideoPickerPanelView) => {
      set(panelView$, view);
      set(panelOpen$, true);
      set(libraryQuery$, "");
    }),
    setFilterRowRef$: createScrollFadeRef(filterFade$),
    restore$: command(({ set }, template: GenerationTemplateRequest | null) => {
      const options = introVideoTemplateOptions(template);
      set(group$, "all");
      set(query$, "");
      set(libraryQuery$, "");
      set(panelOpen$, false);
      set(panelView$, "root");
      // `introVideoTemplateOptions` resolves to `undefined` only when there is
      // no intro video template to restore. The options schema makes all three
      // fields required, so the right branch is the picker's initial state
      // rather than a per-field default.
      set(style$, options ? options.style : null);
      set(avatar$, options ? options.avatar : { kind: "none" });
      set(voice$, options ? options.voice : defaultVoice());
    }),
  };
}

export type IntroVideoPickerSignals = ReturnType<
  typeof createIntroVideoPickerSignals
>;
