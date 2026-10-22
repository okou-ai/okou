import { useGet, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ArrowLeft, ArrowRight, Download } from "lucide-react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui";
import { buttonVariants } from "@okouai/ui/components/ui/button";
import { computerUseProductName$ } from "../../signals/branding.ts";
import {
  computerUseSetupStep$,
  setComputerUseSetupStep$,
} from "../../signals/computer-use-setup.ts";
import { desktopDownloadSupportStatus$ } from "../../signals/okou-page/computer-use-hosts.ts";
import { ComputerUseChatIllustration } from "./computer-use-chat-illustration.tsx";
import {
  computerUseInstallIllustrationImg,
  computerUsePermissionsIllustrationImg,
} from "./platform-assets.ts";

function ChatSetupVisual() {
  return (
    <figure className="flex h-44 items-center justify-center rounded-xl bg-gray-50 p-2">
      <ComputerUseChatIllustration />
    </figure>
  );
}

function DesktopDownload({ downloadUrl }: { readonly downloadUrl: string }) {
  const { t } = useTranslation();
  const support = useLoadable(desktopDownloadSupportStatus$);
  return (
    <div className="grid justify-items-start gap-3">
      {support.state !== "hasData" ? (
        <Button disabled>
          {t(($) => {
            return $.chat.computerUse.checkingCompatibility;
          })}
        </Button>
      ) : support.data === "unsupported-intel-mac" ? (
        <Button disabled>
          <AlertTriangle size={16} />
          {t(($) => {
            return $.chat.computerUse.unsupportedIntelMac;
          })}
        </Button>
      ) : (
        <a
          href={downloadUrl}
          target="_blank"
          rel="noreferrer"
          className={buttonVariants({ variant: "neutral" })}
        >
          <Download size={16} />
          {t(($) => {
            return $.chat.computerUse.downloadMacos;
          })}
        </a>
      )}
      <p className="text-xs leading-5 text-muted-foreground">
        {t(($) => {
          return $.chat.computerUse.macosRequirement;
        })}
      </p>
    </div>
  );
}

export function ComputerUseDownloadDialog({
  open,
  onOpenChange,
  downloadUrl,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  downloadUrl: string;
}) {
  const { t } = useTranslation();
  const productName = useGet(computerUseProductName$);
  const step = useGet(computerUseSetupStep$);
  const setStep = useSet(setComputerUseSetupStep$);
  const copy = {
    install: {
      title: t(($) => {
        return $.chat.computerUse.setupSteps.installTitle;
      }),
      description: t(
        ($) => {
          return $.chat.computerUse.setupSteps.installDescription;
        },
        {
          desktopProductName: productName,
        },
      ),
      number: 1,
    },
    permissions: {
      title: t(($) => {
        return $.chat.computerUse.setupSteps.permissionsTitle;
      }),
      description: t(($) => {
        return $.chat.computerUse.setupSteps.permissionsDescription;
      }),
      number: 2,
    },
    chat: {
      title: t(($) => {
        return $.chat.computerUse.setupSteps.chatTitle;
      }),
      description: t(($) => {
        return $.chat.computerUse.setupSteps.chatDescription;
      }),
      number: 3,
    },
  }[step];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        maxWidth={560}
        height={440}
        scrollable={false}
        contentClassName="flex flex-col gap-0 p-0"
      >
        <DialogHeader className="flex shrink-0 flex-row items-center gap-3 space-y-0 px-6 pt-5 pb-4 pr-16 text-left">
          <DialogTitle className="min-w-0 text-xl leading-7">
            {copy.title}
          </DialogTitle>
          <span
            aria-live="polite"
            className="shrink-0 text-sm leading-7 tabular-nums text-muted-foreground"
          >
            {copy.number} / 3
          </span>
        </DialogHeader>
        <DialogBody className="grid content-start gap-5 px-6 pb-6">
          <DialogDescription className="leading-6">
            {copy.description}
          </DialogDescription>
          {step === "chat" && <ChatSetupVisual />}
          {step === "install" && <DesktopDownload downloadUrl={downloadUrl} />}
          {step !== "chat" && (
            <figure className="flex justify-center">
              <img
                src={
                  step === "install"
                    ? computerUseInstallIllustrationImg
                    : computerUsePermissionsIllustrationImg
                }
                alt=""
                width={144}
                height={144}
                className="h-36 w-36 object-contain"
              />
            </figure>
          )}
        </DialogBody>
        <div className="flex shrink-0 items-center justify-end gap-3 border-t border-divider px-6 py-4">
          {step !== "install" && (
            <Button
              variant="quiet"
              className="mr-auto"
              onClick={() => {
                return setStep(step === "chat" ? "permissions" : "install");
              }}
            >
              <ArrowLeft size={16} aria-hidden />
              {t(($) => {
                return $.chat.computerUse.setupSteps.previous;
              })}
            </Button>
          )}
          {step === "chat" ? (
            <DialogClose render={<Button className="min-w-24" />}>
              {t(($) => {
                return $.chat.computerUse.setupSteps.done;
              })}
            </DialogClose>
          ) : (
            <Button
              className="min-w-24"
              onClick={() => {
                return setStep(step === "install" ? "permissions" : "chat");
              }}
            >
              {t(($) => {
                return $.remoteControlSetup.next;
              })}
              <ArrowRight size={16} aria-hidden />
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
