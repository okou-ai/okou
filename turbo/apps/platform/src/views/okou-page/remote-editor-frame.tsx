import type { ReactNode } from "react";
import {
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { useGet } from "ccstate-react";
import { remoteControlGuidedEnabled$ } from "../../signals/remote-control-setup.ts";

export const REMOTE_PAGE_ACTION =
  "bg-foreground text-background hover:bg-foreground-hover active:bg-foreground-pressed";

export function RemoteEditorFrame({
  inline,
  title,
  description,
  busy,
  onClose,
  children,
}: {
  readonly inline: boolean;
  readonly title: string;
  readonly description?: string | null;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  if (inline) {
    return (
      <Card surface="composer" className="grid gap-6 p-6">
        <header className="grid gap-2">
          <h2 className="text-lg font-semibold">{title}</h2>
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </header>
        {children}
      </Card>
    );
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) {
          onClose();
        }
      }}
    >
      <DialogContent contentClassName="flex flex-col">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export function RemoteUsernameHelp() {
  const { t } = useTranslation();
  const enabled = useGet(remoteControlGuidedEnabled$);
  if (!enabled) {
    return null;
  }
  return (
    <Popover>
      <PopoverTrigger
        render={<Button type="button" variant="quiet" size="sm" />}
      >
        {t(($) => {
          return $.remoteControlSetup.usernameHelp;
        })}
      </PopoverTrigger>
      <PopoverContent className="grid max-w-sm gap-3 text-sm">
        <p>
          {t(($) => {
            return $.remoteControlSetup.usernameExplanation;
          })}
        </p>
        <code className="rounded-lg bg-gray-50 p-3">whoami</code>
        <p className="text-muted-foreground">
          {t(($) => {
            return $.remoteControlSetup.usernameWindows;
          })}
        </p>
      </PopoverContent>
    </Popover>
  );
}
