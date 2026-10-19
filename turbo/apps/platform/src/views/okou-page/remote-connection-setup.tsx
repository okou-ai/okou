import { searchParams$ } from "../../signals/route.ts";
import { RemoteTailscaleCredentialHelp } from "./remote-network-help.tsx";
import { NetworkProviderPicker } from "./remote-network-picker.tsx";
import type { ReactNode } from "react";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Monitor,
  Terminal,
} from "lucide-react";
import {
  Button,
  Card,
  CopyButton,
  Input,
  LoadErrorRow,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SegmentControl,
  SegmentControlItem,
} from "@okouai/ui";
import { buttonVariants } from "@okouai/ui/components/ui/button";
import { cn } from "@okouai/ui/lib/utils";
import {
  beginRemoteGuide$,
  leaveRemoteSetup$,
  openRemoteLogin$,
  openRemoteNetwork$,
  remoteSetup$,
  saveRemoteCloudflare$,
  saveRemoteSsh$,
  saveRemoteTailscale$,
  saveRemoteVnc$,
  updateRemoteSetup$,
  type RemoteSetup,
  type RemoteSetupOs,
} from "../../signals/remote-control-setup.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  tailscaleConfigs$,
  tailscaleDialog$,
  tailscaleEnabled$,
  retryTailscale$,
} from "../../signals/tailscale.ts";
import {
  cloudflareAccessConfigs$,
  cloudflareAccessDialog$,
  retryCloudflareAccess$,
} from "../../signals/cloudflare-access.ts";
import { SshDialog } from "./ssh-management.tsx";
import { VncDialog } from "./vnc-dialog.tsx";
import { TailscaleDialog } from "./tailscale-management.tsx";
import { CloudflareAccessDialog } from "./cloudflare-access.tsx";
import { REMOTE_PAGE_ACTION } from "./remote-editor-frame.tsx";

function ExternalGuide({
  href,
  children,
}: {
  readonly href: string;
  readonly children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(buttonVariants({ variant: "outline" }), "w-fit")}
    >
      {children}
      <ExternalLink size={14} aria-hidden />
    </a>
  );
}
function StepCard({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Card surface="composer" className="grid gap-6 p-6">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </Card>
  );
}
function ContinueButton({
  onClick,
  disabled,
  children,
}: {
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex justify-end border-t border-divider pt-5">
      <Button
        type="button"
        className={REMOTE_PAGE_ACTION}
        onClick={onClick}
        disabled={disabled}
      >
        {children ??
          t(($) => {
            return $.remoteControlSetup.next;
          })}
        <ArrowRight size={16} aria-hidden />
      </Button>
    </div>
  );
}
function OperationError({ failed }: { readonly failed: boolean }) {
  const { t } = useTranslation();
  return failed ? (
    <p role="alert" className="text-sm text-destructive">
      {t(($) => {
        return $.remoteControlSetup.failedLoad;
      })}
    </p>
  ) : null;
}
function SetupProgress({ setup }: { readonly setup: RemoteSetup }) {
  const { t } = useTranslation();
  if (setup.step === "entry" || setup.step === "existing") {
    return null;
  }
  const vnc = setup.protocol === "vnc";
  const active =
    setup.step === "saved"
      ? 3
      : vnc
        ? setup.step === "os" || setup.step === "service"
          ? 1
          : setup.vncStep === "profile" || setup.vncStep === "connection"
            ? 2
            : 3
        : setup.step === "login"
          ? 3
          : setup.step === "prepare"
            ? 2
            : 1;
  const labels = [
    t(($) => {
      return vnc
        ? $.remoteControlSetup.prepareProgress
        : $.remoteControlSetup.networkProgress;
    }),
    t(($) => {
      return vnc
        ? $.remoteControlSetup.connectionProgress
        : $.remoteControlSetup.prepareProgress;
    }),
    t(($) => {
      return $.remoteControlSetup.loginProgress;
    }),
  ];
  return (
    <ol className="flex flex-wrap items-center justify-center gap-4 text-xs text-muted-foreground">
      {labels.map((label, index) => {
        return (
          <li
            key={label}
            aria-current={active === index + 1 ? "step" : undefined}
            className="flex items-center gap-2"
          >
            <span
              className={cn(
                "flex size-6 items-center justify-center rounded-full border border-divider",
                active === index + 1 && "bg-foreground text-background",
              )}
            >
              {index + 1}
            </span>
            {label}
          </li>
        );
      })}
    </ol>
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
  const update = useSet(updateRemoteSetup$);
  const [starting, start] = useLoadableSet(beginRemoteGuide$);
  const signal = useGet(pageSignal$);
  return (
    <div className="grid gap-6">
      <h2 className="text-lg font-semibold">
        {t(($) => {
          return $.remoteControlSetup.entryTitle;
        })}
      </h2>
      <SegmentControl
        value={setup.protocol}
        onValueChange={(value) => {
          update({
            protocol: value === "vnc" && vncEnabled ? "vnc" : "ssh",
            port: value === "vnc" ? "5900" : "22",
          });
        }}
        aria-label={t(($) => {
          return $.remoteControlSetup.entryTitle;
        })}
      >
        <SegmentControlItem value="ssh" className="flex-1">
          <Terminal size={18} aria-hidden />
          <span className="grid gap-1 text-left">
            <strong>SSH</strong>
            <span className="font-normal">
              {t(($) => {
                return $.remoteControlSetup.sshDescription;
              })}
            </span>
          </span>
        </SegmentControlItem>
        {vncEnabled && (
          <SegmentControlItem value="vnc" className="flex-1">
            <Monitor size={18} aria-hidden />
            <span className="grid gap-1 text-left">
              <strong>VNC</strong>
              <span className="font-normal">
                {t(($) => {
                  return $.remoteControlSetup.vncDescription;
                })}
              </span>
            </span>
          </SegmentControlItem>
        )}
      </SegmentControl>
      <StepCard
        title={t(($) => {
          return $.remoteControlSetup.setupTitle;
        })}
      >
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.remoteControlSetup.setupDescription;
          })}
        </p>
        <Button
          className={cn(REMOTE_PAGE_ACTION, "w-fit")}
          disabled={starting.state === "loading"}
          onClick={() => {
            detach(start(signal), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return $.remoteControlSetup.start;
          })}
          <ArrowRight size={16} aria-hidden />
        </Button>
        <OperationError failed={starting.state === "hasError"} />
      </StepCard>
      <Button
        variant="quiet"
        className="justify-self-start"
        onClick={() => {
          update({ step: setup.protocol === "vnc" ? "os" : "existing" });
        }}
      >
        {t(($) => {
          return $.remoteControlSetup.existing;
        })}
      </Button>
    </div>
  );
}
function SavedNetworkPicker({ setup }: { readonly setup: RemoteSetup }) {
  const { t } = useTranslation();
  const tailscale = useLoadable(tailscaleConfigs$);
  const access = useLoadable(cloudflareAccessConfigs$);
  const update = useSet(updateRemoteSetup$);
  const retryTailscale = useSet(retryTailscale$);
  const retryAccess = useSet(retryCloudflareAccess$);
  const signal = useGet(pageSignal$);
  const configs = setup.route === "tailscale" ? tailscale : access;
  if (configs.state === "loading") {
    return (
      <p role="status">
        {t(($) => {
          return $.remoteControlSetup.loading;
        })}
      </p>
    );
  }
  if (configs.state === "hasError") {
    return (
      <LoadErrorRow
        message={t(($) => {
          return $.remoteControlSetup.failedLoad;
        })}
        retryLabel={t(($) => {
          return $.remoteControlSetup.retry;
        })}
        onRetry={() => {
          return setup.route === "tailscale"
            ? retryTailscale(signal)
            : retryAccess(signal);
        }}
      />
    );
  }
  if (!configs.data) {
    return (
      <p role="alert">
        {t(($) => {
          return setup.route === "tailscale"
            ? $.remoteControlSetup.failedLoad
            : $.cloudflareAccess.unavailable;
        })}
      </p>
    );
  }
  const items =
    configs.data?.map((network) => {
      return { value: network.id, label: network.name };
    }) ?? [];
  if (!items.length) {
    return null;
  }
  return (
    <div className="grid gap-2">
      <label htmlFor="remote-setup-network">
        {t(($) => {
          return $.remoteControlSetup.network;
        })}
      </label>
      <Select
        items={items}
        value={setup.networkId || null}
        onValueChange={(value) => {
          if (value !== null) {
            update({ networkId: value });
          }
        }}
      >
        <SelectTrigger id="remote-setup-network">
          <SelectValue
            placeholder={t(($) => {
              return $.remoteControlSetup.network;
            })}
          />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => {
            return (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}
function InstallStep({ setup }: { readonly setup: RemoteSetup }) {
  const { t } = useTranslation();
  const update = useSet(updateRemoteSetup$);
  return (
    <StepCard
      title={t(($) => {
        return $.remoteControlSetup.installTitle;
      })}
    >
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.remoteControlSetup.installHelp;
        })}
      </p>
      <ExternalGuide href="https://tailscale.com/download">
        {t(($) => {
          return $.remoteControlSetup.download;
        })}
      </ExternalGuide>
      <SavedNetworkPicker setup={setup} />
      {setup.networkId && (
        <Button
          variant="quiet"
          className="justify-self-start"
          onClick={() => {
            update({ networkId: "" });
          }}
        >
          {t(($) => {
            return $.remoteControlSetup.newNetwork;
          })}
        </Button>
      )}
      <ContinueButton
        onClick={() => {
          update({ step: "address" });
        }}
      >
        {t(($) => {
          return $.remoteControlSetup.installed;
        })}
      </ContinueButton>
    </StepCard>
  );
}
function AddressStep({ setup }: { readonly setup: RemoteSetup }) {
  const { t } = useTranslation();
  const update = useSet(updateRemoteSetup$);
  const cloudflare = setup.step === "cf-address";
  return (
    <StepCard
      title={t(($) => {
        return cloudflare
          ? $.remoteControlSetup.cfAddressTitle
          : $.remoteControlSetup.addressTitle;
      })}
    >
      <form
        className="grid gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          update({
            step: cloudflare
              ? "cf-access"
              : setup.networkId
                ? "prepare"
                : "tag",
          });
        }}
      >
        <label className="grid gap-2">
          {t(($) => {
            return $.remoteControlSetup.address;
          })}
          <Input
            value={setup.address}
            onChange={(event) => {
              update({ address: event.target.value });
            }}
            required
            maxLength={253}
            pattern={
              cloudflare
                ? String.raw`[^\s/:]+(?:\.[^\s/:]+)+`
                : String.raw`(?:100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.(?:[0-9]{1,3})\.(?:[0-9]{1,3})|fd7a:[0-9a-fA-F:]+)`
            }
          />
        </label>
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return cloudflare
              ? $.remoteControlSetup.cfAddressHelp
              : $.remoteControlSetup.addressHelp;
          })}
        </p>
        {!cloudflare && (
          <ExternalGuide href="https://console.tailscale.com/admin/machines">
            {t(($) => {
              return $.remoteControlSetup.machines;
            })}
          </ExternalGuide>
        )}
        <div className="flex justify-end border-t border-divider pt-5">
          <Button type="submit" className={REMOTE_PAGE_ACTION}>
            {t(($) => {
              return $.remoteControlSetup.next;
            })}
            <ArrowRight size={16} aria-hidden />
          </Button>
        </div>
      </form>
    </StepCard>
  );
}
function CopyValue({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-[1fr_1fr_auto] items-center gap-3 border-b border-divider p-4 last:border-b-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-all font-mono">{value}</dd>
      <CopyButton
        text={value}
        aria-label={`${t(($) => {
          return $.remoteControlSetup.copy;
        })} ${label}`}
      />
    </div>
  );
}
function TagStep() {
  const { t } = useTranslation();
  const update = useSet(updateRemoteSetup$);
  return (
    <StepCard
      title={t(($) => {
        return $.remoteControlSetup.tagTitle;
      })}
    >
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.remoteControlSetup.tagDescription;
        })}
      </p>
      <h3 className="font-medium">
        {t(($) => {
          return $.remoteControlSetup.openTags;
        })}
      </h3>
      <ExternalGuide href="https://console.tailscale.com/admin/acls">
        {t(($) => {
          return $.remoteControlSetup.openTailscale;
        })}
      </ExternalGuide>
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.remoteControlSetup.tagPath;
        })}
      </p>
      <h3 className="font-medium">
        {t(($) => {
          return $.remoteControlSetup.fillTag;
        })}
      </h3>
      <dl className="rounded-xl border border-divider bg-gray-50 text-sm">
        <CopyValue
          label={t(($) => {
            return $.remoteControlSetup.tagName;
          })}
          value="okou"
        />
        <div className="grid grid-cols-2 gap-3 p-4">
          <dt>
            {t(($) => {
              return $.remoteControlSetup.tagOwner;
            })}
          </dt>
          <dd>
            {t(($) => {
              return $.remoteControlSetup.tagOwnerValue;
            })}
          </dd>
        </div>
      </dl>
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.remoteControlSetup.tagValueHelp;
        })}
      </p>
      <details className="border-t border-divider pt-4">
        <summary className="cursor-pointer rounded-md p-2 text-sm hover:bg-gray-50">
          {t(($) => {
            return $.remoteControlSetup.details;
          })}
        </summary>
        <p className="p-2 text-sm text-muted-foreground">
          {t(($) => {
            return $.remoteControlSetup.tagDetails;
          })}
        </p>
      </details>
      <p className="text-sm">
        {t(($) => {
          return $.remoteControlSetup.tagTarget;
        })}
      </p>
      <ContinueButton
        onClick={() => {
          update({ step: "rule" });
        }}
      >
        {t(($) => {
          return $.remoteControlSetup.tagDone;
        })}
      </ContinueButton>
    </StepCard>
  );
}
function RuleStep({ setup }: { readonly setup: RemoteSetup }) {
  const { t } = useTranslation();
  const update = useSet(updateRemoteSetup$);
  const [opening, open] = useLoadableSet(openRemoteNetwork$);
  const signal = useGet(pageSignal$);
  const validPort =
    /^\d+$/u.test(setup.port) &&
    Number(setup.port) >= 1 &&
    Number(setup.port) <= 65_535;
  const grant = JSON.stringify(
    { src: ["tag:okou"], dst: [setup.address], ip: [`tcp:${setup.port}`] },
    null,
    2,
  );
  return (
    <StepCard
      title={t(($) => {
        return $.remoteControlSetup.ruleTitle;
      })}
    >
      <h3 className="font-medium">
        {t(($) => {
          return $.remoteControlSetup.openRules;
        })}
      </h3>
      <ExternalGuide href="https://console.tailscale.com/admin/acls">
        {t(($) => {
          return $.remoteControlSetup.openTailscale;
        })}
      </ExternalGuide>
      <h3 className="font-medium">
        {t(($) => {
          return $.remoteControlSetup.fillRules;
        })}
      </h3>
      <dl className="rounded-xl border border-divider bg-gray-50 text-sm">
        <CopyValue
          label={t(($) => {
            return $.remoteControlSetup.source;
          })}
          value="tag:okou"
        />
        <CopyValue
          label={t(($) => {
            return $.remoteControlSetup.destination;
          })}
          value={setup.address}
        />
        <CopyValue
          label={t(($) => {
            return $.remoteControlSetup.protocolPort;
          })}
          value={`tcp:${setup.port}`}
        />
      </dl>
      <details>
        <summary className="cursor-pointer rounded-md p-2 text-sm hover:bg-gray-50">
          {t(($) => {
            return $.remoteControlSetup.customPort;
          })}
        </summary>
        <label className="mt-3 grid gap-2">
          {t(($) => {
            return $.remoteControlSetup.port;
          })}
          <Input
            type="number"
            min={1}
            max={65_535}
            required
            value={setup.port}
            onChange={(event) => {
              update({ port: event.target.value });
            }}
          />
        </label>
      </details>
      <details>
        <summary className="cursor-pointer rounded-md p-2 text-sm hover:bg-gray-50">
          {t(($) => {
            return $.remoteControlSetup.ruleExample;
          })}
        </summary>
        <div className="relative mt-3 rounded-xl bg-gray-50 p-4">
          <pre className="overflow-auto text-xs">{grant}</pre>
          <CopyButton
            text={grant}
            disabled={!validPort}
            aria-label={t(($) => {
              return $.remoteControlSetup.copy;
            })}
          />
        </div>
      </details>
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.remoteControlSetup.ruleHelp;
        })}
      </p>
      <OperationError failed={opening.state === "hasError"} />
      <ContinueButton
        disabled={!validPort || opening.state === "loading"}
        onClick={() => {
          detach(open("tailscale", signal), Reason.DomCallback);
        }}
      >
        {t(($) => {
          return $.remoteControlSetup.ruleDone;
        })}
      </ContinueButton>
    </StepCard>
  );
}
function OsChoice({ setup }: { readonly setup: RemoteSetup }) {
  const { t } = useTranslation();
  const update = useSet(updateRemoteSetup$);
  const items = [
    {
      value: "mac",
      label: t(($) => {
        return $.remoteControlSetup.mac;
      }),
    },
    {
      value: "windows",
      label: t(($) => {
        return $.remoteControlSetup.windows;
      }),
    },
    {
      value: "linux",
      label: t(($) => {
        return $.remoteControlSetup.linux;
      }),
    },
  ];
  return (
    <div className="grid gap-2">
      <label htmlFor="remote-setup-os">
        {t(($) => {
          return $.remoteControlSetup.os;
        })}
      </label>
      <Select
        items={items}
        value={setup.os}
        onValueChange={(value, details) => {
          if (value !== "mac" && value !== "windows" && value !== "linux") {
            details.cancel();
            return;
          }
          update({ os: value });
        }}
      >
        <SelectTrigger id="remote-setup-os">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => {
            return (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}
const SSH_INSTRUCTIONS: Readonly<Record<RemoteSetupOs, string>> = {
  mac: "https://support.apple.com/guide/mac-help/allow-a-remote-computer-to-access-your-mac-mchlp1066/mac",
  windows:
    "https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse",
  linux:
    "https://documentation.ubuntu.com/server/how-to/security/openssh-server/",
};
function ServiceStep({ setup }: { readonly setup: RemoteSetup }) {
  const { t } = useTranslation();
  const update = useSet(updateRemoteSetup$);
  const [opening, open] = useLoadableSet(openRemoteLogin$);
  const signal = useGet(pageSignal$);
  const vnc = setup.protocol === "vnc";
  return (
    <StepCard
      title={t(($) => {
        return setup.step === "os"
          ? $.remoteControlSetup.os
          : vnc
            ? $.remoteControlSetup.serviceTitle
            : $.remoteControlSetup.prepareTitle;
      })}
    >
      <OsChoice setup={setup} />
      {setup.step !== "os" && (
        <>
          <p className="text-sm leading-6">
            {t(($) => {
              return vnc
                ? setup.os === "mac"
                  ? $.remoteControlSetup.macVnc
                  : setup.os === "windows"
                    ? $.remoteControlSetup.windowsVnc
                    : $.remoteControlSetup.linuxVnc
                : setup.os === "mac"
                  ? $.remoteControlSetup.macSsh
                  : setup.os === "windows"
                    ? $.remoteControlSetup.windowsSsh
                    : $.remoteControlSetup.linuxSsh;
            })}
          </p>
          {vnc ? (
            <p className="text-sm text-muted-foreground">
              {t(($) => {
                return $.remoteControlSetup.serviceHelp;
              })}
            </p>
          ) : (
            <ExternalGuide href={SSH_INSTRUCTIONS[setup.os]}>
              {t(($) => {
                return $.remoteControlSetup.sshDocs;
              })}
            </ExternalGuide>
          )}
          {!vnc && setup.route === "tailscale" && (
            <SavedNetworkPicker setup={setup} />
          )}
        </>
      )}
      <OperationError failed={opening.state === "hasError"} />
      <ContinueButton
        disabled={
          opening.state === "loading" ||
          (!vnc && setup.route === "tailscale" && !setup.networkId)
        }
        onClick={() => {
          if (setup.step === "os") {
            update({ step: "service" });
          } else {
            detach(open(signal), Reason.DomCallback);
          }
        }}
      >
        {t(($) => {
          return setup.step === "os"
            ? $.remoteControlSetup.next
            : $.remoteControlSetup.ready;
        })}
      </ContinueButton>
    </StepCard>
  );
}
function ExistingStep() {
  const { t } = useTranslation();
  const update = useSet(updateRemoteSetup$);
  const tailscale = useGet(tailscaleEnabled$);
  const [opening, open] = useLoadableSet(openRemoteLogin$);
  const signal = useGet(pageSignal$);
  const setup = useGet(remoteSetup$);
  const [starting, start] = useLoadableSet(beginRemoteGuide$);
  return (
    <StepCard
      title={t(($) => {
        return $.remoteControlSetup.existingTitle;
      })}
    >
      <Button
        variant="neutral"
        className="h-auto justify-start gap-4 whitespace-normal p-5 text-left"
        disabled={opening.state === "loading"}
        onClick={() => {
          if (setup?.route !== "direct") {
            update({ route: "direct", address: "", formStarted: false });
          }
          detach(open(signal), Reason.DomCallback);
        }}
      >
        <Terminal size={20} aria-hidden />
        <span className="grid gap-2">
          <strong>
            {t(($) => {
              return $.remoteControlSetup.direct;
            })}
          </strong>
          <span className="font-normal text-muted-foreground">
            {t(($) => {
              return $.remoteControlSetup.directHelp;
            })}
          </span>
        </span>
      </Button>
      {tailscale && (
        <Button
          variant="neutral"
          className="h-auto justify-start whitespace-normal p-5 text-left"
          onClick={() => {
            if (setup?.route !== "tailscale") {
              update({ formStarted: false, address: "", networkId: "" });
            }
            detach(start(signal), Reason.DomCallback);
          }}
        >
          <span className="grid gap-2">
            <strong>Tailscale</strong>
            <span className="font-normal text-muted-foreground">
              {t(($) => {
                return $.remoteControlSetup.tailscaleHelp;
              })}
            </span>
          </span>
        </Button>
      )}
      <Button
        variant="neutral"
        className="h-auto justify-start whitespace-normal p-5 text-left"
        onClick={() => {
          update({
            route: "cloudflare_access",
            step: "cf-address",
            address: "",
            networkId: "",
            formStarted: false,
          });
        }}
      >
        <span className="grid gap-2">
          <strong>Cloudflare Access</strong>
          <span className="font-normal text-muted-foreground">
            {t(($) => {
              return $.remoteControlSetup.cloudflareHelp;
            })}
          </span>
        </span>
      </Button>
      <OperationError
        failed={opening.state === "hasError" || starting.state === "hasError"}
      />
    </StepCard>
  );
}
function CloudflareStep({ setup }: { readonly setup: RemoteSetup }) {
  const { t } = useTranslation();
  const [opening, open] = useLoadableSet(openRemoteNetwork$);
  const [loggingIn, login] = useLoadableSet(openRemoteLogin$);
  const signal = useGet(pageSignal$);
  const dialog = useLoadable(cloudflareAccessDialog$);
  return (
    <div className="grid gap-5">
      <StepCard
        title={t(($) => {
          return $.remoteControlSetup.cfAccessTitle;
        })}
      >
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.remoteControlSetup.cfTokenHelp;
          })}
        </p>
        <ExternalGuide href="https://one.dash.cloudflare.com/">
          {t(($) => {
            return $.remoteControlSetup.openCloudflare;
          })}
        </ExternalGuide>
        <SavedNetworkPicker setup={setup} />
        <Button
          variant="outline"
          className="justify-self-start"
          disabled={opening.state === "loading"}
          onClick={() => {
            detach(open("cloudflare_access", signal), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return $.remoteControlSetup.addToken;
          })}
        </Button>
        <OperationError
          failed={
            opening.state === "hasError" || loggingIn.state === "hasError"
          }
        />
        {!(dialog.state === "hasData" && dialog.data) && (
          <ContinueButton
            disabled={!setup.networkId || loggingIn.state === "loading"}
            onClick={() => {
              detach(login(signal), Reason.DomCallback);
            }}
          />
        )}
      </StepCard>
    </div>
  );
}
const PREVIOUS_STEP: Readonly<
  Partial<Record<RemoteSetup["step"], RemoteSetup["step"]>>
> = {
  existing: "entry",
  install: "entry",
  address: "install",
  tag: "address",
  rule: "tag",
  oauth: "rule",
  prepare: "address",
  os: "entry",
  service: "os",
  "cf-address": "existing",
  "cf-access": "cf-address",
};
function RemoteSetupForms({ setup }: { readonly setup: RemoteSetup }) {
  const leave = useSet(leaveRemoteSetup$);
  return (
    <>
      {/* Keep mounted forms while going back, so non-sensitive values are retained.
        The existing form owners erase secrets when the flow is left. */}
      {setup.protocol === "ssh" ? (
        <div hidden={setup.step !== "oauth"}>
          <TailscaleDialog inline saveAction={saveRemoteTailscale$} />
        </div>
      ) : (
        <TailscaleDialog />
      )}
      {setup.protocol === "ssh" ? (
        <div hidden={setup.step !== "cf-access"}>
          <CloudflareAccessDialog inline saveAction={saveRemoteCloudflare$} />
        </div>
      ) : (
        <CloudflareAccessDialog />
      )}
      <NetworkProviderPicker />
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
  const returnThread = useGet(searchParams$).get("returnThread");
  const leave = useSet(leaveRemoteSetup$);
  return (
    <StepCard
      title={t(($) => {
        return $.remoteControlSetup.saved;
      })}
    >
      <p className="font-medium">{setup.savedName}</p>
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.remoteControlSetup.savedHelp;
        })}
      </p>
      <a
        href={
          returnThread &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
            returnThread,
          )
            ? `/chats/${returnThread}`
            : `/?${new URLSearchParams({
                prompt: t(
                  ($) => {
                    return $.remoteControlSetup.checkPrompt;
                  },
                  {
                    name: setup.savedName,
                    protocol: setup.protocol.toUpperCase(),
                  },
                ),
              }).toString()}`
        }
        className={cn(
          buttonVariants(),
          REMOTE_PAGE_ACTION,
          "justify-self-start",
        )}
      >
        {t(($) => {
          return $.remoteControlSetup.openChat;
        })}
      </a>
      <Button variant="quiet" className="justify-self-start" onClick={leave}>
        {t(($) => {
          return $.remoteControlSetup.cancel;
        })}
      </Button>
    </StepCard>
  );
}
function RemoteSetupHeader({ setup }: { readonly setup: RemoteSetup }) {
  const { t } = useTranslation();
  const leave = useSet(leaveRemoteSetup$);
  const update = useSet(updateRemoteSetup$);
  return (
    <div className="flex items-center justify-between gap-3">
      <Button
        variant="quiet"
        onClick={() => {
          if (setup.step === "entry" || setup.step === "saved") {
            leave();
            return;
          }
          if (
            setup.step === "login" &&
            setup.protocol === "vnc" &&
            setup.vncStep !== "profile"
          ) {
            update({
              vncStep:
                setup.vncStep === "trust"
                  ? "login"
                  : setup.vncStep === "login"
                    ? "connection"
                    : "profile",
            });
            return;
          }
          update({
            step:
              setup.step === "login"
                ? setup.protocol === "vnc"
                  ? "service"
                  : setup.route === "direct"
                    ? "existing"
                    : setup.route === "cloudflare_access"
                      ? "cf-access"
                      : "prepare"
                : (PREVIOUS_STEP[setup.step] ?? "entry"),
          });
        }}
      >
        <ArrowLeft size={16} aria-hidden />
        {t(($) => {
          return $.remoteControlSetup.back;
        })}
      </Button>
      <span className="text-sm text-muted-foreground">
        {setup.protocol === "ssh" ? "SSH" : "VNC"}
      </span>
    </div>
  );
}
export function RemoteConnectionSetup({
  vncEnabled,
}: {
  readonly vncEnabled: boolean;
}) {
  const { t } = useTranslation();
  const setup = useGet(remoteSetup$);
  const networkDialog = useLoadable(tailscaleDialog$);
  const [opening, openNetwork] = useLoadableSet(openRemoteNetwork$);
  const signal = useGet(pageSignal$);
  if (!setup) {
    return null;
  }
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-6 pb-8">
      <RemoteSetupHeader setup={setup} />
      <SetupProgress setup={setup} />
      {setup.step === "entry" && (
        <SetupEntry setup={setup} vncEnabled={vncEnabled} />
      )}
      {setup.step === "existing" && <ExistingStep />}
      {setup.step === "install" && <InstallStep setup={setup} />}
      {(setup.step === "address" || setup.step === "cf-address") && (
        <AddressStep setup={setup} />
      )}
      {setup.step === "tag" && <TagStep />}
      {setup.step === "rule" && <RuleStep setup={setup} />}
      {setup.step === "oauth" && (
        <StepCard
          title={t(($) => {
            return $.remoteControlSetup.oauthTitle;
          })}
        >
          <RemoteTailscaleCredentialHelp />
          {networkDialog.state === "hasData" && !networkDialog.data && (
            <Button
              className={cn(REMOTE_PAGE_ACTION, "justify-self-start")}
              onClick={() => {
                detach(openNetwork("tailscale", signal), Reason.DomCallback);
              }}
              disabled={opening.state === "loading"}
            >
              {t(($) => {
                return $.remoteControlSetup.createNetwork;
              })}
            </Button>
          )}
          <OperationError failed={opening.state === "hasError"} />
        </StepCard>
      )}
      {(setup.step === "prepare" ||
        setup.step === "os" ||
        setup.step === "service") && <ServiceStep setup={setup} />}
      {setup.step === "cf-access" && <CloudflareStep setup={setup} />}
      <RemoteSetupForms setup={setup} />
      {setup.step === "saved" && <RemoteSetupSaved setup={setup} />}
    </div>
  );
}
