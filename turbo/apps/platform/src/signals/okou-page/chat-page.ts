import { command, computed, state } from "ccstate";
import {
  DEFAULT_IMAGE_MODEL,
  type ImageModel,
} from "@okouai/core/image-model-catalog";
import {
  DEFAULT_VIDEO_MODEL,
  type VideoModel,
} from "@okouai/core/video-model-catalog";
import {
  chatReasoningEffortEnabled$,
  codexFastModeEnabled$,
} from "../external/feature-switch.ts";
import { orgModelPolicies$ } from "../external/org-model-policies.ts";
import { userModelPreference$ } from "../external/user-model-preference.ts";
import {
  isCodexFastModeAvailableForSelection,
  resolveModelFirstUserDefaultSelection,
} from "./model-default-selection.ts";
import type { ModelProviderSelection } from "../../views/okou-page/components/model-provider-picker.tsx";
import { createPersonalModelProviderAuthSignals } from "./personal-model-provider-auth.ts";
import { onRef, setLoop } from "../utils.ts";

const internalTaglineIndex$ = state(Math.floor(Math.random() * 18));
const internalTaglineDisplayed$ = state("");

export const reloadTagline$ = command(({ set }) => {
  set(internalTaglineIndex$, Math.floor(Math.random() * 18));
});

export const chatPageTaglineIndex$ = computed((get) => {
  return get(internalTaglineIndex$);
});

export const chatPageTaglineDisplayed$ = computed((get) => {
  return get(internalTaglineDisplayed$);
});

const startTaglineTypewriter$ = command(
  async ({ set }, element: HTMLElement, signal: AbortSignal) => {
    const text = element.dataset.typewriterText ?? "";
    const parsedSpeed = Number.parseInt(
      element.dataset.typewriterSpeed ?? "40",
      10,
    );
    const speed = Number.isFinite(parsedSpeed) ? parsedSpeed : 40;

    set(internalTaglineDisplayed$, "");
    let index = 0;
    await setLoop(
      () => {
        index += 1;
        set(internalTaglineDisplayed$, text.slice(0, index));
        return index >= text.length;
      },
      speed,
      signal,
    );
  },
);

export const chatPageTaglineTypewriterRef$ = onRef(startTaglineTypewriter$);

// ---------------------------------------------------------------------------
// Landing-page composer model selection
// ---------------------------------------------------------------------------

// Discriminated union so "user hasn't picked anything" can resolve to the
// current model-first default while "user explicitly picked inherit" stays null.
const internalChatPageUserOverride$ = state<
  { kind: "unset" } | { kind: "set"; value: ModelProviderSelection | null }
>({ kind: "unset" });

const internalChatPageVideoModelOverride$ = state<
  { kind: "unset" } | { kind: "set"; value: VideoModel | null }
>({ kind: "unset" });

const internalChatPageImageModelOverride$ = state<
  { kind: "unset" } | { kind: "set"; value: ImageModel | null }
>({ kind: "unset" });

export const chatPageModelSelection$ = computed(
  async (get): Promise<ModelProviderSelection | null> => {
    const user = get(internalChatPageUserOverride$);
    if (user.kind === "set") {
      if (!user.value) {
        return null;
      }
      const selection: ModelProviderSelection = {
        selectedModel: user.value.selectedModel,
        modelSettings: get(chatReasoningEffortEnabled$)
          ? (user.value.modelSettings ?? {})
          : {},
      };
      if (user.value.codexServiceTier !== "fast") {
        return selection;
      }
      const policies = await get(orgModelPolicies$);
      return isCodexFastModeAvailableForSelection({
        policies,
        selectedModel: user.value.selectedModel,
        codexFastModeEnabled: get(codexFastModeEnabled$),
      })
        ? { ...selection, codexServiceTier: "fast" }
        : selection;
    }
    const policies = await get(orgModelPolicies$);
    const userPreference = await get(userModelPreference$);
    return resolveModelFirstUserDefaultSelection({
      userPreference,
      policies,
      codexFastModeEnabled: get(codexFastModeEnabled$),
    });
  },
);

const chatPageSelectedModel$ = computed(async (get): Promise<string | null> => {
  return (await get(chatPageModelSelection$))?.selectedModel ?? null;
});

export const {
  oauthAvailable$: chatPageSelectedModelOauthAvailable$,
  configure$: configureChatPageSelectedModel$,
} = createPersonalModelProviderAuthSignals(chatPageSelectedModel$);

export const setChatPageModelSelection$ = command(
  ({ set }, value: ModelProviderSelection | null) => {
    set(internalChatPageUserOverride$, { kind: "set", value });
  },
);

export const chatPageVideoModelSelection$ = computed(
  async (get): Promise<VideoModel | null> => {
    const user = get(internalChatPageVideoModelOverride$);
    if (user.kind === "set") {
      return user.value;
    }
    const userPreference = await get(userModelPreference$);
    return userPreference.selectedVideoModel ?? DEFAULT_VIDEO_MODEL;
  },
);

export const chatPageImageModelSelection$ = computed(
  async (get): Promise<ImageModel | null> => {
    const user = get(internalChatPageImageModelOverride$);
    if (user.kind === "set") {
      return user.value;
    }
    const userPreference = await get(userModelPreference$);
    return userPreference.selectedImageModel ?? DEFAULT_IMAGE_MODEL;
  },
);

/**
 * What a video run started from the new-thread composer would use. The
 * selection above is null when the user cleared it back to "follow my
 * default", so the parameter panel resolves through the same member and system
 * defaults the API would.
 */
export const chatPageEffectiveVideoModel$ = computed(
  async (get): Promise<VideoModel> => {
    return (
      (await get(chatPageVideoModelSelection$)) ??
      (await get(userModelPreference$)).selectedVideoModel ??
      DEFAULT_VIDEO_MODEL
    );
  },
);

/** The image model a run started from the new-thread composer would use. */
export const chatPageEffectiveImageModel$ = computed(
  async (get): Promise<ImageModel> => {
    return (
      (await get(chatPageImageModelSelection$)) ??
      (await get(userModelPreference$)).selectedImageModel ??
      DEFAULT_IMAGE_MODEL
    );
  },
);

/**
 * The explicit landing-composer pin: the model the user actively chose for the
 * next new chat, or null when they never touched the picker. Unlike
 * chatPage*ModelSelection$, this does NOT fall back to the member default, so an
 * untouched new thread is created unpinned and follows the live default.
 */
export const chatPageVideoModelPin$ = computed((get): VideoModel | null => {
  const user = get(internalChatPageVideoModelOverride$);
  return user.kind === "set" ? user.value : null;
});

export const chatPageImageModelPin$ = computed((get): ImageModel | null => {
  const user = get(internalChatPageImageModelOverride$);
  return user.kind === "set" ? user.value : null;
});

export const setChatPageVideoModelSelection$ = command(
  ({ set }, value: VideoModel | null) => {
    set(internalChatPageVideoModelOverride$, { kind: "set", value });
  },
);

export const setChatPageImageModelSelection$ = command(
  ({ set }, value: ImageModel | null) => {
    set(internalChatPageImageModelOverride$, { kind: "set", value });
  },
);

export const resetChatPageModelSelection$ = command(({ get, set }) => {
  if (get(internalChatPageUserOverride$).kind === "set") {
    set(internalChatPageUserOverride$, { kind: "unset" });
  }
});

export const resetChatPageVideoModelSelection$ = command(({ get, set }) => {
  if (get(internalChatPageVideoModelOverride$).kind === "set") {
    set(internalChatPageVideoModelOverride$, { kind: "unset" });
  }
});

export const resetChatPageImageModelSelection$ = command(({ get, set }) => {
  if (get(internalChatPageImageModelOverride$).kind === "set") {
    set(internalChatPageImageModelOverride$, { kind: "unset" });
  }
});
