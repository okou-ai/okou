import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { ConditionalComposerDraft } from "@okouai/api-contracts/contracts/composer-draft";
import { computed, type Computed } from "ccstate";

import { authContext$ } from "../auth/auth-context";
import type { BodyResult } from "../context/request";
import { createUserFeatureSwitchContext } from "./feature-switches.service";
import { projectReferences } from "./project-reference.service";

const identity$ = computed((get) => {
  const auth = get(authContext$);
  return auth.orgId ? { orgId: auth.orgId, userId: auth.userId } : null;
});
const featureContext$ = createUserFeatureSwitchContext(identity$);

export const conditionalComposerDraftsEnabled$ = computed(async (get) => {
  const context = await get(featureContext$);
  return (
    context !== null &&
    isFeatureEnabled(FeatureSwitchKey.ConditionalComposerDrafts, context)
  );
});

type ConditionalDraftInput =
  | Extract<BodyResult<ConditionalComposerDraft>, { readonly ok: false }>
  | {
      readonly ok: true;
      readonly data: ConditionalComposerDraft;
      readonly referencesAllowed: boolean;
    };

export function createConditionalDraftInput(
  body$: Computed<Promise<BodyResult<ConditionalComposerDraft>>>,
): Computed<Promise<ConditionalDraftInput>> {
  return computed(async (get) => {
    const body = await get(body$);
    if (!body.ok) {
      return body;
    }
    const context = await get(featureContext$);
    return {
      ...body,
      referencesAllowed:
        projectReferences(body.data.draft.draftUserMessage).length === 0 ||
        (context !== null &&
          isFeatureEnabled(FeatureSwitchKey.SingleAgent, context)),
    };
  });
}
