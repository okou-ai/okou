import { surfaceVariants } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { MorningBriefSettings } from "../morning-brief-settings.tsx";
import {
  ProactivePlanningActionSettings,
  ProactiveSuggestionsSettings,
  ProactiveLearningSettings,
} from "../proactive-settings.tsx";
import { SettingsSectionHeading } from "../settings-section-heading.tsx";

export function ProactiveSection() {
  const { t } = useTranslation();
  const title = t(($) => {
    return $.settings.dialog.sections.proactiveAgent.title;
  });

  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <SettingsSectionHeading
        title={title}
        description={t(($) => {
          return $.settings.dialog.sections.proactiveAgent.description;
        })}
      />
      <div className={surfaceVariants({ className: "overflow-hidden" })}>
        <MorningBriefSettings />
        <ProactiveSuggestionsSettings />
        <ProactiveLearningSettings />
        <ProactivePlanningActionSettings />
      </div>
    </section>
  );
}
