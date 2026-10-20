import type { ComponentProps, ReactNode } from "react";
import { useGet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";
import { Button } from "@okouai/ui/components/ui/button";
import { Loader2 } from "lucide-react";

import { detach, Reason } from "../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { ProviderIcon } from "./provider-icons.tsx";

export function DeviceAuthDialogShell({
  open,
  close,
  iconType,
  title,
  children,
}: {
  readonly open: boolean;
  readonly close: (signal: AbortSignal) => Promise<void>;
  readonly iconType: ComponentProps<typeof ProviderIcon>["type"];
  readonly title: ReactNode;
  readonly children: ReactNode;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          detach(close(pageSignal), Reason.DomCallback);
        }
      }}
    >
      <DialogContent
        maxWidth="md"
        aria-describedby={undefined}
        closeLabel={t(($) => {
          return $.settings.shared.close;
        })}
      >
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-5 w-5 shrink-0 items-center justify-center">
              <ProviderIcon type={iconType} size={20} />
            </div>
            <DialogTitle>{title}</DialogTitle>
          </div>
        </DialogHeader>

        {children}
      </DialogContent>
    </Dialog>
  );
}

export function DeviceAuthLoadingContent({
  testId,
  label,
}: {
  readonly testId: string;
  readonly label: ReactNode;
}) {
  return (
    <div
      className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"
      role="status"
      data-testid={testId}
    >
      <Loader2 size={16} className="animate-spin" />
      <span>{label}</span>
    </div>
  );
}

export function DeviceAuthRetryContent({
  message,
  testId,
  label,
  onStart,
}: {
  readonly message: string | undefined;
  readonly testId: string;
  readonly label: ReactNode;
  readonly onStart: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {message && (
        <p className="text-sm text-destructive" role="alert">
          {message}
        </p>
      )}
      <Button
        type="button"
        variant="outline"
        onClick={onStart}
        className="w-full gap-2"
        data-testid={testId}
      >
        {label}
      </Button>
    </div>
  );
}
