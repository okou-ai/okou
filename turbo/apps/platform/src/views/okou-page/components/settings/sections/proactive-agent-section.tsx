import { surfaceVariants } from "@okouai/ui";
import {
  ProactiveJobsSettings,
  ProactiveSuggestionsSettings,
  ProactiveLearningSettings,
  ProactivePlanningSettings,
} from "../proactive-settings.tsx";

export function ProactiveAgentSection() {
  return (
    <div className={surfaceVariants({ className: "overflow-hidden" })}>
      <ProactiveLearningSettings />
      <ProactivePlanningSettings />
      <ProactiveJobsSettings />
      <ProactiveSuggestionsSettings />
    </div>
  );
}
