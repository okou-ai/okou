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
  /** A read in flight only reports; a settled one names a tool or a failure. */
  readonly kind: "pending" | "settled";
  readonly message: string;
  readonly action: { readonly label: string; readonly run: () => void } | null;
  readonly discard?: { readonly label: string; readonly run: () => void };
}

/** Only called behind the rollout gate, so an unreleased member reads nothing. */
function usePaidToolNoticeRow(
  tools: readonly PaidToolId[],
  onDiscardImage?: () => void,
): PaidToolNoticeRow | null {
  const { t } = useTranslation();
  const disabled = useLoadable(disabledPaidTools$);
  const retry = useSet(reloadDisabledPaidTools$);
  const openSettings = useSet(openSettingsDialogAt$);
  const signal = useGet(pageSignal$);
  if (disabled.state === "loading") {
    return {
      kind: "pending",
      message: t(($) => {
        return $.settings.paidTools.loading;
      }),
      action: null,
    };
  }
  if (disabled.state === "hasError") {
    return {
      kind: "settled",
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
    kind: "settled",
    message: blocked.map(paidToolDisabledMessage).join(" "),
    ...(blocked.includes("image-generation") && onDiscardImage
      ? {
          discard: {
            label: t(($) => {
              return $.settings.shared.discard;
            }),
            run: onDiscardImage,
          },
        }
      : {}),
    action: {
      label: t(($) => {
        return $.settings.paidTools.openSettings;
      }),
      run: () => {
        detach(openSettings("tools", signal), Reason.DomCallback);
      },
    },
  };
}

function usePaidToolNoticeEnabled(tools: readonly PaidToolId[]): boolean {
  const features = useGet(featureSwitch$);
  return (
    features[FeatureSwitchKey.SettingsToolsTab] &&
    features[FeatureSwitchKey.PaidToolControls] &&
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
  onDiscardImage,
}: {
  readonly tools: readonly PaidToolId[];
  readonly fallback: ReactNode;
  readonly onDiscardImage?: () => void;
}) {
  const row = usePaidToolNoticeRow(tools, onDiscardImage);
  // The tray holds one row. A read in flight has nothing to say yet, so the
  // notice it would replace keeps the tray until the read settles.
  if (!row || row.kind === "pending") {
    return fallback;
  }
  return withChatScrollLayout(
    <ComposerNoticeTray role="status">
      <span className="min-w-0 max-w-full text-muted-foreground">
        {row.message}
      </span>
      {(row.discard || row.action) && (
        <div className="ml-auto flex shrink-0 items-center">
          {row.discard && (
            <Button
              type="button"
              variant="secondary"
              size="xs"
              className="text-xs font-medium"
              onClick={row.discard.run}
            >
              {row.discard.label}
            </Button>
          )}
          {row.action && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="text-xs font-medium text-foreground"
              onClick={row.action.run}
            >
              {row.action.label}
            </Button>
          )}
        </div>
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
  onDiscardImage,
}: {
  readonly tools: readonly PaidToolId[];
  readonly fallback: ReactNode;
  readonly onDiscardImage?: () => void;
}) {
  return usePaidToolNoticeEnabled(tools) ? (
    <ComposerPaidToolNoticeContent
      tools={tools}
      fallback={fallback}
      onDiscardImage={onDiscardImage}
    />
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
