import { isMemberRunModelConfigurable } from "@okouai/api-contracts/contracts/member-run-model";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@okouai/ui";
import { useLastResolved } from "ccstate-react";
import { Zap } from "lucide-react";
import { useTranslation } from "react-i18next";

import { modelCatalog$ } from "../../../signals/external/model-catalog.ts";
import { availableRunModels$ } from "../../../signals/external/run-models.ts";
import { isRunModelFastModeAvailable } from "../../../signals/okou-page/model-default-selection.ts";
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
  const models = useLastResolved(availableRunModels$);
  const catalog = useLastResolved(modelCatalog$);
  const runModel = models?.models.find((entry) => {
    return entry.model === value.selectedModel;
  });
  if (efforts.length === 0 || effort === undefined) {
    return null;
  }
  const label = t(($) => {
    return $.settings.models.picker.effort;
  });
  const displayValue = formatChatEffort(effort);
  const fast = value.codexServiceTier === "fast";
  const disabled =
    runModel === undefined || !isMemberRunModelConfigurable(runModel, catalog);
  const fastAvailable = isRunModelFastModeAvailable(runModel, catalog);
  return (
    <Popover>
      {/* A real composer control, not a bare trigger: the shared button owns
            the radius, height, hover and focus ring the rest of the row has. */}
      <PopoverTrigger
        render={
          <Button
            variant="quiet"
            size="sm"
            aria-label={`${label}, ${displayValue}`}
            className={triggerClassName}
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
          </Button>
        }
      />
      {/* Above the control and aligned to its trailing edge. The control sits
            in a right-aligned row, so its leading edge moves as the level's name
            changes width while its trailing edge does not -- anchoring there is
            what keeps the panel still. `side="top"` follows the composer's other
            popovers, which all open upward away from the message field.

            The rows bring their own padding, so the card adds only the little
            that puts the label 14px from the top edge. Effort and Fast are one
            decision about how this message runs, so they are separated by space
            rather than by a rule. */}
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        className="w-63 px-1.5 py-0.5"
      >
        <ChatEffortSettings
          selection={value}
          disabled={disabled}
          onChange={onChange}
        />
        {fastAvailable && runModel ? (
          <ChatFastSetting
            selection={value}
            disabled={disabled}
            fastImpact={<ModelFastImpact runModel={runModel} />}
            onChange={onChange}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
