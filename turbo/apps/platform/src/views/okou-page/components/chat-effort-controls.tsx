import { Field } from "@base-ui/react/field";
import {
  type ReasoningEffort,
  withModelReasoningEffort,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { Switch } from "@okouai/ui";
import { useGet, useLastResolved } from "ccstate-react";
import { Zap } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { featureSwitch$ } from "../../../signals/external/feature-switch.ts";
import { modelCatalog$ } from "../../../signals/external/model-catalog.ts";
import { availableRunModels$ } from "../../../signals/external/run-models.ts";
import {
  availableChatReasoningEfforts,
  effectiveChatReasoningEffort,
} from "../../../signals/okou-page/model-reasoning-effort.ts";
import { ChatEffortSlider } from "./chat-effort-slider.tsx";
import type { ModelProviderSelection } from "./model-provider-picker.tsx";

export function useChatEffort(
  selection: ModelProviderSelection | null | undefined,
) {
  const models = useLastResolved(availableRunModels$);
  const catalog = useLastResolved(modelCatalog$);
  const features = useGet(featureSwitch$);
  const codexExecution = features[FeatureSwitchKey.CodexExecution];
  const runModel = models?.models.find((entry) => {
    return entry.model === selection?.selectedModel;
  });
  return {
    efforts: availableChatReasoningEfforts(
      selection,
      runModel,
      catalog,
      codexExecution,
    ),
    effort: effectiveChatReasoningEffort(
      selection,
      runModel,
      catalog,
      codexExecution,
    ),
  };
}

/**
 * Each model keeps its own vocabulary, because the levels are the ones that
 * model actually documents: Codex runs `low`/`medium`/`high`/`xhigh`/`max`/
 * `ultra`, Claude runs `low`/`medium`/`high`/`extra`/`max`/`ultracode`.
 * Renaming them to a house scale would tell a user something their model does
 * not say. The only thing this changes is the case: a level is a label in the
 * interface, not the raw enum it happens to be on the wire. Each label is
 * spelled out rather than derived, because a compound level such as `xhigh`
 * does not survive a mechanical capitalisation (`Xhigh`).
 */
const CHAT_EFFORT_LABELS: Readonly<Record<ReasoningEffort, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "xHigh",
  extra: "Extra",
  max: "Max",
  ultra: "Ultra",
  ultracode: "Ultracode",
};

export function formatChatEffort(effort: ReasoningEffort) {
  return CHAT_EFFORT_LABELS[effort];
}

/**
 * Keep each end's benefit and usage visible together. Only personal
 * subscription routes expose effort levels, so usage is the subscription's
 * allowance.
 */
function EffortScaleLabels() {
  const { t } = useTranslation();
  return (
    <div className="pointer-events-none mb-2 flex select-none items-start justify-between gap-3 text-xs text-muted-foreground">
      <div className="flex flex-col gap-0.5">
        <span>
          {t(($) => {
            return $.settings.models.picker.effortScale.faster;
          })}
        </span>
        <span className="text-[11px] text-gray-700">
          {t(($) => {
            return $.settings.models.picker.effortScale.lowerUsage;
          })}
        </span>
      </div>
      <div className="flex flex-col gap-0.5 text-right">
        <span>
          {t(($) => {
            return $.settings.models.picker.effortScale.smarter;
          })}
        </span>
        <span className="text-[11px] text-gray-700">
          {t(($) => {
            return $.settings.models.picker.effortScale.higherUsage;
          })}
        </span>
      </div>
    </div>
  );
}

/**
 * The effort bar. The composer's model panel trigger already names the level
 * and the bar carries it for assistive technology, so no label/value row sits
 * above it. Renders nothing for a model that has no effort levels.
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
  const displayValue = formatChatEffort(value);
  const index = efforts.findIndex((effort) => {
    return effort === value;
  });
  return (
    <div className="flex flex-col px-2 py-3">
      {index !== -1 ? (
        <>
          <EffortScaleLabels />
          <ChatEffortSlider
            steps={efforts.length}
            value={index}
            disabled={disabled}
            label={label}
            valueText={displayValue}
            onValueChange={(next) => {
              const effort = efforts[next];
              const model = selection.selectedModel;
              if (effort !== undefined && model !== null) {
                onChange({
                  ...selection,
                  modelSettings: withModelReasoningEffort(
                    selection.modelSettings,
                    { model, effort },
                  ),
                });
              }
            }}
          />
        </>
      ) : null}
    </div>
  );
}

/**
 * Show Fast's cost before the user enables it, including as the
 * switch's accessible description.
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
    return $.settings.models.picker.fastMode;
  });
  return (
    <Field.Root className="flex items-center justify-between gap-3 px-2 py-3">
      <div className="flex min-w-0 items-start gap-2">
        <Zap
          size={18}
          fill="currentColor"
          className="mt-px shrink-0 text-amber-600 dark:text-amber-300"
          aria-hidden="true"
        />
        <div className="flex min-w-0 flex-col gap-0.5">
          <Field.Label className="text-[13px]">{label}</Field.Label>
          <Field.Description className="text-[11px] text-gray-700">
            {fastImpact}
          </Field.Description>
        </div>
      </div>
      <Switch
        size="compact"
        checked={selection.codexServiceTier === "fast"}
        onCheckedChange={(fast) => {
          onChange({
            ...selection,
            codexServiceTier: fast ? "fast" : undefined,
          });
        }}
        disabled={disabled}
      />
    </Field.Root>
  );
}
