import { SourceChoices } from "../../../for-you-sources.tsx";
import { surfaceVariants } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { MorningBriefSettings } from "../morning-brief-settings.tsx";
import { ProactiveSuggestionsSettings } from "../proactive-settings.tsx";

export function ProactiveSection() {
  const { t } = useTranslation();
  const title = t(($) => {
    return $.settings.dialog.sections.proactiveLearning.title;
  });

  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <div className={surfaceVariants({ className: "overflow-hidden" })}>
        <MorningBriefSettings />
        <ProactiveSuggestionsSettings />
        <SourceChoices />
      </div>
      <p className="text-xs text-muted-foreground">
        {t(($) => {
          return $.myOkou.proactiveSettings.sourcesHint;
        })}
      </p>
    </section>
  );
}
