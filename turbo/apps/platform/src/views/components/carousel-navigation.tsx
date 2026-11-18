import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight } from "lucide-react";
import { DialogFooter } from "@okouai/ui/components/ui/dialog";
import { IconButton } from "@okouai/ui/components/ui/icon-button";
import { cn } from "@okouai/ui/lib/utils";

export function CarouselNavigation({
  items,
  index,
  onSelect,
  label,
  previousLabel,
  nextLabel,
  controlsId,
  appearance = "default",
}: {
  readonly items: readonly { readonly id: string; readonly label: string }[];
  readonly index: number;
  readonly onSelect: (index: number) => void;
  readonly label: string;
  readonly previousLabel: string;
  readonly nextLabel: string;
  readonly controlsId?: string;
  readonly appearance?: "default" | "announcement";
}) {
  if (items.length < 2) {
    return null;
  }
  const PreviousIcon = appearance === "announcement" ? ChevronLeft : ArrowLeft;
  const NextIcon = appearance === "announcement" ? ChevronRight : ArrowRight;
  const arrowClassName = cn(
    "size-8 shrink-0",
    appearance === "announcement"
      ? "rounded-full border border-border bg-background p-0 shadow-sm hover:bg-state-hover-overlay"
      : "text-muted-foreground hover:text-foreground",
  );
  return (
    <DialogFooter
      role="group"
      aria-label={label}
      className={cn(
        "shrink-0 flex-row items-center justify-between gap-2 sm:justify-between",
        appearance === "announcement"
          ? "pt-[13px]"
          : "border-t border-border pt-3",
      )}
    >
      <IconButton
        aria-label={previousLabel}
        aria-controls={controlsId}
        className={arrowClassName}
        onClick={() => {
          onSelect((index + items.length - 1) % items.length);
        }}
      >
        <PreviousIcon size={16} aria-hidden="true" />
      </IconButton>
      <div className="flex min-w-0 flex-wrap items-center justify-center gap-0.5">
        {items.map((item, itemIndex) => {
          return (
            <IconButton
              key={item.id}
              aria-label={item.label}
              aria-controls={controlsId}
              aria-current={itemIndex === index ? "step" : undefined}
              className="size-6 shrink-0 rounded-full"
              onClick={() => {
                onSelect(itemIndex);
              }}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "h-1.5 rounded-full",
                  itemIndex === index
                    ? appearance === "announcement"
                      ? "w-4 bg-primary"
                      : "w-4 bg-foreground"
                    : "w-1.5 bg-gray-300",
                )}
              />
            </IconButton>
          );
        })}
      </div>
      <IconButton
        aria-label={nextLabel}
        aria-controls={controlsId}
        className={arrowClassName}
        onClick={() => {
          onSelect((index + 1) % items.length);
        }}
      >
        <NextIcon size={16} aria-hidden="true" />
      </IconButton>
    </DialogFooter>
  );
}
