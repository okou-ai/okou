import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import type { IntroVideoOptions } from "@okouai/api-contracts/contracts/intro-video-options";
import { introVideoTemplateOptions } from "@okouai/core/intro-video-template";
import { command, computed, state } from "ccstate";

/**
 * The advanced panel's own view. `root` lists the current voice and presenter;
 * the two library views replace it in place so the panel keeps one back stack
 * instead of opening a second dialog.
 */
type IntroVideoPickerPanelView = "root" | "voice" | "avatar";

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
  const panelOpen$ = state(false);
  const panelView$ = state<IntroVideoPickerPanelView>("root");
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
    panelOpen$: computed((get) => {
      return get(panelOpen$);
    }),
    panelView$: computed((get) => {
      return get(panelView$);
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
    setPanelOpen$: command(({ set }, open: boolean) => {
      set(panelOpen$, open);
      if (!open) {
        set(panelView$, "root");
      }
    }),
    setPanelView$: command(({ set }, view: IntroVideoPickerPanelView) => {
      set(panelView$, view);
      set(panelOpen$, true);
    }),
    restore$: command(({ set }, template: GenerationTemplateRequest | null) => {
      const options = introVideoTemplateOptions(template);
      set(group$, "all");
      set(query$, "");
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
