import { cn } from "@okouai/ui";

type StatusDotVariant =
  "success" | "error" | "pending" | "neutral" | "todo" | "primary";

interface StatusDotProps {
  variant: StatusDotVariant;
  className?: string;
}

function getVariantStyle(variant: StatusDotVariant): string {
  switch (variant) {
    case "success": {
      return "text-green-700";
    }
    case "error": {
      return "text-red-700";
    }
    case "pending": {
      return "text-yellow-700";
    }
    case "neutral": {
      return "text-muted-foreground";
    }
    case "todo": {
      return "text-sky-700";
    }
    case "primary": {
      return "text-orange-600";
    }
  }
}

export function StatusDot({ variant, className }: StatusDotProps) {
  return (
    <span
      className={cn(
        "text-[8px] leading-none shrink-0 inline-block",
        getVariantStyle(variant),
        className,
      )}
      data-variant={variant}
      aria-hidden="true"
    >
      ●
    </span>
  );
}
