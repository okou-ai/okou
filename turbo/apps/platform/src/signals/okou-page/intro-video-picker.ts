import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import type { IntroVideoOptions } from "@okouai/api-contracts/contracts/intro-video-options";
import { introVideoTemplateOptions } from "@okouai/core/intro-video-template";
import { command, computed, state } from "ccstate";

export type IntroVideoPickerTab = "style" | "avatar" | "voice";

export function createIntroVideoPickerSignals() {
  const tab$ = state<IntroVideoPickerTab>("style");
  const style$ = state<IntroVideoOptions["style"] | null>(null);
  const avatar$ = state<IntroVideoOptions["avatar"]>({ kind: "none" });
  const voice$ = state<IntroVideoOptions["voice"] | null>(null);
  const group$ = state("all");
  return {
    tab$: computed((get) => {
      return get(tab$);
    }),
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
    template$: computed((get): GenerationTemplateRequest | null => {
      const style = get(style$);
      const voice = get(voice$);
      return style && voice
        ? {
            type: "intro-video",
            selection: {
              options: { style, avatar: get(avatar$), voice },
            },
          }
        : null;
    }),
    setTab$: command(({ set }, tab: IntroVideoPickerTab) => {
      set(tab$, tab);
      set(group$, "all");
    }),
    setStyle$: command(({ set }, style: IntroVideoOptions["style"]) => {
      set(style$, style);
    }),
    setAvatar$: command(({ get, set }, avatar: IntroVideoOptions["avatar"]) => {
      set(avatar$, avatar);
      if (avatar.kind === "catalog" && get(voice$) === null) {
        set(voice$, { kind: "default" });
      }
    }),
    setVoice$: command(({ set }, voice: IntroVideoOptions["voice"]) => {
      set(voice$, voice);
    }),
    setGroup$: command(({ set }, group: string) => {
      set(group$, group);
    }),
    restore$: command(({ set }, template: GenerationTemplateRequest | null) => {
      const options = introVideoTemplateOptions(template);
      set(tab$, "style");
      set(group$, "all");
      set(style$, options?.style ?? null);
      set(avatar$, options?.avatar ?? { kind: "none" });
      set(voice$, options?.voice ?? null);
    }),
  };
}

export type IntroVideoPickerSignals = ReturnType<
  typeof createIntroVideoPickerSignals
>;
