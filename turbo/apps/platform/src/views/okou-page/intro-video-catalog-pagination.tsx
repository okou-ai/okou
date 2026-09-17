import { Button } from "@okouai/ui";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../lib/api-error.ts";

export function IntroVideoCatalogPagination({
  hasNext,
  loading,
  error,
  onLoadMore,
  onReload,
  onSentinelRef,
}: {
  readonly hasNext: boolean;
  readonly loading: boolean;
  readonly error: unknown;
  readonly onLoadMore: () => void;
  readonly onReload: () => void;
  readonly onSentinelRef: (node: HTMLDivElement | null) => void | (() => void);
}) {
  const { t } = useTranslation();
  if (!hasNext) {
    return null;
  }
  if (error) {
    const cursorExpired = error instanceof ApiError && error.status === 400;
    return (
      <div className="flex flex-col items-center gap-2 py-3" role="status">
        <span className="text-sm text-muted-foreground">
          {t(($) => {
            return $.chat.introVideo.catalog.error;
          })}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={cursorExpired ? onReload : onLoadMore}
        >
          {t(($) => {
            return cursorExpired
              ? $.chat.introVideo.catalog.reload
              : $.chat.introVideo.catalog.retry;
          })}
        </Button>
      </div>
    );
  }
  if (loading) {
    return (
      // The status row owns the containing block: an sr-only label is absolute,
      // so without it the label escapes the catalog scroller's clip and lands
      // thousands of pixels below, growing the dialog's scrollable area.
      <div
        className="relative flex justify-center py-3 text-muted-foreground"
        role="status"
      >
        <Loader2 className="animate-spin" size={18} aria-hidden="true" />
        <span className="sr-only">
          {t(($) => {
            return $.chat.introVideo.catalog.loading;
          })}
        </span>
      </div>
    );
  }
  return (
    <div
      data-intro-video-catalog-sentinel=""
      aria-hidden="true"
      className="h-px"
      ref={onSentinelRef}
    />
  );
}
