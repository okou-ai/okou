import { command, computed, state } from "ccstate";
import {
  featureGuidesContract,
  type FeatureGuideEdition,
} from "@okouai/api-contracts/contracts/feature-guides";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept } from "../lib/accept.ts";
import { searchParams$, pathname$ } from "./route.ts";
import { appContentReady$ } from "./app-skeleton.ts";
import { forceUpgradeDialogOpen$ } from "./force-upgrade.ts";
import { settingsDialogOpen$ } from "./okou-page/settings/settings-dialog.ts";
import { apiClient$ } from "./api-client.ts";
import { authenticatedSessionKey$ } from "./auth.ts";
import { featureSwitch$ } from "./external/feature-switch.ts";
import { talkDraft$ } from "./okou-page/chat-draft.ts";

export interface FeatureGuideSnapshot {
  readonly owner: string;
  readonly edition: FeatureGuideEdition;
  readonly preview: boolean;
}

const dismissed$ = state<{
  readonly owner: string;
  readonly editionId: string;
  readonly preview: boolean;
} | null>(null);
const selectedItem$ = state(0);
const selectedStep$ = state(0);
export const featureGuideItemIndex$ = computed((get) => {
  return get(selectedItem$);
});
export const featureGuideStepIndex$ = computed((get) => {
  return get(selectedStep$);
});

export const featureGuide$ = computed(
  async (get): Promise<FeatureGuideSnapshot | null> => {
    const owner = get(authenticatedSessionKey$);
    const preview = get(searchParams$).get("featureGuidePreview") === "1";
    const enabled = get(featureSwitch$)[FeatureSwitchKey.FeatureGuides];
    if (!owner || !enabled) {
      return null;
    }
    const response = await accept(
      get(apiClient$)(featureGuidesContract).current({
        query: preview ? { preview: "1" } : undefined,
      }),
      [200, 403, 404],
    );
    // A newer App can briefly reach the preceding API during propagation or rollback.
    if (response.status !== 200 || !response.body.edition) {
      return null;
    }
    return {
      owner,
      edition: response.body.edition,
      preview: response.body.preview === true,
    };
  },
);

export const featureGuideReady$ = computed((get) => {
  if (
    !get(featureSwitch$)[FeatureSwitchKey.FeatureGuides] ||
    !get(appContentReady$)
  ) {
    return false;
  }
  const draft = get(talkDraft$);
  return (
    /^\/agents\/[^/]+\/chat$/u.test(get(pathname$)) &&
    !get(settingsDialogOpen$) &&
    !get(forceUpgradeDialogOpen$) &&
    !get(draft.input$).trim() &&
    get(draft.attachments$).length === 0
  );
});

export const dismissedFeatureGuide$ = computed((get) => {
  return get(dismissed$);
});
export const closeFeatureGuide$ = command(
  ({ set }, snapshot: FeatureGuideSnapshot) => {
    set(dismissed$, {
      owner: snapshot.owner,
      editionId: snapshot.edition.id,
      preview: snapshot.preview,
    });
  },
);
export const selectFeatureGuideItem$ = command(({ set }, index: number) => {
  set(selectedItem$, index);
  set(selectedStep$, 0);
});
export const selectFeatureGuideStep$ = command(({ set }, index: number) => {
  set(selectedStep$, index);
});

export const persistFeatureGuideSeen$ = command(
  async ({ get }, snapshot: FeatureGuideSnapshot, signal: AbortSignal) => {
    if (snapshot.preview || get(authenticatedSessionKey$) !== snapshot.owner) {
      return;
    }
    signal.throwIfAborted();
    await accept(
      get(apiClient$)(featureGuidesContract).seen({
        params: { editionId: snapshot.edition.id },
        body: { revisionId: snapshot.edition.revisionId },
        fetchOptions: { signal },
      }),
      [200, 403, 404],
    );
  },
);

export const tryFeatureGuidePrompt$ = command(
  ({ get, set }, snapshot: FeatureGuideSnapshot, prompt: string) => {
    if (get(authenticatedSessionKey$) !== snapshot.owner) {
      return;
    }
    const draft = get(talkDraft$);
    // A guide must never replace work the user started while its request was pending.
    if (get(draft.input$).trim() || get(draft.attachments$).length > 0) {
      return;
    }
    set(draft.setInput$, prompt);
    set(closeFeatureGuide$, snapshot);
  },
);
