import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { useLastResolved } from "ccstate-react";
import { featureSwitches$ } from "../../signals/external/feature-switch.ts";
import { LegacyWorkflowsPage } from "./legacy-workflows-page.tsx";
import { WorkflowDirectoryPage } from "./workflow-directory-page.tsx";

export function WorkflowsPage() {
  const features = useLastResolved(featureSwitches$);
  return features?.[FeatureSwitchKey.WorkflowListRedesign] ? (
    <WorkflowDirectoryPage />
  ) : (
    <LegacyWorkflowsPage />
  );
}
