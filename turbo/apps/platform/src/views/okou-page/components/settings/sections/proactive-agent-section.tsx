import { surfaceVariants } from "@okouai/ui";
import {
  ProactivePlanningActionSettings,
  ProactiveSuggestionsSettings,
  ProactiveLearningSettings,
} from "../proactive-settings.tsx";

export function ProactiveAgentSection() {
  return (
    <div className={surfaceVariants({ className: "overflow-hidden" })}>
      <ProactiveLearningSettings />
      <ProactivePlanningActionSettings />
      <ProactiveSuggestionsSettings />
    </div>
  );
}
