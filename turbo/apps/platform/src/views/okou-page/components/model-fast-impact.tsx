import {
  isBuiltInModelProviderType,
  type OrgModelPolicy,
} from "@okouai/api-contracts/contracts/model-providers";
import { getMemberModelPolicyRoute } from "@okouai/api-contracts/contracts/member-model-policy";
import { getModelRunOptions } from "@okouai/api-contracts/contracts/model-run-options";
import { useTranslation } from "react-i18next";

import { formatLocalizedNumber } from "../../../i18n/format.ts";

/**
 * Fast's speed and cost on the policy's route. Every multiplier comes from the
 * model's run options, so a model whose Fast tier costs or gains differently is
 * configured there rather than here.
 */
export function ModelFastImpact({ policy }: { policy: OrgModelPolicy }) {
  const { t } = useTranslation();
  const route = getMemberModelPolicyRoute(policy);
  const builtIn = isBuiltInModelProviderType(route.providerType);
  const provider = route.runtimeProviderType;
  const fast = getModelRunOptions(policy.model).fast;
  let speed = t(($) => {
    return $.settings.models.picker.fastImpact.providerSpeed;
  });
  if (
    provider === "codex-oauth-token" &&
    fast?.chatGptSpeedMultiplier !== undefined
  ) {
    speed = t(
      ($) => {
        return $.settings.models.picker.fastImpact.modelSpeed;
      },
      { multiplier: formatLocalizedNumber(fast.chatGptSpeedMultiplier) },
    );
  } else if (provider === "openai-api-key") {
    speed =
      fast?.apiSpeedMultiplier === undefined
        ? t(($) => {
            return $.settings.models.picker.fastImpact.fasterResponses;
          })
        : t(
            ($) => {
              return $.settings.models.picker.fastImpact.apiSpeed;
            },
            { multiplier: formatLocalizedNumber(fast.apiSpeedMultiplier) },
          );
  }

  let usage = t(($) => {
    return $.settings.models.picker.fastImpact.providerUsage;
  });
  if (fast && builtIn) {
    usage = t(
      ($) => {
        return $.settings.models.picker.fastImpact.okouCredits;
      },
      { multiplier: formatLocalizedNumber(fast.builtInCreditMultiplier) },
    );
  } else if (fast && provider === "codex-oauth-token") {
    usage = t(
      ($) => {
        return $.settings.models.picker.fastImpact.chatGptUsage;
      },
      { multiplier: formatLocalizedNumber(fast.chatGptUsageMultiplier) },
    );
  } else if (fast && provider === "openai-api-key") {
    usage = t(
      ($) => {
        return $.settings.models.picker.fastImpact.apiCost;
      },
      { multiplier: formatLocalizedNumber(fast.apiCostMultiplier) },
    );
  }
  return t(
    ($) => {
      return $.settings.models.picker.fastImpact.summary;
    },
    { speed, usage },
  );
}
