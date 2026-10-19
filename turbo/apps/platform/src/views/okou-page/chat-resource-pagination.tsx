import { useGet, useLoadable, useSet } from "ccstate-react";
import { Button } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import type { ResourcePagination } from "../../signals/chat-page/chat-resource-pagination.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, isAbortError, Reason } from "../../signals/utils.ts";

export function ChatResourcePagination({
  pagination,
}: {
  readonly pagination: ResourcePagination;
}) {
  const { t } = useTranslation();
  const endRef = useSet(pagination.endOnRef$);
  const request = useLoadable(pagination.request$);
  const retry = useSet(pagination.load$);
  const signal = useGet(pageSignal$);
  return (
    <>
      <div ref={endRef} aria-hidden className="h-px" />
      {request.state === "hasError" && !isAbortError(request.error) && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 px-1 text-xs text-muted-foreground"
        >
          <p>
            {t(($) => {
              return $.chat.relations.loadFailed;
            })}
          </p>
          <Button
            variant="quiet"
            size="xs"
            onClick={() => {
              detach(retry(signal), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return $.chat.resources.retry;
            })}
          </Button>
        </div>
      )}
    </>
  );
}
