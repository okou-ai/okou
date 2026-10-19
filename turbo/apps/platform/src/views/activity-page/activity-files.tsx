import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { authenticatedSessionKey$ } from "../../signals/auth.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { currentRunId$ } from "../../signals/activity-page/activity-signals.ts";
import { activityFiles } from "../../signals/activity-page/sandbox-files.ts";
import { SandboxFilesBody } from "./sandbox-files.tsx";

function ActivityFilesPanel() {
  const { t } = useTranslation();
  const mount = useSet(activityFiles.mount$);
  const title = t(($) => {
    return $.activity.detail.files.title;
  });
  return (
    <section ref={mount} aria-label={title} className="isolate w-full min-w-0">
      <SandboxFilesBody signals={activityFiles} />
    </section>
  );
}

export function ActivityFilesTab() {
  const sessionKey = useGet(authenticatedSessionKey$);
  const runId = useGet(currentRunId$);
  const enabled = useGet(featureSwitch$)[FeatureSwitchKey.OkouDebug];
  if (!enabled || !sessionKey || !runId) {
    return null;
  }
  return <ActivityFilesPanel key={`${sessionKey}:${runId}`} />;
}
