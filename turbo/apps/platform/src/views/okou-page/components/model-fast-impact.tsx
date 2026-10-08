import type { AvailableRunModel } from "@okouai/api-contracts/contracts/model-providers";
import { getModelRunOptions } from "@okouai/api-contracts/contracts/model-run-options";
import { useTranslation } from "react-i18next";
import { formatLocalizedNumber } from "../../../i18n/format.ts";

/** Fast consumes the selected personal subscription's usage allowance. */
export function ModelFastImpact({ runModel }: { runModel: AvailableRunModel }) {
  const { t } = useTranslation();
  const route = runModel.memberEffective;
  const fast = getModelRunOptions(runModel.model).fast;
  if (!fast) {
    return null;
  }
  if (route.runtimeProviderType !== "codex-oauth-token") {
    return t(($) => {
      return $.settings.models.picker.fastImpact.providerUsage;
    });
  }
  return t(
    ($) => {
      return $.settings.models.picker.fastImpact.subscriptionUsage;
    },
    {
      multiplier: formatLocalizedNumber(fast.chatGptUsageMultiplier),
    },
  );
}
