import { Button } from "@okouai/ui";
import { toast } from "@okouai/ui/components/ui/sonner";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import type { ChatThreadSharingSignals } from "../../signals/chat-page/chat-thread-sharing.ts";

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
      <span className="text-sm font-medium text-foreground" role="status">
        {t(
          ($) => {
            return $.chat.sharing.selectedCount;
          },
          { count: selectedCount },
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
