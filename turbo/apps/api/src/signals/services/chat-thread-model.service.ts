import type { Db } from "../external/db";
import {
  resolveDefaultModelFirstPin,
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

export async function resolveRequiredDefaultChatThreadModelPin(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
  },
  orgPlanCapabilities?: OrgPlanCapabilities | null,
): Promise<DefaultModelFirstPin> {
  const pin = await resolveDefaultModelFirstPin(
    db,
    args.orgId,
    args.userId,
    "member",
    orgPlanCapabilities,
  );
  if (!pin.selectedModel) {
    throw new Error("A model selection is required");
  }
  return pin;
}
