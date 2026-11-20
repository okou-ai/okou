import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { useLastResolved } from "ccstate-react";
import { featureSwitches$ } from "../../../../../signals/external/feature-switch.ts";
import { SourceChoices } from "../../../for-you-sources.tsx";
import { surfaceVariants } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { MorningBriefSettings } from "../morning-brief-settings.tsx";
import {
  ProactiveSuggestionsSettings,
  ProactiveLearningSettings,
} from "../proactive-settings.tsx";
import { SettingsSectionHeading } from "../settings-section-heading.tsx";

export function ProactiveSection({
  inMyOkou = false,
}: {
  readonly inMyOkou?: boolean;
}) {
  const features = useLastResolved(featureSwitches$);
  const showSources = inMyOkou && features?.[FeatureSwitchKey.AgentSuggestion];
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
        <ProactiveLearningSettings inline={inMyOkou} />
        {showSources && <SourceChoices inMyOkou />}
      </div>
      {showSources && (
        <p className="text-xs text-muted-foreground">
          {t(($) => {
            return $.myOkou.proactiveSettings.sourcesHint;
          })}
        </p>
      )}
    </section>
  );
}
