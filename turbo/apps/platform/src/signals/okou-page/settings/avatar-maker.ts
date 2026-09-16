import { command, computed, state } from "ccstate";
import { delay } from "signal-timers";
import {
  updateAvatarComposerConfig,
  type AvatarComposerSelection,
} from "@okouai/core/agent-avatar";
import {
  isLegacyAvatarSvgConfig,
  randomAvatarSvgConfig,
  type AvatarSvgConfig,
} from "../../../views/okou-page/avatar-svg-utils.ts";
import { resolveAvatarSvgConfig } from "../../../views/okou-page/avatar-utils.ts";
import { avatarNeckSweaterEnabled$ } from "../../external/feature-switch.ts";
import { resetSignal } from "../../utils.ts";

export type Step =
  | "face"
  | "hair"
  | "expression"
  | "skin"
  | "hairColor"
  | "sweater";

const AVATAR_MAKER_STEPS: readonly Step[] = [
  "face",
  "hair",
  "expression",
  "skin",
  "hairColor",
];

const internalOpen$ = state(false);
const internalDialogSignal$ = state<AbortSignal | null>(null);
const resetAvatarMakerDialogSignal$ = resetSignal();

export { internalDialogSignal$ as avatarMakerDialogSignal$ };

export const avatarMakerOpen$ = computed((get) => {
  return get(internalOpen$);
});

const internalConfig$ = state<AvatarSvgConfig>(randomAvatarSvgConfig());
export const avatarMakerConfig$ = computed((get) => {
  return get(internalConfig$);
});

const internalStep$ = state<Step>("face");
export const avatarMakerStep$ = computed((get) => {
  return get(internalStep$);
});

/** True when the maker was opened on an avatar that already exists. */
const internalEditing$ = state(false);
export const avatarMakerEditing$ = computed((get) => {
  return get(internalEditing$);
});

export const avatarMakerSteps$ = computed((get): readonly Step[] => {
  return get(avatarNeckSweaterEnabled$)
    ? [...AVATAR_MAKER_STEPS, "sweater"]
    : AVATAR_MAKER_STEPS;
});

export const avatarMakerStepIdx$ = computed((get) => {
  return get(avatarMakerSteps$).indexOf(get(internalStep$));
});

const internalJustPicked$ = state<string | null>(null);
export const avatarMakerJustPicked$ = computed((get) => {
  return get(internalJustPicked$);
});

const internalShowSparkles$ = state(false);
export const avatarMakerShowSparkles$ = computed((get) => {
  return get(internalShowSparkles$);
});

const internalShuffling$ = state(false);
export const avatarMakerShuffling$ = computed((get) => {
  return get(internalShuffling$);
});

const releaseAvatarMakerSession$ = command(({ set }) => {
  set(internalDialogSignal$, null);
  set(internalOpen$, false);
  set(internalJustPicked$, null);
  set(internalShowSparkles$, false);
  set(internalShuffling$, false);
});

export const shuffleAvatar$ = command(async ({ set }, signal: AbortSignal) => {
  signal.throwIfAborted();
  set(internalConfig$, randomAvatarSvgConfig());
  set(internalShuffling$, true);
  set(internalShowSparkles$, true);
  await delay(600, { signal });
  set(internalShuffling$, false);
  set(internalShowSparkles$, false);
});

/**
 * Opens the maker on the current avatar, or a random composer avatar when
 * editing a legacy avatar. The saved avatar stays unchanged until the caller
 * confirms the replacement.
 */
export const openAvatarMaker$ = command(
  ({ set }, avatarUrl: string | null, parentSignal: AbortSignal) => {
    parentSignal.throwIfAborted();
    const dialogSignal = set(resetAvatarMakerDialogSignal$, parentSignal);
    dialogSignal.addEventListener(
      "abort",
      () => {
        set(releaseAvatarMakerSession$);
      },
      { once: true },
    );
    set(internalDialogSignal$, dialogSignal);
    const current = resolveAvatarSvgConfig(avatarUrl);
    const config =
      !current || isLegacyAvatarSvgConfig(current)
        ? randomAvatarSvgConfig()
        : current;
    set(internalConfig$, config);
    set(internalStep$, "face");
    set(internalEditing$, current !== null);
    set(internalJustPicked$, null);
    set(internalShowSparkles$, false);
    set(internalShuffling$, false);
    set(internalOpen$, true);
  },
);

export const selectAvatarOption$ = command(
  async (
    { get, set },
    selection: AvatarComposerSelection,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const previous = get(internalConfig$);
    set(internalConfig$, updateAvatarComposerConfig(previous, selection));

    set(internalJustPicked$, `${selection.field}-${selection.value}`);
    set(internalShowSparkles$, true);
    await delay(350, { signal });
    set(internalJustPicked$, null);
    set(internalShowSparkles$, false);
  },
);

export const goBackStep$ = command(({ get, set }) => {
  const steps = get(avatarMakerSteps$);
  const idx = get(avatarMakerStepIdx$);
  if (idx > 0) {
    set(internalStep$, steps[idx - 1]!);
  }
});

export const goForwardStep$ = command(({ get, set }) => {
  const steps = get(avatarMakerSteps$);
  const idx = get(avatarMakerStepIdx$);
  if (idx + 1 < steps.length) {
    set(internalStep$, steps[idx + 1]!);
  }
});

export const closeAvatarMaker$ = command(({ set }) => {
  set(resetAvatarMakerDialogSignal$);
  set(releaseAvatarMakerSession$);
});

export const confirmAvatarMaker$ = command(
  async (
    { get, set },
    onConfirm: (config: AvatarSvgConfig, signal: AbortSignal) => Promise<void>,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    await onConfirm(get(avatarMakerConfig$), signal);
    signal.throwIfAborted();
    set(closeAvatarMaker$);
  },
);
