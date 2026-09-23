import { command, computed, state } from "ccstate";
import {
  randomAvatarSvgConfig,
  serializeAvatarSvgConfig,
} from "../../views/okou-page/avatar-svg-utils.ts";
import { closeAvatarMaker$ } from "./settings/avatar-maker.ts";

function randomSvgAvatarUrl(): string {
  return serializeAvatarSvgConfig(randomAvatarSvgConfig());
}

// ---------------------------------------------------------------------------
// Create-teammate dialog state
// ---------------------------------------------------------------------------

const internalDialogOpen$ = state(false);
export const jobsDialogOpen$ = computed((get) => {
  return get(internalDialogOpen$);
});
export const setJobsDialogOpen$ = command(({ set }, open: boolean) => {
  if (!open) {
    set(closeAvatarMaker$);
  }
  set(internalDialogOpen$, open);
});

const internalNewName$ = state("");
export const jobsNewName$ = computed((get) => {
  return get(internalNewName$);
});
export const setJobsNewName$ = command(({ set }, name: string) => {
  set(internalNewName$, name);
});

// -- Responsibility ---------------------------------------------------------

const internalResponsibility$ = state("");
export const jobsResponsibility$ = computed((get) => {
  return get(internalResponsibility$);
});
export const setJobsResponsibility$ = command(
  ({ set }, responsibility: string) => {
    set(internalResponsibility$, responsibility);
  },
);

// -- Visibility -------------------------------------------------------------

const internalVisibility$ = state<"public" | "private">("private");
export const jobsVisibility$ = computed((get) => {
  return get(internalVisibility$);
});
export const setJobsVisibility$ = command(
  ({ set }, visibility: "public" | "private") => {
    set(internalVisibility$, visibility);
  },
);

// -- Active tab -------------------------------------------------------------

const internalActiveTab$ = state<"public" | "private">("public");
export const jobsActiveTab$ = computed((get) => {
  return get(internalActiveTab$);
});
export const setJobsActiveTab$ = command(
  ({ set }, tab: "public" | "private") => {
    set(internalActiveTab$, tab);
  },
);

// -- Avatar -----------------------------------------------------------------

const internalAvatarUrl$ = state(randomSvgAvatarUrl());
export const jobsAvatarUrl$ = computed((get) => {
  return get(internalAvatarUrl$);
});
export const setJobsAvatarUrl$ = command(({ set }, url: string) => {
  set(internalAvatarUrl$, url);
});

// -- Create a fresh dialog draft --------------------------------------------

export const resetJobsDialog$ = command(({ set }) => {
  set(closeAvatarMaker$);
  set(internalNewName$, "");
  set(internalResponsibility$, "");
  set(internalVisibility$, "private");
  set(internalAvatarUrl$, randomSvgAvatarUrl());
});
