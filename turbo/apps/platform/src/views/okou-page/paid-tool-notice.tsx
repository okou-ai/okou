import type { ReactNode } from "react";
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
import { withChatScrollLayout } from "../components/chat-scroll-layout.tsx";
import { ComposerNoticeTray } from "./composer-notice-tray.tsx";

interface PaidToolNoticeRow {
  readonly message: string;
  /** A settled read offers a way forward; a read in flight only reports. */
  readonly action: { readonly label: string; readonly run: () => void } | null;
}

/** Only called behind the rollout gate, so an unreleased member reads nothing. */
function usePaidToolNoticeRow(
  tools: readonly PaidToolId[],
): PaidToolNoticeRow | null {
  const { t } = useTranslation();
  const disabled = useLoadable(disabledPaidTools$);
  const retry = useSet(reloadDisabledPaidTools$);
  const openSettings = useSet(openSettingsDialogAt$);
  const signal = useGet(pageSignal$);
  if (disabled.state === "loading") {
    return {
      message: t(($) => {
        return $.settings.paidTools.loading;
      }),
      action: null,
    };
  }
  if (disabled.state === "hasError") {
    return {
      message: t(($) => {
        return $.settings.paidTools.loadError;
      }),
      action: {
        label: t(($) => {
          return $.settings.paidTools.retry;
        }),
        run: () => {
          retry();
        },
      },
    };
  }
  const blocked = tools.filter((tool) => {
    return disabled.data.includes(tool);
  });
  if (blocked.length === 0) {
    return null;
  }
  return {
    message: blocked.map(paidToolDisabledMessage).join(" "),
    action: {
      label: t(($) => {
        return $.settings.paidTools.openSettings;
      }),
      run: () => {
        detach(openSettings("chat", signal), Reason.DomCallback);
      },
    },
  };
}

function usePaidToolNoticeEnabled(tools: readonly PaidToolId[]): boolean {
  const features = useGet(featureSwitch$);
  return (
    (features[FeatureSwitchKey.ChatPreference] ?? false) &&
    (features[FeatureSwitchKey.PaidToolControls] ?? false) &&
    tools.length > 0
  );
}

function PaidToolNoticeContent({
  tools,
}: {
  readonly tools: readonly PaidToolId[];
}) {
  const row = usePaidToolNoticeRow(tools);
  if (!row) {
    return null;
  }
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm text-muted-foreground"
    >
      <span>{row.message}</span>
      {row.action && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={row.action.run}
        >
          {row.action.label}
        </Button>
      )}
    </div>
  );
}

function PaidToolNotice({ tools }: { readonly tools: readonly PaidToolId[] }) {
  return usePaidToolNoticeEnabled(tools) ? (
    <PaidToolNoticeContent tools={tools} />
  ) : null;
}

function ComposerPaidToolNoticeContent({
  tools,
  fallback,
}: {
  readonly tools: readonly PaidToolId[];
  readonly fallback: ReactNode;
}) {
  const row = usePaidToolNoticeRow(tools);
  if (!row) {
    return fallback;
  }
  return withChatScrollLayout(
    <ComposerNoticeTray role="status">
      <span className="min-w-0 max-w-full text-muted-foreground">
        {row.message}
      </span>
      {row.action && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto shrink-0 text-xs font-medium text-foreground"
          onClick={row.action.run}
        >
          {row.action.label}
        </Button>
      )}
    </ComposerNoticeTray>,
  );
}

/**
 * The composer's own copy of the notice, in the tray the temporary model card
 * already owns. A blocked tool outranks that card: the member cannot run the
 * task at all, so the tray shows this row and the model card waits.
 */
export function ComposerPaidToolNotice({
  tools,
  fallback,
}: {
  readonly tools: readonly PaidToolId[];
  readonly fallback: ReactNode;
}) {
  return usePaidToolNoticeEnabled(tools) ? (
    <ComposerPaidToolNoticeContent tools={tools} fallback={fallback} />
  ) : (
    fallback
  );
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
