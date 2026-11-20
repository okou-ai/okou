import { Button } from "@okouai/ui";
import { toast } from "@okouai/ui/components/ui/sonner";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { featureSwitches$ } from "../../signals/external/feature-switch.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import type { ChatThreadSharingSignals } from "../../signals/chat-page/chat-thread-sharing.ts";
import { detach, Reason } from "../../signals/utils.ts";

/** Whether chat sharing uses the `ChatShareRefresh` design. */
export function useChatShareRefresh(): boolean {
  return (
    useLastResolved(featureSwitches$)?.[FeatureSwitchKey.ChatShareRefresh] ===
    true
  );
}

/** The two ends of the sharing header: selection on the leading edge, leaving
 * sharing on the trailing one. `refreshed` comes from a parent that stays
 * mounted outside sharing, so the first sharing frame already knows the switch
 * instead of flashing the legacy controls. */
export function ChatShareHeaderControls({
  sharing,
  refreshed,
}: {
  readonly sharing: ChatThreadSharingSignals;
  readonly refreshed: boolean;
}) {
  return refreshed ? (
    <>
      <ChatShareSelectionControls sharing={sharing} />
      <ChatShareCloseButton sharing={sharing} />
    </>
  ) : (
    <LegacyChatShareHeaderControls sharing={sharing} />
  );
}

function LegacyChatShareHeaderControls({
  sharing,
}: {
  readonly sharing: ChatThreadSharingSignals;
}) {
  const { t } = useTranslation();
  const selectedCount = useGet(sharing.selectedCount$);
  const close = useSet(sharing.close$);
  const pageSignal = useGet(pageSignal$);
  return (
    <>
      <span className="text-sm font-medium text-foreground">
        {t(
          ($) => {
            return $.chat.sharing.selectedCount;
          },
          { count: selectedCount },
        )}
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          detach(
            close(pageSignal),
            Reason.DomCallback,
            "close shared thread selection",
          );
        }}
      >
        {t(($) => {
          return $.chat.sharing.cancel;
        })}
      </Button>
    </>
  );
}

function ChatShareSelectionControls({
  sharing,
}: {
  readonly sharing: ChatThreadSharingSignals;
}) {
  const { t } = useTranslation();
  const phase = useGet(sharing.phase$);
  const selectedCount = useGet(sharing.selectedCount$);
  const selectableCount = useGet(sharing.selectableCount$);
  const allSelected = useGet(sharing.allSelected$);
  const toggleAll = useSet(sharing.toggleAll$);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span
        className="truncate text-sm font-medium text-foreground tabular-nums"
        role="status"
      >
        {phase === "created"
          ? t(
              ($) => {
                return $.chat.sharing.linkCreated;
              },
              { count: selectedCount },
            )
          : t(
              ($) => {
                return $.chat.sharing.selectedOfTotal;
              },
              { count: selectedCount, total: selectableCount },
            )}
      </span>
      {phase === "selecting" ? (
        <Button
          variant="quiet"
          size="sm"
          disabled={selectableCount === 0}
          onClick={() => {
            if (toggleAll() === "too-large") {
              toast.error(
                t(($) => {
                  return $.chat.sharing.tooLarge;
                }),
              );
            }
          }}
        >
          {t(($) => {
            return allSelected
              ? $.chat.sharing.deselectAll
              : $.chat.sharing.selectAll;
          })}
        </Button>
      ) : null}
    </div>
  );
}

/** Leaves sharing. Once the link exists nothing is discarded, so it reads as
 * Done rather than Cancel. */
function ChatShareCloseButton({
  sharing,
}: {
  readonly sharing: ChatThreadSharingSignals;
}) {
  const { t } = useTranslation();
  const created = useGet(sharing.createdSharedThreadId$) !== null;
  const close = useSet(sharing.close$);
  const pageSignal = useGet(pageSignal$);
  return (
    <Button
      variant="quiet"
      size="sm"
      onClick={() => {
        detach(
          close(pageSignal),
          Reason.DomCallback,
          "close shared thread selection",
        );
      }}
    >
      {t(($) => {
        return created ? $.chat.sharing.done : $.chat.sharing.cancel;
      })}
    </Button>
  );
}
