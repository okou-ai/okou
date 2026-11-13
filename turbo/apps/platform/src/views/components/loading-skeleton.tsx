import { Skeleton, cn } from "@okouai/ui";

/** Content-shaped placeholders with a single accessible loading announcement. */
export function LoadingSkeleton({
  label,
  variant = "rows",
  count = 3,
  className,
}: {
  readonly label: string;
  readonly variant?: "text" | "rows" | "fields" | "cards";
  readonly count?: number;
  readonly className?: string;
}) {
  if (variant === "text") {
    return (
      <span
        role="status"
        aria-label={label}
        aria-busy="true"
        className={cn(
          "inline-flex h-5 w-28 max-w-full items-center align-middle",
          className,
        )}
      >
        <span className="sr-only">{label}</span>
        <span
          aria-hidden="true"
          className="h-3 w-full rounded-lg bg-skeleton motion-safe:animate-skeleton-pulse"
        />
      </span>
    );
  }
  return (
    <div
      role="status"
      aria-label={label}
      aria-busy="true"
      className={cn("w-full min-w-0", className)}
    >
      <span className="sr-only">{label}</span>
      <div
        aria-hidden="true"
        className={cn(
          "grid gap-3",
          variant === "cards" && "grid-cols-1 sm:grid-cols-2",
        )}
      >
        {Array.from({ length: count }, (_, index) => {
          return variant === "fields" ? (
            <div key={index} className="grid gap-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : (
            <div
              key={index}
              className={cn(
                "flex items-center gap-3",
                variant === "cards" &&
                  "rounded-xl border border-surface-border p-4",
              )}
            >
              <Skeleton className="size-9 shrink-0" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-3.5 w-2/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
