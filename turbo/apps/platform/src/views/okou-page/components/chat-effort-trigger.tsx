import { isMemberModelPolicyConfigurable } from "@okouai/api-contracts/contracts/member-model-policy";
import { isCodexFastModeModel } from "@okouai/api-contracts/contracts/model-providers";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@okouai/ui";
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
  const displayValue = formatChatEffort(effort);
  const fast = value.codexServiceTier === "fast";
  const disabled =
    policy === undefined || !isMemberModelPolicyConfigurable(policy);
  const fastAvailable =
    codexFastModeEnabled &&
    policy !== undefined &&
    isMemberModelPolicyConfigurable(policy) &&
    isCodexFastModeModel(policy.model);
  return (
    <Popover>
      {/* A real composer control, not a bare trigger: the shared button owns
            the radius, height, hover and focus ring the rest of the row has. */}
      <PopoverTrigger asChild>
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
      </PopoverTrigger>
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
  );
}
