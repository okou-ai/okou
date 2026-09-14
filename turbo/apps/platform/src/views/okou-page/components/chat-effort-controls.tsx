import { withModelReasoningEffort } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import {
  Switch,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui";
import { useGet, useLastResolved } from "ccstate-react";
import { Zap } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { featureSwitch$ } from "../../../signals/external/feature-switch.ts";
import { orgModelPolicies$ } from "../../../signals/external/org-model-policies.ts";
import {
  availableChatReasoningEfforts,
  effectiveChatReasoningEffort,
} from "../../../signals/okou-page/model-reasoning-effort.ts";
import { ChatEffortSlider } from "./chat-effort-slider.tsx";
import type { ModelProviderSelection } from "./model-provider-picker.tsx";

export function useChatEffort(
  selection: ModelProviderSelection | null | undefined,
) {
  const switches = useGet(featureSwitch$);
  const policies = useLastResolved(orgModelPolicies$);
  const policy = policies?.policies.find((entry) => {
    return entry.model === selection?.selectedModel;
  });
  return {
    efforts: availableChatReasoningEfforts(selection, switches, policy),
    effort: effectiveChatReasoningEffort(selection, switches, policy),
  };
}

/**
 * Claude names its levels as words and Codex names them as identifiers, so only
 * the Claude vocabulary is title-cased.
 */
export function formatChatEffort(model: string | undefined, effort: string) {
  return model?.startsWith("claude-")
    ? effort.charAt(0).toUpperCase() + effort.slice(1)
    : effort;
}

/**
 * The effort row: the label, the selected step in the user's words, and the
 * bar. Renders nothing for a model that has no effort levels.
 */
export function ChatEffortSettings({
  selection,
  disabled,
  onChange,
}: {
  selection: ModelProviderSelection;
  disabled: boolean;
  onChange: (selection: ModelProviderSelection) => void;
}) {
  const { t } = useTranslation();
  const { efforts, effort: value } = useChatEffort(selection);
  const label = t(($) => {
    return $.settings.models.picker.effort;
  });
  if (efforts.length === 0 || value === undefined) {
    return null;
  }
  const displayValue = formatChatEffort(selection.selectedModel, value);
  const index = efforts.findIndex((effort) => {
    return effort === value;
  });
  return (
    <div className="flex flex-col gap-3 border-b border-border/60 px-2 py-4">
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span>{label}</span>
        <span className="font-medium text-foreground">{displayValue}</span>
      </div>
      {index !== -1 ? (
        <ChatEffortSlider
          steps={efforts.length}
          value={index}
          disabled={disabled}
          label={label}
          valueText={displayValue}
          onValueChange={(next) => {
            const effort = efforts[next];
            if (effort !== undefined) {
              onChange({
                ...selection,
                modelSettings: withModelReasoningEffort(
                  selection.modelSettings,
                  { model: selection.selectedModel, effort },
                ),
              });
            }
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The Fast row. The bolt is the same icon and treatment the model rows use for
 * Fast and it carries the speed and credit impact in its tooltip; spelling that
 * out underneath put two lines of small print in a row the user reads as a
 * single switch.
 */
export function ChatFastSetting({
  selection,
  disabled,
  fastImpact,
  onChange,
}: {
  selection: ModelProviderSelection;
  disabled: boolean;
  fastImpact: ReactNode;
  onChange: (selection: ModelProviderSelection) => void;
}) {
  const { t } = useTranslation();
  const label = t(($) => {
    return $.settings.models.picker.fast;
  });
  return (
    <div className="flex items-center justify-between gap-3 px-2 py-4">
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger className="flex cursor-default items-center gap-2 text-[13px]">
            <Zap
              size={18}
              fill="currentColor"
              className="text-amber-600 dark:text-amber-300"
              aria-hidden="true"
            />
            {label}
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {fastImpact}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <Switch
        size="compact"
        aria-label={label}
        checked={selection.codexServiceTier === "fast"}
        onCheckedChange={(fast) => {
          onChange({
            ...selection,
            codexServiceTier: fast ? "fast" : undefined,
          });
        }}
        disabled={disabled}
      />
    </div>
  );
}
