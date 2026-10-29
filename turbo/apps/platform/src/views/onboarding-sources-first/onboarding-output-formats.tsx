import { useGet, useSet } from "ccstate-react";
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
  STARTING_PROMPT_MAX_LENGTH,
  withStartingPromptOutput,
  type OnboardingOutputFormat,
} from "../../signals/onboarding/onboarding-output-format.ts";
import {
  selectStartingPromptOutput$,
  sourcesFirstDraft$,
} from "../../signals/onboarding/onboarding-sources-first-state.ts";

const OUTPUT_ICONS = Object.freeze({
  image: Image,
  presentation: Presentation,
  website: Globe,
  report: FileText,
  research: Search,
  people: Users,
});

export function OnboardingOutputFormats({
  text,
  promptKey,
  disabled,
}: {
  readonly text: string;
  readonly promptKey: string;
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.onboarding.sourcesFirst.outputFormats;
    },
    { returnObjects: true },
  );
  const { startingPromptOutput: output } = useGet(sourcesFirstDraft$);
  const selectOutput = useSet(selectStartingPromptOutput$);
  const options = ONBOARDING_OUTPUT_FORMATS.map((format) => {
    const next = withStartingPromptOutput(
      text,
      output,
      copy.options[format].instruction,
    );
    return { format, tooLong: next.text.length > STARTING_PROMPT_MAX_LENGTH };
  });

  return (
    <section className="mt-6" aria-labelledby="onboarding-output-formats-title">
      <div className="mb-2 flex items-center justify-between gap-2">
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
            disabled={disabled}
            onClick={() => {
              selectOutput(text, promptKey, null, "");
            }}
          >
            {copy.clear}
          </Button>
        ) : null}
      </div>
      <ToggleGroup<OnboardingOutputFormat>
        aria-labelledby="onboarding-output-formats-title"
        value={output ? [output.format] : []}
        disabled={disabled}
        className="grid grid-cols-2 gap-2"
        onValueChange={(values) => {
          const format = values[0];
          if (format) {
            selectOutput(
              text,
              promptKey,
              format,
              copy.options[format].instruction,
            );
          }
        }}
      >
        {options.map(({ format, tooLong }) => {
          const Icon = OUTPUT_ICONS[format];
          return (
            <Toggle
              key={format}
              value={format}
              disabled={tooLong}
              className="h-10 min-w-0 justify-start gap-2 rounded-lg px-3 text-sm"
            >
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              {copy.options[format].label}
            </Toggle>
          );
        })}
      </ToggleGroup>
      {options.some((option) => {
        return option.tooLong;
      }) ? (
        <p className="mt-2 text-xs text-muted-foreground" role="status">
          {copy.tooLong}
        </p>
      ) : null}
    </section>
  );
}
