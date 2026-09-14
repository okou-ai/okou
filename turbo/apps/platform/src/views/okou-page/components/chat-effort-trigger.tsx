import { isCodexFastModeModel } from "@okouai/api-contracts/contracts/model-providers";
import { Popover, PopoverContent, PopoverTrigger, cn } from "@okouai/ui";
import { useGet, useLastResolved } from "ccstate-react";
import { Zap } from "lucide-react";
import { useTranslation } from "react-i18next";

import { codexFastModeEnabled$ } from "../../../signals/external/feature-switch.ts";
import { orgModelPolicies$ } from "../../../signals/external/org-model-policies.ts";
import {
  ChatEffortSettings,
  ChatFastSetting,
  formatChatEffort,
  useChatEffort,
} from "./chat-effort-controls.tsx";
import { ModelFastImpact } from "./model-fast-impact.tsx";
import type { ModelProviderSelection } from "./model-provider-picker.tsx";

/**
 * The composer's effort control.
 *
 * Effort and Fast used to sit two surfaces deep inside the model picker, and
 * the composer showed neither at rest. This puts the chosen effort on the
 * composer itself, level with the model rather than behind it, and opens the
 * same two rows the chat-settings page shows.
 *
 * The bolt is not decoration: it appears only once Fast is on, so an icon in
 * that position always means something. The chip renders nothing at all for a
 * model that has no effort levels, which keeps it from becoming an empty
 * control on models that cannot use it.
 */
export function ChatEffortTrigger({
  value,
  onChange,
  triggerClassName,
}: {
  value: ModelProviderSelection;
  onChange: (selection: ModelProviderSelection) => void;
  triggerClassName: string;
}) {
  const { t } = useTranslation();
  const { efforts, effort } = useChatEffort(value);
  const codexFastModeEnabled = useGet(codexFastModeEnabled$);
  const policies = useLastResolved(orgModelPolicies$);
  const policy = policies?.policies.find((entry) => {
    return entry.model === value.selectedModel;
  });
  if (efforts.length === 0 || effort === undefined) {
    return null;
  }
  const label = t(($) => {
    return $.settings.models.picker.effort;
  });
  const displayValue = formatChatEffort(value.selectedModel, effort);
  const fast = value.codexServiceTier === "fast";
  const disabled = policy?.routeStatus !== "valid";
  const fastAvailable =
    codexFastModeEnabled &&
    policy !== undefined &&
    policy.routeStatus === "valid" &&
    isCodexFastModeModel(policy.model);
  return (
    <>
      <Popover>
        <PopoverTrigger
          aria-label={`${label}, ${displayValue ?? effort}`}
          className={cn(triggerClassName, "flex items-center gap-1.5")}
        >
          {fast ? (
            <Zap
              size={15}
              fill="currentColor"
              className="text-amber-600 dark:text-amber-300"
              aria-hidden="true"
            />
          ) : null}
          {displayValue}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-63 p-0">
          <ChatEffortSettings
            selection={value}
            disabled={disabled}
            onChange={onChange}
          />
          {fastAvailable ? (
            <ChatFastSetting
              selection={value}
              disabled={disabled}
              fastImpact={<ModelFastImpact policy={policy} />}
              onChange={onChange}
            />
          ) : null}
        </PopoverContent>
      </Popover>
      {/* The separator belongs to this control rather than to the row, so a
          model without effort levels does not leave a rule behind. */}
      <div className="mx-0 h-5 w-px bg-divider/60 sm:mx-0.5" />
    </>
  );
}
