import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Bug } from "lucide-react";
import { Switch } from "@okouai/ui/components/ui/switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../../../../../signals/external/feature-switch.ts";

import { pageSignal$ } from "../../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../../signals/utils.ts";
import {
  captureNetworkBodiesRemaining$,
  updateCaptureNetworkBodies$,
} from "../../../../../signals/okou-page/settings/debug-network-capture.ts";
import { BuildInfoBlock } from "../build-info-block.tsx";
import { ConnectionDiagnosticsBlock } from "../connection-diagnostics-block.tsx";
import { ConnectorCatalogDiagnosticsBlock } from "../connector-catalog-diagnostics-block.tsx";
import { WorkerConnectionDiagnosticsBlock } from "../worker-connection-diagnostics-block.tsx";
import { BuiltInModelCooldownDiagnosticsBlock } from "../built-in-model-cooldown-diagnostics-block.tsx";
import { IndexedDbDiagnosticsBlock } from "../indexeddb-diagnostics-block.tsx";
import { VoiceInputModelSettings } from "../voice-input-model-settings.tsx";
import { WelcomeThreadCard } from "../welcome-thread-card.tsx";

const CAPTURE_RUN_COUNT = 3;

function CaptureNetworkBodiesBlock() {
  const { t } = useTranslation();
  const remainingLoadable = useLoadable(captureNetworkBodiesRemaining$);
  const remaining =
    remainingLoadable.state === "hasData" ? remainingLoadable.data : 0;
  const [captureLoadable, updateCapture] = useLoadableSet(
    updateCaptureNetworkBodies$,
  );
  const saving = captureLoadable.state === "loading";
  const pageSignal = useGet(pageSignal$);
  const enabled = remaining > 0;

  const handleToggle = (checked: boolean) => {
    detach(
      updateCapture(checked ? CAPTURE_RUN_COUNT : 0, pageSignal),
      Reason.DomCallback,
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4 bg-card p-4 rounded-xl border border-surface-border">
        <div className="shrink-0">
          <div className="flex h-7 w-7 items-center justify-center">
            <Bug size={22} className="text-muted-foreground" />
          </div>
        </div>
        <div className="flex flex-1 flex-col gap-1 min-w-0">
          <div className="text-sm font-medium text-foreground">
            {t(($) => {
              return $.settings.preferences.debug.capture.title;
            })}
          </div>
          <div className="text-sm text-muted-foreground">
            {enabled
              ? t(
                  ($) => {
                    return $.settings.preferences.debug.capture.enabled;
                  },
                  {
                    count: remaining,
                  },
                )
              : t(($) => {
                  return $.settings.preferences.debug.capture.disabled;
                })}
          </div>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={handleToggle}
          disabled={saving}
        />
      </div>
    </div>
  );
}

export function DebugSection() {
  const features = useGet(featureSwitch$);
  return (
    <div className="flex flex-col gap-6">
      <BuildInfoBlock />
      {features[FeatureSwitchKey.WelcomeThread] && <WelcomeThreadCard />}
      <VoiceInputModelSettings />
      <ConnectionDiagnosticsBlock />
      <WorkerConnectionDiagnosticsBlock />
      <IndexedDbDiagnosticsBlock />
      <ConnectorCatalogDiagnosticsBlock />
      <BuiltInModelCooldownDiagnosticsBlock />
      <CaptureNetworkBodiesBlock />
    </div>
  );
}
