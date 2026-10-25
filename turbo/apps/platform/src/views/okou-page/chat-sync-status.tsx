import { useGet, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Button } from "@okouai/ui";

import { chatSync$, refreshChatSync$ } from "../../signals/chat-sync.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, isAbortError, Reason } from "../../signals/utils.ts";

export function ChatSyncStatus() {
  const { t } = useTranslation();
  const sync = useLoadable(chatSync$);
  const retry = useSet(refreshChatSync$);
  const signal = useGet(pageSignal$);
  if (sync.state !== "hasError" || isAbortError(sync.error)) {
    return null;
  }
  return (
    <div
      role="status"
      className="flex shrink-0 items-center justify-between gap-3 border-b border-border/50 px-4 py-2 text-sm text-muted-foreground"
    >
      <span>
        {t(($) => {
          return $.chat.syncFailed;
        })}
      </span>
      <Button
        type="button"
        variant="quiet"
        size="sm"
        onClick={() => {
          detach(retry(signal), Reason.DomCallback);
        }}
      >
        {t(($) => {
          return $.global.actions.tryAgain;
        })}
      </Button>
    </div>
  );
}
