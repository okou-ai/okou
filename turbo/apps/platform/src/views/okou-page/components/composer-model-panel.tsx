import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { ScrollArea } from "@base-ui/react/scroll-area";
import { isMemberRunModelConfigurable } from "@okouai/api-contracts/contracts/member-run-model";
import {
  Button,
  MENU_ROW_HEIGHT_CLASS,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RadioGroup,
  ScrollBar,
  cn,
} from "@okouai/ui";
import { useLastLoadable, useLastResolved } from "ccstate-react";
import { ChevronDown, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { modelCatalog$ } from "../../../signals/external/model-catalog.ts";
import { availableRunModels$ } from "../../../signals/external/run-models.ts";
import { isRunModelFastModeAvailable } from "../../../signals/okou-page/model-default-selection.ts";
import { SCROLL_FADE_Y_WHEN_OVERFLOWING } from "../scroll-fade.ts";
import {
  ChatEffortSettings,
  ChatFastSetting,
  formatChatEffort,
  useChatEffort,
} from "./chat-effort-controls.tsx";
import { ModelFastImpact } from "./model-fast-impact.tsx";
import {
  ModelFirstRunModelRowContent,
  ModelFirstTriggerLabel,
  resolveModelFirstModelPickerState,
  useExplicitModelSelectionChange,
  type ModelProviderSelection,
} from "./model-provider-picker.tsx";

interface ComposerModelPanelProps {
  value: ModelProviderSelection;
  onChange: (selection: ModelProviderSelection | null) => void;
  placeholder: string;
  triggerClassName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The model list, then the effort and Fast rows for the checked model.
 *
 * The chat model, its effort and its speed are one decision about how the next
 * message runs, so they share one popover. A popover rather than a menu:
 * changing effort or Fast is not a command that finishes the interaction, so
 * nothing in here closes the panel. Escape, a press outside or the trigger
 * closes it.
 */
function ComposerModelPanelBody({
  value,
  onChange,
  placeholder,
}: Pick<ComposerModelPanelProps, "value" | "onChange" | "placeholder">) {
  const { t } = useTranslation();
  const modelsLoadable = useLastLoadable(availableRunModels$);
  const catalogLoadable = useLastLoadable(modelCatalog$);
  const modelsResponse = useLastResolved(availableRunModels$);
  const catalog = useLastResolved(modelCatalog$);
  const changeModel = useExplicitModelSelectionChange({ value, onChange });
  const chatModelsLabel = t(($) => {
    return $.settings.models.picker.chatModels;
  });
  if (modelsResponse === undefined || catalog === undefined) {
    return (
      <p role="status" className="px-2 py-2 text-sm text-muted-foreground">
        {modelsLoadable.state === "loading" ||
        catalogLoadable.state === "loading"
          ? t(($) => {
              return $.settings.models.picker.loading;
            })
          : t(($) => {
              return $.settings.models.picker.loadError;
            })}
      </p>
    );
  }
  const state = resolveModelFirstModelPickerState({
    value,
    modelsResponse,
    catalog,
    placeholder,
    fastLabel: t(($) => {
      return $.settings.models.picker.fast;
    }),
  });
  const selectedRunModel = state.models.find((runModel) => {
    return runModel.model === value.selectedModel;
  });
  const configurable =
    selectedRunModel !== undefined &&
    isMemberRunModelConfigurable(selectedRunModel);
  const fastAvailable = isRunModelFastModeAvailable(selectedRunModel);
  return (
    <>
      {/*
       * Only the model list scrolls; the effort rows below stay put. The list
       * needs no visible heading: the trigger already names the model, and the
       * radio group and popover carry the "Chat models" label for assistive
       * tech. The list shrinks before the popover outgrows
       * `--available-height`, and `-mr-1` lands the overlay track on the
       * popover's own edge instead of over the rows, the way shadcn's Base UI
       * Scroll Area places it.
       */}
      <ScrollArea.Root className="group relative -mr-1 flex min-h-0 flex-col">
        <ScrollArea.Viewport
          data-slot="scroll-area-viewport"
          className={cn(
            "max-h-[284px] min-h-0 overscroll-contain pr-1 focus:outline-none",
            SCROLL_FADE_Y_WHEN_OVERFLOWING,
          )}
        >
          <ScrollArea.Content>
            <RadioGroup
              aria-label={chatModelsLabel}
              value={state.selection?.selectedModel ?? null}
              onValueChange={(model: string) => {
                changeModel(
                  value.selectedModel === model
                    ? value
                    : { selectedModel: model },
                );
              }}
              className="flex flex-col gap-0.5 py-1"
            >
              {state.models.length === 0 && (
                <p className="px-2 py-2 text-sm text-muted-foreground">
                  {t(($) => {
                    return $.settings.models.picker.noConfiguredModels;
                  })}
                </p>
              )}
              {state.models.map((runModel) => {
                const selected =
                  state.selection?.selectedModel === runModel.model;
                return (
                  <RadioPrimitive.Root
                    key={runModel.model}
                    value={runModel.model}
                    disabled={!isMemberRunModelConfigurable(runModel)}
                    nativeButton
                    render={<button type="button" />}
                    className={cn(
                      "relative flex w-full shrink-0 cursor-default select-none items-center rounded-lg px-2 pr-8 text-left font-normal text-foreground outline-none transition-colors hover:bg-state-hover focus-visible:bg-state-hover data-disabled:pointer-events-none data-disabled:opacity-50",
                      MENU_ROW_HEIGHT_CLASS,
                    )}
                  >
                    <ModelFirstRunModelRowContent
                      runModel={runModel}
                      selected={selected}
                      showSelectedIndicator
                    />
                  </RadioPrimitive.Root>
                );
              })}
            </RadioGroup>
          </ScrollArea.Content>
        </ScrollArea.Viewport>
        <ScrollBar data-testid="composer-model-panel-scrollbar" />
      </ScrollArea.Root>
      {selectedRunModel !== undefined && (
        <ComposerModelPanelOptions
          value={value}
          onChange={onChange}
          disabled={!configurable}
          fastImpact={
            fastAvailable ? (
              <ModelFastImpact runModel={selectedRunModel} />
            ) : null
          }
        />
      )}
    </>
  );
}

function ComposerModelPanelOptions({
  value,
  onChange,
  disabled,
  fastImpact,
}: {
  value: ModelProviderSelection;
  onChange: (selection: ModelProviderSelection) => void;
  disabled: boolean;
  fastImpact: ReactNode;
}) {
  const { efforts } = useChatEffort(value);
  if (efforts.length === 0 && fastImpact === null) {
    return null;
  }
  return (
    <div className="mt-1 shrink-0 border-t border-divider pt-0.5">
      <ChatEffortSettings
        selection={value}
        disabled={disabled}
        onChange={onChange}
      />
      {fastImpact !== null && (
        <ChatFastSetting
          selection={value}
          disabled={disabled}
          fastImpact={fastImpact}
          onChange={onChange}
        />
      )}
    </div>
  );
}

/**
 * The composer trigger names the model and then the effort it will run at, with
 * the bolt once Fast is on, so the choice is readable without opening the panel.
 */
function ComposerModelPanelTriggerLabel({
  value,
  placeholder,
}: Pick<ComposerModelPanelProps, "value" | "placeholder">) {
  const { t } = useTranslation();
  const { effort } = useChatEffort(value);
  const fast = value.codexServiceTier === "fast";
  return (
    <span className="flex min-w-0 items-center gap-1">
      <ModelFirstTriggerLabel
        selection={value}
        placeholder={placeholder}
        mobileIcon
        fastLabel={t(($) => {
          return $.settings.models.picker.fast;
        })}
        fastShownByCaller
      />
      {effort !== undefined && (
        <span className="hidden shrink-0 composer-wide:inline">
          · {formatChatEffort(effort)}
        </span>
      )}
      {fast && (
        <Zap
          size={14}
          fill="currentColor"
          className="hidden shrink-0 text-amber-600 composer-wide:block dark:text-amber-300"
          aria-hidden="true"
        />
      )}
    </span>
  );
}

export function ComposerModelPanel({
  value,
  onChange,
  placeholder,
  triggerClassName,
  open,
  onOpenChange,
}: ComposerModelPanelProps) {
  const { t } = useTranslation();
  const { effort } = useChatEffort(value);
  const catalog = useLastResolved(modelCatalog$);
  const fastLabel = t(($) => {
    return $.settings.models.picker.fast;
  });
  const triggerAriaLabel = [
    catalog?.displayName(value.selectedModel) ?? value.selectedModel,
    effort === undefined ? undefined : formatChatEffort(effort),
    value.codexServiceTier === "fast" ? fastLabel : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
      }}
    >
      <PopoverTrigger
        render={<Button variant="ghost" />}
        aria-label={triggerAriaLabel}
        className={cn(
          "h-9 w-full justify-start gap-2 rounded-lg text-sm font-normal",
          triggerClassName,
        )}
      >
        <span data-slot="select-value" className="min-w-0">
          <ComposerModelPanelTriggerLabel
            value={value}
            placeholder={placeholder}
          />
        </span>
        <span data-slot="select-icon">
          <ChevronDown
            size={16}
            className="shrink-0 opacity-50"
            aria-hidden="true"
          />
        </span>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        collisionPadding={8}
        aria-label={t(($) => {
          return $.settings.models.picker.chatModels;
        })}
        className="flex max-h-[var(--available-height)] w-[304px] max-w-[calc(100vw-16px)] flex-col p-1"
      >
        <ComposerModelPanelBody
          value={value}
          onChange={onChange}
          placeholder={placeholder}
        />
      </PopoverContent>
    </Popover>
  );
}
