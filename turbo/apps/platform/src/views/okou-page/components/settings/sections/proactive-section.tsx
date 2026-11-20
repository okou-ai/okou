import { SourceChoices } from "../../../for-you-sources.tsx";
import { surfaceVariants } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { MorningBriefSettings } from "../morning-brief-settings.tsx";
import { ProactiveSuggestionsSettings } from "../proactive-settings.tsx";
import { SettingsSectionHeading } from "../settings-section-heading.tsx";

export function ProactiveSection({
  inMyOkou = false,
}: {
  readonly inMyOkou?: boolean;
}) {
  const { t } = useTranslation();
  const title = t(($) => {
    return $.settings.dialog.sections.proactiveLearning.title;
  });

  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      {!inMyOkou && (
        <SettingsSectionHeading
          title={title}
          description={t(($) => {
            return $.settings.dialog.sections.proactiveLearning.description;
          })}
        />
      )}
      <div className={surfaceVariants({ className: "overflow-hidden" })}>
        <MorningBriefSettings inline={inMyOkou} />
        <ProactiveSuggestionsSettings inMyOkou={inMyOkou} />
        {inMyOkou && <SourceChoices inMyOkou />}
      </div>
      {inMyOkou && (
        <p className="text-xs text-muted-foreground">
          {t(($) => {
            return $.myOkou.proactiveSettings.sourcesHint;
          })}
        </p>
      )}
    </section>
  );
}
