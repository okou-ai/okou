import { cn } from "../../lib/utils";

function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "motion-safe:animate-skeleton-pulse rounded-lg bg-skeleton",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
