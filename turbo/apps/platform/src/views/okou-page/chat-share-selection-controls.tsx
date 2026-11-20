import { Button } from "@okouai/ui";
import { toast } from "@okouai/ui/components/ui/sonner";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { pageSignal$ } from "../../signals/page-signal.ts";
import type { ChatThreadSharingSignals } from "../../signals/chat-page/chat-thread-sharing.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function ChatShareSelectionControls({
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
        className="truncate text-sm font-medium text-foreground"
        role="status"
      >
        {t(
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
export function ChatShareCloseButton({
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
