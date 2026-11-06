import { withChatScrollLayout } from "../components/chat-scroll-layout.tsx";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Download, Share2, SquarePlus, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Button,
} from "@okouai/ui";
import {
  installBannerVisible$,
  iosInstallModalOpen$,
  triggerInstall$,
  closeIosInstallModal$,
  dismissInstallBanner$,
} from "../../signals/pwa-install.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function InstallBanner() {
  const { t } = useTranslation();
  const visible = useGet(installBannerVisible$);
  const trigger = useSet(triggerInstall$);
  const dismiss = useSet(dismissInstallBanner$);
  const pageSignal = useGet(pageSignal$);

  if (!visible) {
    return withChatScrollLayout(null);
  }

  return withChatScrollLayout(
    <div className="shrink-0 flex items-center gap-2 bg-primary/5 border-b border-primary/20 px-3 py-2 text-sm">
      <Download size={16} className="text-brand-text shrink-0" />
      <span className="flex-1 min-w-0 truncate text-foreground">
        {t(($) => {
          return $.lifecycle.pwaInstall.banner;
        })}
      </span>
      <Button
        type="button"
        size="xs"
        aria-label={t(($) => {
          return $.lifecycle.pwaInstall.installApp;
        })}
        onClick={() => {
          detach(trigger(pageSignal), Reason.DomCallback);
        }}
        className="shrink-0 text-xs"
      >
        {t(($) => {
          return $.lifecycle.pwaInstall.install;
        })}
      </Button>
      <Button
        showTooltip
        type="button"
        onClick={() => {
          detach(dismiss(pageSignal), Reason.DomCallback);
        }}
        variant="quiet"
        size="icon-xs"
        className="shrink-0"
        aria-label={t(($) => {
          return $.lifecycle.pwaInstall.dismiss;
        })}
      >
        <X size={14} />
      </Button>
    </div>,
  );
}

export function IosInstallModal() {
  const { t } = useTranslation();
  const open = useGet(iosInstallModalOpen$);
  const close = useSet(closeIosInstallModal$);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          close();
        }
      }}
    >
      <DialogContent maxWidth="sm">
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.lifecycle.pwaInstall.title;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.lifecycle.pwaInstall.description;
            })}
          </DialogDescription>
        </DialogHeader>
        <ol className="space-y-3 text-sm text-foreground">
          <li className="flex items-start gap-3">
            <span className="shrink-0 flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-medium">
              1
            </span>
            <span className="flex-1 flex items-center gap-1.5 flex-wrap">
              <Share2 size={16} className="inline" aria-hidden />
              {t(($) => {
                return $.lifecycle.pwaInstall.stepOne;
              })}
            </span>
          </li>
          <li className="flex items-start gap-3">
            <span className="shrink-0 flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-medium">
              2
            </span>
            <span className="flex-1 flex items-center gap-1.5 flex-wrap">
              <SquarePlus size={16} className="inline" aria-hidden />
              {t(($) => {
                return $.lifecycle.pwaInstall.stepTwo;
              })}
            </span>
          </li>
          <li className="flex items-start gap-3">
            <span className="shrink-0 flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-medium">
              3
            </span>
            <span className="flex-1">
              {t(($) => {
                return $.lifecycle.pwaInstall.stepThree;
              })}
            </span>
          </li>
        </ol>
        <DialogFooter>
          <Button
            onClick={() => {
              close();
            }}
          >
            {t(($) => {
              return $.lifecycle.pwaInstall.gotIt;
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
