import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Laptop,
  Monitor,
  Terminal,
} from "lucide-react";
import { Button } from "@okouai/ui";
import { buttonVariants } from "@okouai/ui/components/ui/button";
import { cn } from "@okouai/ui/lib/utils";
import {
  chooseRemoteProtocol$,
  closeRemoteComputerUseSetup$,
  goBackRemoteSetup$,
  leaveRemoteSetup$,
  openRemoteLogin$,
  remoteSetup$,
  remoteSetupSavedName$,
  saveRemoteSsh$,
  saveRemoteVnc$,
  type RemoteSetup,
} from "../../signals/remote-control-setup.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { searchParams$ } from "../../signals/route.ts";
import { remoteResourceSearchParams } from "../../signals/remote-resource-detail.ts";
import { OKOU_DESKTOP_DOWNLOAD_URL } from "../../signals/okou-page/computer-use-hosts.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { SshDialog } from "./ssh-management.tsx";
import { VncDialog } from "./vnc-dialog.tsx";
import { REMOTE_PAGE_ACTION } from "./remote-editor-frame.tsx";
import { RemoteComputerNetwork } from "./remote-computer-setup.tsx";
import { ComputerUseDownloadDialog } from "./computer-use-download-dialog.tsx";

function ComputerUseChoice() {
  const { t } = useTranslation();
  const params = useGet(searchParams$);
  const closeComputerUse = useSet(closeRemoteComputerUseSetup$);
  return (
    <>
      <Link
        pathname="/connectors"
        options={{
          searchParams: new URLSearchParams({
            scope: "remote-control",
            setup: "computer-use",
            computerUseStep: "install",
          }),
        }}
        className={cn(
          buttonVariants({ variant: "outline" }),
          "h-auto min-h-24 justify-start gap-4 whitespace-normal rounded-xl border-divider p-5 text-left",
        )}
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-nested-fill">
          <Laptop size={22} aria-hidden />
        </span>
        <span className="grid min-w-0 flex-1 gap-1.5">
          <span className="text-base font-semibold">
            {t(($) => {
              return $.remoteControlSetup.computerUse;
            })}
          </span>
          <span className="text-sm font-normal leading-relaxed text-muted-foreground">
            {t(($) => {
              return $.remoteControlSetup.computerUseDescription;
            })}
          </span>
        </span>
        <ArrowRight size={16} className="shrink-0" aria-hidden />
      </Link>
      {params.get("setup") === "computer-use" && (
        <ComputerUseDownloadDialog
          open
          downloadUrl={OKOU_DESKTOP_DOWNLOAD_URL}
          onOpenChange={(open) => {
            if (!open) {
              closeComputerUse();
            }
          }}
        />
      )}
    </>
  );
}

function ProtocolChoice({
  setup,
  vncEnabled,
}: {
  readonly setup: RemoteSetup;
  readonly vncEnabled: boolean;
}) {
  const { t } = useTranslation();
  const choose = useSet(chooseRemoteProtocol$);
  const [opening, open] = useLoadableSet(openRemoteLogin$);
  const signal = useGet(pageSignal$);
  const options = [
    {
      value: "ssh" as const,
      label: t(($) => {
        return setup.fromComputer
          ? $.remoteComputerSetup.commands
          : $.ssh.label;
      }),
      description: t(($) => {
        return $.remoteControlSetup.sshDescription;
      }),
      icon: <Terminal size={22} aria-hidden />,
    },
    ...(vncEnabled
      ? [
          {
            value: "vnc" as const,
            label: t(($) => {
              return setup.fromComputer
                ? $.remoteComputerSetup.screen
                : $.vnc.label;
            }),
            description: t(($) => {
              return $.remoteControlSetup.vncDescription;
            }),
            icon: <Monitor size={22} aria-hidden />,
          },
        ]
      : []),
  ];
  return (
    <div className="grid gap-3">
      {!setup.sourceNetwork && <ComputerUseChoice />}
      {options.map((option) => {
        return (
          <Button
            key={option.value}
            variant="outline"
            disabled={opening.state === "loading"}
            className="h-auto min-h-24 justify-start gap-4 whitespace-normal rounded-xl border-divider p-5 text-left"
            onClick={() => {
              choose(option.value);
              detach(open(signal), Reason.DomCallback);
            }}
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-nested-fill">
              {option.icon}
            </span>
            <span className="grid min-w-0 flex-1 gap-1.5">
              <span className="text-base font-semibold">{option.label}</span>
              <span className="text-sm font-normal leading-relaxed text-muted-foreground">
                {option.description}
              </span>
            </span>
            <ArrowRight size={16} className="shrink-0" aria-hidden />
          </Button>
        );
      })}
      {opening.state === "hasError" && (
        <p role="alert" className="text-sm text-destructive">
          {t(($) => {
            return $.remoteControlSetup.failedLoad;
          })}
        </p>
      )}
    </div>
  );
}
function SetupEntry({
  setup,
  vncEnabled,
}: {
  readonly setup: RemoteSetup;
  readonly vncEnabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-6">
      <header className="grid gap-1.5">
        <h2 className="text-base font-semibold">
          {t(($) => {
            return setup.fromComputer
              ? $.remoteComputerSetup.operationTitle
              : $.remoteControlSetup.entryTitle;
          })}
        </h2>
        {setup.sourceNetwork && (
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t(($) => {
              return $.remoteControlSetup.entryDescription;
            })}
          </p>
        )}
      </header>
      <ProtocolChoice setup={setup} vncEnabled={vncEnabled} />
    </div>
  );
}
function RemoteSetupForms({ setup }: { readonly setup: RemoteSetup }) {
  const leave = useSet(leaveRemoteSetup$);
  return (
    <>
      {setup.formStarted && (
        <div hidden={setup.step !== "login"}>
          {setup.protocol === "ssh" ? (
            <SshDialog
              inline
              saveAction={saveRemoteSsh$}
              onCancel={leave}
              initialHost={setup.address}
              initialPort={setup.port}
            />
          ) : (
            <VncDialog inline saveAction={saveRemoteVnc$} onCancel={leave} />
          )}
        </div>
      )}
      {setup.protocol === "vnc" && <SshDialog />}
    </>
  );
}
function RemoteSetupSaved({ setup }: { readonly setup: RemoteSetup }) {
  const { t } = useTranslation();
  const params = useGet(searchParams$);
  const leave = useSet(leaveRemoteSetup$);
  const name = useLoadable(remoteSetupSavedName$);
  if (name.state !== "hasData" || name.data === null) {
    return (
      <div className="grid justify-items-center gap-4 py-12">
        <p
          role={name.state === "loading" ? "status" : "alert"}
          className="text-sm text-muted-foreground"
        >
          {t(($) => {
            return name.state === "loading"
              ? $.remoteControlSetup.loading
              : name.state === "hasError"
                ? setup.protocol === "ssh"
                  ? $.ssh.loadFailed
                  : $.vnc.loadFailed
                : $.remoteControlSetup.resourceUnavailable;
          })}
        </p>
        <Button variant="neutral" onClick={leave}>
          {t(($) => {
            return $.remoteControlSetup.cancel;
          })}
        </Button>
      </div>
    );
  }
  return (
    <div className="mx-auto grid w-full max-w-xl justify-items-center gap-5 py-12 text-center">
      <span className="rounded-full bg-gray-50 p-3">
        <Check size={24} aria-hidden />
      </span>
      <h2 className="text-lg font-semibold">
        {t(($) => {
          return $.remoteControlSetup.saved;
        })}
      </h2>
      <p className="font-medium">{name.data}</p>
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.remoteControlSetup.savedHelp;
        })}
      </p>
      {setup.savedId && (
        <Link
          pathname="/connectors"
          options={{
            searchParams: remoteResourceSearchParams(
              params,
              setup.protocol,
              setup.savedId,
            ),
          }}
          className={cn(
            buttonVariants(),
            REMOTE_PAGE_ACTION,
            "justify-self-center",
          )}
        >
          {t(($) => {
            return $.remoteControlSetup.viewConnection;
          })}
        </Link>
      )}
      <Button variant="quiet" className="justify-self-center" onClick={leave}>
        {t(($) => {
          return $.remoteControlSetup.cancel;
        })}
      </Button>
    </div>
  );
}

function RemoteSetupHeader({ setup }: { readonly setup: RemoteSetup }) {
  const { t } = useTranslation();
  const goBack = useSet(goBackRemoteSetup$);
  return (
    <div className="flex items-center justify-between gap-4">
      <Button variant="quiet" onClick={goBack}>
        <ArrowLeft size={16} aria-hidden />
        {t(($) => {
          return $.remoteControlSetup.back;
        })}
      </Button>
      {setup.protocol === "vnc" && setup.step === "login" && (
        <p className="text-sm text-muted-foreground">
          {["profile", "connection", "login", "trust"].indexOf(setup.vncStep) +
            1}{" "}
          / 4
        </p>
      )}
    </div>
  );
}
export function RemoteConnectionSetup({
  vncEnabled,
}: {
  readonly vncEnabled: boolean;
}) {
  const setup = useGet(remoteSetup$);
  if (!setup) {
    return null;
  }
  return (
    <div
      className={cn(
        "grid w-full gap-6",
        (setup.step !== "entry" || setup.fromComputer) &&
          "mx-auto max-w-[760px]",
      )}
    >
      {(setup.step !== "entry" || setup.fromComputer) && (
        <RemoteSetupHeader setup={setup} />
      )}
      {setup.step === "entry" && (
        <SetupEntry setup={setup} vncEnabled={vncEnabled} />
      )}
      {setup.step === "computer-network" && <RemoteComputerNetwork />}
      <RemoteSetupForms setup={setup} />
      {setup.step === "saved" && <RemoteSetupSaved setup={setup} />}
    </div>
  );
}
