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
    <figure className="flex h-44 items-center justify-center rounded-xl bg-gray-50 p-3">
      <ComputerUseChatIllustration />
    </figure>
  );
}

function DesktopDownload({ downloadUrl }: { readonly downloadUrl: string }) {
  const { t } = useTranslation();
  const support = useLoadable(desktopDownloadSupportStatus$);
  return (
    <div className="grid w-full min-w-0 flex-1 justify-items-start gap-3">
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

function DesktopSetupVisual({
  step,
  downloadUrl,
}: {
  readonly step: "install" | "permissions";
  readonly downloadUrl: string;
}) {
  return (
    <div className="flex min-h-44 flex-col items-center justify-center gap-5 rounded-xl bg-gray-50 p-4 sm:flex-row sm:gap-6">
      <figure className="flex shrink-0 justify-center">
        <img
          src={
            step === "install"
              ? computerUseInstallIllustrationImg
              : computerUsePermissionsIllustrationImg
          }
          alt=""
          width={144}
          height={144}
          className="size-36 object-contain"
        />
      </figure>
      {step === "install" && <DesktopDownload downloadUrl={downloadUrl} />}
    </div>
  );
}

function SetupProgress({ currentStep }: { readonly currentStep: number }) {
  return (
    <div className="flex gap-2" aria-hidden="true">
      {[1, 2, 3].map((number) => {
        return (
          <div
            key={number}
            className={
              number <= currentStep
                ? "h-1 flex-1 rounded-full bg-primary"
                : "h-1 flex-1 rounded-full bg-muted"
            }
          />
        );
      })}
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
        <DialogHeader className="shrink-0 space-y-4 px-6 pt-6 pb-5 text-left">
          <div className="flex items-center justify-between gap-4 pr-10">
            <DialogTitle className="min-w-0 text-xl leading-7">
              {copy.title}
            </DialogTitle>
            <span
              aria-live="polite"
              className="shrink-0 text-sm leading-7 tabular-nums text-muted-foreground"
            >
              {copy.number} / 3
            </span>
          </div>
          <SetupProgress currentStep={copy.number} />
        </DialogHeader>
        <DialogBody className="grid content-start gap-4 px-6 pb-6">
          <DialogDescription className="min-h-12 leading-6">
            {copy.description}
          </DialogDescription>
          {step === "chat" ? (
            <ChatSetupVisual />
          ) : (
            <DesktopSetupVisual step={step} downloadUrl={downloadUrl} />
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
            <DialogClose render={<Button className="min-w-28" />}>
              {t(($) => {
                return $.chat.computerUse.setupSteps.done;
              })}
            </DialogClose>
          ) : (
            <Button
              className="min-w-28"
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
