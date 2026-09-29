import {
  isBuiltInModelProviderType,
  type OrgModelPolicy,
} from "@okouai/api-contracts/contracts/model-providers";
import { getMemberModelPolicyRoute } from "@okouai/api-contracts/contracts/member-model-policy";
import { getModelRunOptions } from "@okouai/api-contracts/contracts/model-run-options";
import { useTranslation } from "react-i18next";

import { formatLocalizedNumber } from "../../../i18n/format.ts";

/**
 * Fast's cost on the policy's route. Multipliers come from the model's run
 * options so the displayed cost stays aligned with the effective provider.
 */
export function ModelFastImpact({ policy }: { policy: OrgModelPolicy }) {
  const { t } = useTranslation();
  const route = getMemberModelPolicyRoute(policy);
  const builtIn = isBuiltInModelProviderType(route.providerType);
  const provider = route.runtimeProviderType;
  const fast = getModelRunOptions(policy.model).fast;
  if (!fast) {
    return null;
  }

  let multiplier: number;
  if (builtIn) {
    multiplier = fast.builtInCreditMultiplier;
  } else if (provider === "codex-oauth-token") {
    multiplier = fast.chatGptUsageMultiplier;
  } else if (provider === "openai-api-key") {
    multiplier = fast.apiCostMultiplier;
  } else {
    return t(($) => {
      return $.settings.models.picker.fastImpact.providerUsage;
    });
  }
  return t(
    ($) => {
      return $.settings.models.picker.fastImpact.creditCost;
    },
    { multiplier: formatLocalizedNumber(multiplier) },
  );
}
