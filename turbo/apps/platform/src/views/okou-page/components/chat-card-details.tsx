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

/** Keep variable-length details and forms outside the transcript's fixed frame. */
export function ChatCardDetails({
  title,
  children,
  triggerLabel,
  onOpenChange,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly triggerLabel?: string;
  readonly onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const label =
    triggerLabel ??
    t(($) => {
      return $.chat.cards.viewDetails;
    });
  return (
    <Dialog onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            aria-label={label}
          >
            {label}
          </Button>
        }
      />
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
