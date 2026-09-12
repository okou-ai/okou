import { Button, cn } from "@okouai/ui";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";

export function AuthChoiceRow({
  actionLabel,
  busy,
  disabled,
  leading,
  onSelect,
  primary,
}: {
  readonly actionLabel: string;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly leading: ReactNode;
  readonly onSelect: () => void;
  readonly primary: string;
}) {
  return (
    <Button
      aria-busy={busy}
      aria-label={actionLabel}
      className={cn(
        "h-auto min-h-16 w-full justify-start gap-4 rounded-none px-4 py-3 text-left font-normal",
        "hover:bg-muted",
      )}
      disabled={disabled}
      onClick={onSelect}
      type="button"
      variant="ghost"
    >
      <span className="flex size-8 shrink-0 items-center justify-center">
        {busy ? (
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          leading
        )}
      </span>
      <span className="min-w-0 text-left">
        <span className="block truncate text-sm font-medium text-foreground">
          {primary}
        </span>
      </span>
    </Button>
  );
}
