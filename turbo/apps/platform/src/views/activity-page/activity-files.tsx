import { useGet, useSet } from "ccstate-react";
import { Maximize, Minimize, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, FullscreenPanel, cn, surfaceVariants } from "@okouai/ui";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { authenticatedSessionKey$ } from "../../signals/auth.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { currentRunId$ } from "../../signals/activity-page/activity-signals.ts";
import { activityFiles } from "../../signals/activity-page/sandbox-files.ts";
import { SandboxFilesBody } from "./sandbox-files.tsx";

function ActivityFilesPanel() {
  const { t, i18n } = useTranslation();
  const mount = useSet(activityFiles.mount$);
  const fullscreen = useGet(activityFiles.fullscreen$);
  const toggleFullscreen = useSet(activityFiles.toggleFullscreen$);
  const close = useSet(activityFiles.close$);
  const title = t(($) => {
    return $.activity.detail.files.title;
  });
  return (
    <FullscreenPanel
      fullscreen={fullscreen}
      className={cn(
        "min-w-0",
        !fullscreen && surfaceVariants({ className: "overflow-hidden" }),
        fullscreen && "h-viewport max-h-viewport min-h-viewport",
      )}
    >
      <section
        ref={mount}
        aria-label={title}
        className={cn(
          "flex w-full min-h-0 min-w-0 flex-col",
          fullscreen ? "h-full" : "h-[min(70dvh,720px)] min-h-80",
        )}
      >
        <div className="flex min-h-14 shrink-0 items-center gap-1 border-b border-border/60 px-4">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {title}
          </span>
          <Button
            showTooltip
            type="button"
            variant="quiet"
            size="icon-sm"
            onClick={toggleFullscreen}
            aria-label={
              fullscreen
                ? t(($) => {
                    return $.artifacts.actions.exitFullscreen;
                  })
                : t(($) => {
                    return $.artifacts.actions.enterFullscreen;
                  })
            }
          >
            {fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
          </Button>
          <Button
            showTooltip
            type="button"
            variant="quiet"
            size="icon-sm"
            onClick={close}
            aria-label={t(
              ($) => {
                return $.artifacts.actions.closeNamed;
              },
              {
                title: title.toLocaleLowerCase(
                  i18n.resolvedLanguage ?? i18n.language,
                ),
              },
            )}
          >
            <X size={16} />
          </Button>
        </div>
        <SandboxFilesBody signals={activityFiles} />
      </section>
    </FullscreenPanel>
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
