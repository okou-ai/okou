import { authenticatedSessionKey$ } from "../../signals/auth.ts";
import { searchParams$ } from "../../signals/route.ts";
import type { ReactNode } from "react";
import {
  IconButton,
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
import { CircleHelp } from "lucide-react";

export const REMOTE_PAGE_ACTION =
  "min-h-10 bg-foreground text-background hover:bg-foreground-hover active:bg-foreground-pressed";

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
      <Card surface="composer" className="grid gap-6 p-6 text-sm">
        <header className="grid gap-1.5">
          <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
          {description && (
            <p className="text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
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

export function RemoteUsernameHelp({
  children,
}: {
  readonly children?: ReactNode;
}) {
  const { t } = useTranslation();
  const enabled = useGet(remoteControlGuidedEnabled$);
  if (!enabled) {
    return null;
  }
  return (
    <Popover>
      <PopoverTrigger
        render={
          <IconButton
            type="button"
            className="size-7 text-muted-foreground"
            aria-label={t(($) => {
              return $.remoteControlSetup.usernameHelp;
            })}
          />
        }
      >
        <CircleHelp size={16} aria-hidden />
      </PopoverTrigger>
      <PopoverContent className="grid max-w-sm gap-3 text-sm leading-6">
        <ul className="grid list-disc gap-3 pl-5 marker:text-muted-foreground">
          <li>
            {t(($) => {
              return $.remoteControlSetup.usernameExplanation;
            })}
            <code className="mt-2 block rounded-lg bg-nested-fill px-3 py-2">
              {t(($) => {
                return $.remoteControlSetup.usernameCommand;
              })}
            </code>
          </li>
          <li className="text-muted-foreground">
            {t(($) => {
              return $.remoteControlSetup.usernameWindows;
            })}
          </li>
        </ul>
        {children}
      </PopoverContent>
    </Popover>
  );
}

export function useRemoteNetworkEditorVisible(
  inline: boolean,
  dialog:
    | { readonly sessionKey: string | null; readonly kind: string }
    | null
    | undefined,
) {
  const sessionKey = useGet(authenticatedSessionKey$);
  const guided = useGet(remoteControlGuidedEnabled$);
  const params = useGet(searchParams$);
  if (!dialog || dialog.sessionKey !== sessionKey) {
    return false;
  }
  return (
    inline ||
    !guided ||
    params.get("scope") !== "private-network" ||
    (dialog.kind !== "edit" && dialog.kind !== "create")
  );
}
