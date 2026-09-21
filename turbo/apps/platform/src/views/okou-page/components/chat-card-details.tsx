import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@okouai/ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Info } from "lucide-react";

/** Keep variable-length details and forms outside the transcript's fixed frame. */
export function ChatCardDetails({
  title,
  children,
  triggerLabel,
  compact = false,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly triggerLabel?: string;
  readonly compact?: boolean;
}) {
  const { t } = useTranslation();
  const label =
    triggerLabel ??
    t(($) => {
      return $.chat.cards.viewDetails;
    });
  return (
    <Dialog>
      <DialogTrigger asChild>
        {/*
          The compact trigger sits beside a card's own title, where a bordered
          button would read as a second action competing with the card's real
          one. `quiet` keeps it as chrome: muted at rest, weight on hover.
        */}
        <Button
          type="button"
          variant={compact ? "quiet" : "outline"}
          size={compact ? "icon-2xs" : "sm"}
          className="shrink-0"
          aria-label={label}
        >
          {compact ? <Info size={16} /> : label}
        </Button>
      </DialogTrigger>
      <DialogContent
        aria-describedby={undefined}
        closeLabel={t(($) => {
          return $.settings.shared.close;
        })}
      >
        <DialogHeader className="pr-6">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="min-w-0 space-y-4 break-words text-sm text-muted-foreground">
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}
