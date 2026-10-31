import { useTranslation } from "react-i18next";
import { Button, Toggle, ToggleGroup } from "@okouai/ui";
import {
  FileText,
  Globe,
  Image,
  Presentation,
  Search,
  Users,
} from "lucide-react";
import {
  ONBOARDING_OUTPUT_FORMATS,
  type OnboardingOutputFormat,
} from "../../signals/onboarding/onboarding-output-format.ts";

const OUTPUT_ICONS = Object.freeze({
  image: Image,
  presentation: Presentation,
  website: Globe,
  report: FileText,
  research: Search,
  people: Users,
});

export function OnboardingOutputFormats({
  output,
  onSelect,
  disabled,
}: {
  readonly output: OnboardingOutputFormat | null;
  readonly onSelect: (format: OnboardingOutputFormat | null) => void;
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.onboarding.sourcesFirst.outputFormats;
    },
    { returnObjects: true },
  );

  return (
    <section
      className="@container mt-6"
      aria-labelledby="onboarding-output-formats-title"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <h3
          id="onboarding-output-formats-title"
          className="text-sm font-medium text-muted-foreground"
        >
          {copy.title}
        </h3>
        {output ? (
          <Button
            type="button"
            variant="quiet"
            size="xs"
            className="shrink-0 max-sm:min-h-11"
            disabled={disabled}
            onClick={() => {
              onSelect(null);
            }}
          >
            {copy.clear}
          </Button>
        ) : null}
      </div>
      <ToggleGroup<OnboardingOutputFormat>
        aria-labelledby="onboarding-output-formats-title"
        value={output ? [output] : []}
        disabled={disabled}
        className="grid grid-cols-1 items-stretch gap-2 @min-[18rem]:grid-cols-2"
        onValueChange={(values) => {
          const selected = values[0];
          if (selected) {
            onSelect(selected);
          }
        }}
      >
        {ONBOARDING_OUTPUT_FORMATS.map((format) => {
          const Icon = OUTPUT_ICONS[format];
          return (
            <Toggle
              key={format}
              value={format}
              className="h-auto min-h-10 min-w-0 justify-start gap-2 rounded-lg px-3 py-2 text-left text-sm leading-5 whitespace-normal max-sm:min-h-11"
            >
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 hyphens-auto [overflow-wrap:anywhere]">
                {copy.options[format].label}
              </span>
            </Toggle>
          );
        })}
      </ToggleGroup>
    </section>
  );
}
