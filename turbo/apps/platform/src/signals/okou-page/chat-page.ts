import { command, computed, state } from "ccstate";
import {
  DEFAULT_IMAGE_MODEL,
  type ImageModel,
} from "@okouai/core/image-model-catalog";
import {
  DEFAULT_VIDEO_MODEL,
  type VideoModel,
} from "@okouai/core/video-model-catalog";
import { orgModelPolicies$ } from "../external/org-model-policies.ts";
import { userModelPreference$ } from "../external/user-model-preference.ts";
import {
  isCodexFastModeAvailableForSelection,
  resolveModelFirstUserDefaultSelection,
} from "./model-default-selection.ts";
import type { ModelProviderSelection } from "../../views/okou-page/components/model-provider-picker.tsx";
import { createPersonalModelProviderAuthSignals } from "./personal-model-provider-auth.ts";
import { onRef, setLoop } from "../utils.ts";
import { now } from "../../lib/time.ts";

const internalTaglineIndex$ = state(Math.floor(Math.random() * 18));
const internalTaglineDisplayed$ = state({ text: "", displayed: "" });

const TAGLINE_HOLD_MS = 220;
const TAGLINE_REVEAL_MS = 1050;
const TAGLINE_FRAME_MS = 16;

export const reloadTagline$ = command(({ set }) => {
  set(internalTaglineIndex$, Math.floor(Math.random() * 18));
});

export const chatPageTaglineIndex$ = computed((get) => {
  return get(internalTaglineIndex$);
});

export const chatPageTaglineDisplayed$ = computed((get) => {
  return get(internalTaglineDisplayed$);
});

/** Ease the first and last 16% of the travel without bouncing or overshooting. */
function taglineProgress(progress: number): number {
  const ramp = 0.16;
  if (progress < ramp) {
    return (progress * progress) / (2 * ramp * (1 - ramp));
  }
  if (progress > 1 - ramp) {
    return 1 - (1 - progress) ** 2 / (2 * ramp * (1 - ramp));
  }
  return (progress - ramp / 2) / (1 - ramp);
}

function taglinePrefixWidth(range: Range, end: number): number {
  range.setEnd(range.startContainer, end);
  const rects = Array.from(range.getClientRects());
  const left = rects[0]?.left ?? 0;
  return Math.max(
    0,
    ...rects.map((rect) => {
      return rect.right - left;
    }),
  );
}

function moveTagline(
  element: HTMLElement,
  row: HTMLElement,
  range: Range,
  ends: number[],
  position: number,
): void {
  const index = Math.floor(position);
  const fullLength = ends.at(-1) ?? 0;
  const previousWidth = taglinePrefixWidth(range, ends[index - 1] ?? 0);
  const nextWidth = taglinePrefixWidth(range, ends[index] ?? fullLength);
  const fullWidth = taglinePrefixWidth(range, fullLength);
  const width =
    previousWidth + (nextWidth - previousWidth) * (position - index);
  // Preserve the final line wrapping. Once the longest line has unfolded,
  // the remaining lines can type without moving the avatar any farther.
  const headingWidth =
    element.parentElement?.getBoundingClientRect().width ?? 0;
  const visibleWidth = fullWidth === 0 ? 0 : (width / fullWidth) * headingWidth;
  const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
  const gapProgress = Math.min(1, position);
  row.style.setProperty(
    "--chat-greeting-offset",
    `calc(50% - 1.75rem - ${(visibleWidth + gap * gapProgress) / 2}px)`,
  );
}

const startTaglineTypewriter$ = command(
  ({ set }, element: HTMLElement, signal: AbortSignal) => {
    const text = element.textContent ?? "";
    const row = element.closest<HTMLElement>('[data-slot="chat-greeting"]');
    if (!row) {
      throw new Error("The tagline must be mounted inside its greeting row");
    }
    row.style.setProperty("--chat-greeting-offset", "calc(50% - 1.75rem)");
    set(internalTaglineDisplayed$, { text, displayed: "" });
    if (!text) {
      return;
    }

    const node = element.firstChild;
    if (!(node instanceof Text)) {
      throw new Error("The tagline measurement must contain its complete text");
    }
    const range = document.createRange();
    range.setStart(node, 0);
    const ends = Array.from(
      new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
      ({ index, segment }) => {
        return index + segment.length;
      },
    );
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const startedAt = now();
    let displayedIndex = 0;

    setLoop(
      () => {
        const progress = Math.min(
          1,
          Math.max(
            0,
            (now() - startedAt - TAGLINE_HOLD_MS) / TAGLINE_REVEAL_MS,
          ),
        );
        if (reducedMotion.matches || progress === 1) {
          row.style.setProperty("--chat-greeting-offset", "0px");
          set(internalTaglineDisplayed$, { text, displayed: text });
          return true;
        }
        if (progress === 0) {
          return false;
        }
        const position = taglineProgress(progress) * ends.length;
        moveTagline(element, row, range, ends, position);
        const index = Math.floor(position);
        if (index !== displayedIndex) {
          displayedIndex = index;
          set(internalTaglineDisplayed$, {
            text,
            displayed: text.slice(0, ends[index - 1] ?? 0),
          });
        }
        return false;
      },
      TAGLINE_FRAME_MS,
      signal,
      { testIntervalMs: TAGLINE_FRAME_MS },
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
        modelSettings: user.value.modelSettings ?? {},
      };
      if (user.value.codexServiceTier !== "fast") {
        return selection;
      }
      const policies = await get(orgModelPolicies$);
      return isCodexFastModeAvailableForSelection({
        policies,
        selectedModel: user.value.selectedModel,
      })
        ? { ...selection, codexServiceTier: "fast" }
        : selection;
    }
    const policies = await get(orgModelPolicies$);
    const userPreference = await get(userModelPreference$);
    return resolveModelFirstUserDefaultSelection({
      userPreference,
      policies,
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
