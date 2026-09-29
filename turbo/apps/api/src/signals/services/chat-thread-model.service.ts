import { command } from "ccstate";
import {
  resolveDefaultModelFirstPin$,
  type DefaultModelFirstPin,
  type ModelFirstPin,
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
    },
    orgPlanCapabilities?: OrgPlanCapabilities | null,
    abortSignal?: AbortSignal,
  ): Promise<DefaultModelFirstPin> => {
    const pin = await set(
      resolveDefaultModelFirstPin$,
      { orgId: args.orgId, userId: args.userId, orgPlanCapabilities },
      abortSignal,
    );
    if (!pin.selectedModel) {
      throw new Error("A model selection is required");
    }
    return pin;
  },
);
