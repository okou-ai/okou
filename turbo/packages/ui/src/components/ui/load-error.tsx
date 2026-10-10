import type * as React from "react";

import { cn } from "../../lib/utils";
import { Button } from "./button";

interface LoadErrorProps {
  /** One sentence about what the reader is missing: "Couldn't load artifacts." */
  readonly message: string;
  /** The label of the in-place re-read. Only a re-read is called "Try again". */
  readonly retryLabel: string;
  readonly onRetry: () => void;
  /** The re-read the button started is still running. */
  readonly pending?: boolean;
  readonly className?: string;
}

/**
 * A read failed inside a row, a form field, a menu or a card line. No
 * container of its own: it takes the place of the content it stands for.
 *
 * A failed read is not an alarm, so it is announced politely (`status`) and
 * drawn in the muted ink; red is kept for actions the reader started.
 */
export function LoadErrorRow({
  message,
  retryLabel,
  onRetry,
  pending = false,
  className,
}: LoadErrorProps) {
  return (
    <div
      role="status"
      className={cn(
        "flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-2 text-sm text-muted-foreground",
        className,
      )}
    >
      <p className="min-w-0">{message}</p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        pending={pending}
        onClick={onRetry}
      >
        {retryLabel}
      </Button>
    </div>
  );
}

interface LoadErrorSectionProps extends LoadErrorProps {
  readonly description?: string;
  /** A second way out, e.g. a quiet "Reload page" after a repeated failure. */
  readonly secondaryAction?: React.ReactNode;
}

/**
 * A read failed for a whole list or panel. It reuses the empty state's shell
 * (same radius, stroke and height), so failed, empty and loaded content swap in
 * the same footprint without the panel jumping.
 */
export function LoadErrorSection({
  message,
  description,
  retryLabel,
  onRetry,
  pending = false,
  secondaryAction,
  className,
}: LoadErrorSectionProps) {
  return (
    <div
      role="status"
      className={cn(
        "rounded-xl border border-dashed border-border bg-card px-6 py-12 text-center",
        className,
      )}
    >
      <p className="text-sm font-medium text-foreground">{message}</p>
      {description ? (
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          {description}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          pending={pending}
          onClick={onRetry}
        >
          {retryLabel}
        </Button>
        {secondaryAction}
      </div>
    </div>
  );
}
