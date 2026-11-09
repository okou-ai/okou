import { ArrowLeft, ArrowRight } from "lucide-react";
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
}: {
  readonly items: readonly { readonly id: string; readonly label: string }[];
  readonly index: number;
  readonly onSelect: (index: number) => void;
  readonly label: string;
  readonly previousLabel: string;
  readonly nextLabel: string;
  readonly controlsId?: string;
}) {
  if (items.length < 2) {
    return null;
  }
  return (
    <DialogFooter
      role="group"
      aria-label={label}
      className="flex-row items-center justify-between gap-2 border-t border-border pt-3 sm:justify-between"
    >
      <IconButton
        aria-label={previousLabel}
        aria-controls={controlsId}
        className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
        onClick={() => {
          onSelect((index + items.length - 1) % items.length);
        }}
      >
        <ArrowLeft size={16} aria-hidden="true" />
      </IconButton>
      <div className="flex min-w-0 items-center gap-0.5">
        {items.map((item, itemIndex) => {
          return (
            <IconButton
              key={item.id}
              aria-label={item.label}
              aria-controls={controlsId}
              aria-current={itemIndex === index ? "step" : undefined}
              className="size-6 rounded-full"
              onClick={() => {
                onSelect(itemIndex);
              }}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "h-1.5 rounded-full",
                  itemIndex === index
                    ? "w-4 bg-foreground"
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
        className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
        onClick={() => {
          onSelect((index + 1) % items.length);
        }}
      >
        <ArrowRight size={16} aria-hidden="true" />
      </IconButton>
    </DialogFooter>
  );
}
