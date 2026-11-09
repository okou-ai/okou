import { command, computed, state } from "ccstate";
import { featureGuidesContract } from "@okouai/api-contracts/client/feature-guides";
import type { FeatureGuideEdition } from "@okouai/api-contracts/contracts/feature-guides";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept } from "../lib/accept.ts";
import { searchParams$ } from "./route.ts";
import { agentChatPageActive$ } from "./active-route.ts";
import { appContentReady$ } from "./app-skeleton.ts";
import { forceUpgradeDialogOpen$ } from "./force-upgrade.ts";
import { settingsDialogOpen$ } from "./okou-page/settings/settings-dialog.ts";
import { apiClient$ } from "./api-client.ts";
import { authenticatedSessionKey$ } from "./auth.ts";
import { featureSwitch$ } from "./external/feature-switch.ts";
import { talkDraft$ } from "./okou-page/chat-draft.ts";
import {
  createCarouselSelection,
  type CarouselSwipePoint,
} from "./carousel.ts";

function createFeatureGuideSelection(itemCount: number) {
  const carousel = createCarouselSelection();
  const step$ = state(0);
  const selectItem$ = command(({ set }, index: number) => {
    set(carousel.select$, index);
    set(step$, 0);
  });
  return {
    itemIndex$: carousel.index$,
    stepIndex$: computed((get) => {
      return get(step$);
    }),
    selectItem$,
    selectStep$: command(({ set }, index: number) => {
      set(step$, index);
    }),
    beginSwipe$: carousel.beginSwipe$,
    endSwipe$: command(({ set }, point: CarouselSwipePoint | null) => {
      const next = set(carousel.endSwipe$, point, itemCount);
      if (next !== null) {
        set(step$, 0);
      }
    }),
  };
}

export interface FeatureGuideSnapshot {
  readonly owner: string;
  readonly edition: FeatureGuideEdition;
  readonly preview: boolean;
  readonly selection: ReturnType<typeof createFeatureGuideSelection>;
}

const dismissed$ = state<{
  readonly owner: string;
  readonly editionId: string;
  readonly preview: boolean;
} | null>(null);
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
      [200],
    );
    if (!response.body.edition) {
      return null;
    }
    return {
      owner,
      edition: response.body.edition,
      preview: response.body.preview === true,
      selection: createFeatureGuideSelection(
        response.body.edition.content.items.length,
      ),
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
    get(agentChatPageActive$) &&
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

// The App owns acknowledgements so quick dismissal does not abort them.
export const dismissFeatureGuide$ = command(
  async ({ set }, snapshot: FeatureGuideSnapshot, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(closeFeatureGuide$, snapshot);
    await set(persistFeatureGuideSeen$, snapshot, signal);
  },
);

export const tryFeatureGuidePrompt$ = command(
  async (
    { get, set },
    snapshot: FeatureGuideSnapshot,
    prompt: string,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    if (get(authenticatedSessionKey$) !== snapshot.owner) {
      return;
    }
    const draft = get(talkDraft$);
    // A guide must never replace work the user started while its request was pending.
    if (get(draft.input$).trim() || get(draft.attachments$).length > 0) {
      return;
    }
    set(draft.setInput$, prompt);
    await set(dismissFeatureGuide$, snapshot, signal);
  },
);
