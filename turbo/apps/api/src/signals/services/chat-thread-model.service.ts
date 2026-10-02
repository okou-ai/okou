import { command } from "ccstate";

import {
  resolveDefaultModelFirstPin$,
  type DefaultModelFirstPin,
  type ModelFirstPin,
  type ModelSelectionBootstrap,
} from "./model-selection.service";
import type { OrgPlanCapabilities } from "./org-plan-entitlement-read.service";

export function chatThreadModelPinColumns(pin: ModelFirstPin): {
  readonly modelProviderId: null;
  readonly modelProviderType: null;
  readonly modelProviderCredentialScope: null;
  readonly selectedModel: string | null;
} {
  return {
    modelProviderId: null,
    modelProviderType: null,
    modelProviderCredentialScope: null,
    selectedModel: pin.selectedModel,
  };
}

export const resolveRequiredDefaultChatThreadModelPin$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly modelBootstrap?: ModelSelectionBootstrap;
    },
    orgPlanCapabilities?: OrgPlanCapabilities | null,
    abortSignal?: AbortSignal,
  ): Promise<DefaultModelFirstPin> => {
    const pin = await set(
      resolveDefaultModelFirstPin$,
      {
        orgId: args.orgId,
        userId: args.userId,
        defaultSource: undefined,
        orgPlanCapabilities: orgPlanCapabilities,
        modelBootstrap: args.modelBootstrap,
      },
      abortSignal,
    );
    abortSignal?.throwIfAborted();
    if (!pin.selectedModel) {
      throw new Error("A model selection is required");
    }
    return pin;
  },
);
