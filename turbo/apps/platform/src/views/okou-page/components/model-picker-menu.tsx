import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { DropdownMenuRadioGroup, DropdownMenuRadioItem } from "@okouai/ui";
import type { SupportedRunModel } from "@okouai/api-contracts/contracts/model-providers";
import { useTranslation } from "react-i18next";
import type { ModelProviderSelection } from "./model-provider-picker.tsx";

interface ModelPickerMenuOption {
  readonly model: SupportedRunModel;
  readonly label: string;
  readonly content: ReactNode;
  readonly disabled: boolean;
}

/**
 * The composer menu's chat models. Picking one closes the menu; choosing the
 * checked model again keeps its effort and Fast.
 */
export function ModelPickerMenuContent({
  value,
  options,
  onChange,
}: {
  value: ModelProviderSelection | null;
  options: readonly ModelPickerMenuOption[];
  onChange: (selection: ModelProviderSelection) => void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenuRadioGroup
      value={value?.selectedModel ?? null}
      className="-my-1 flex max-h-[284px] flex-col gap-0.5 overflow-y-auto overscroll-contain py-1"
    >
      {options.map((option) => {
        return (
          <DropdownMenuRadioItem
            key={option.model}
            value={option.model}
            label={option.label}
            disabled={option.disabled}
            closeOnClick
            className="w-full shrink-0 pr-8 text-[13px] font-normal text-foreground"
            onClick={() => {
              onChange(
                value?.selectedModel === option.model
                  ? value
                  : { selectedModel: option.model },
              );
            }}
          >
            {option.content}
            {value?.selectedModel === option.model && (
              <Check
                size={15}
                aria-hidden="true"
                className="absolute right-2"
              />
            )}
          </DropdownMenuRadioItem>
        );
      })}
      {options.length === 0 && (
        <p className="px-2 py-2 text-sm text-muted-foreground">
          {t(($) => {
            return $.settings.models.picker.noConfiguredModels;
          })}
        </p>
      )}
    </DropdownMenuRadioGroup>
  );
}
