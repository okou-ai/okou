import type { PaidToolId } from "@okouai/api-contracts/contracts/paid-tools";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { Button } from "@okouai/ui";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import {
  disabledPaidTools$,
  paidToolDisabledMessage,
  reloadDisabledPaidTools$,
} from "../../signals/okou-page/paid-tools.ts";
import { openSettingsDialogAt$ } from "../../signals/okou-page/settings/settings-dialog.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

function PaidToolNoticeContent({
  tools,
}: {
  readonly tools: readonly PaidToolId[];
}) {
  const { t } = useTranslation();
  const disabled = useLoadable(disabledPaidTools$);
  const retry = useSet(reloadDisabledPaidTools$);
  const openSettings = useSet(openSettingsDialogAt$);
  const signal = useGet(pageSignal$);
  if (
    disabled.state === "hasData" &&
    !tools.some((tool) => {
      return disabled.data.includes(tool);
    })
  ) {
    return null;
  }
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm text-muted-foreground"
    >
      {disabled.state === "loading" ? (
        t(($) => {
          return $.settings.paidTools.loading;
        })
      ) : disabled.state === "hasError" ? (
        <>
          <span>
            {t(($) => {
              return $.settings.paidTools.loadError;
            })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              return retry();
            }}
          >
            {t(($) => {
              return $.settings.paidTools.retry;
            })}
          </Button>
        </>
      ) : (
        <>
          <span>
            {tools
              .filter((tool) => {
                return disabled.data.includes(tool);
              })
              .map(paidToolDisabledMessage)
              .join(" ")}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              return detach(openSettings("chat", signal), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return $.settings.paidTools.openSettings;
            })}
          </Button>
        </>
      )}
    </div>
  );
}

export function PaidToolNotice({
  tools,
}: {
  readonly tools: readonly PaidToolId[];
}) {
  const features = useGet(featureSwitch$);
  const enabled =
    features[FeatureSwitchKey.ChatPreference] &&
    features[FeatureSwitchKey.PaidToolControls];
  return enabled && tools.length > 0 ? (
    <PaidToolNoticeContent tools={tools} />
  ) : null;
}

const CATEGORY_TOOLS: Readonly<Record<string, readonly PaidToolId[]>> = {
  illustration: ["image-generation"],
  video: ["video-generation"],
  avatar: ["avatar-video-generation"],
};

export function TemplatePaidToolNotice({
  category,
}: {
  readonly category: string;
}) {
  return <PaidToolNotice tools={CATEGORY_TOOLS[category] ?? []} />;
}
