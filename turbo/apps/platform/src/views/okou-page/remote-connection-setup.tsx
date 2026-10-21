import { RemoteServiceInstructions } from "./remote-service-instructions.tsx";
import { remoteResourceSearchParams } from "../../signals/remote-resource-detail.ts";
import { Link } from "../router/link.tsx";
import { searchParams$ } from "../../signals/route.ts";
import { NetworkProviderPicker } from "./remote-network-picker.tsx";
import type { ReactNode } from "react";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  LockKeyhole,
  Laptop,
  ArrowRight,
  ExternalLink,
  Monitor,
  Terminal,
  Cloud,
  Network,
  Link2,
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
  Radio,
  RadioGroup,
  SegmentControl,
  SegmentControlItem,
} from "@okouai/ui";
import { buttonVariants } from "@okouai/ui/components/ui/button";
import { cn } from "@okouai/ui/lib/utils";
import {
  beginRemoteGuide$,
  chooseRemoteProtocol$,
  goBackRemoteSetup$,
  leaveRemoteSetup$,
  openRemoteLogin$,
  openExistingRemoteSetup$,
  openRemoteNetwork$,
  remoteSetup$,
  remoteSetupTailscaleTags$,
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
      className={cn(
        buttonVariants({ variant: "outline" }),
        "h-auto min-h-10 w-fit whitespace-normal text-left",
      )}
    >
      {children}
      <ExternalLink size={14} aria-hidden />
    </a>
  );
}
function StepCard({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
}) {
  return (
    <Card surface="composer" className="grid gap-6 p-5 text-sm sm:p-6">
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
function hideSetupProgress(setup: RemoteSetup) {
  return (
    setup.step === "entry" ||
    setup.step === "existing" ||
    setup.step === "saved" ||
    (setup.protocol === "ssh" &&
      (setup.route === "direct" ||
        (setup.entryMode === "existing" &&
          (setup.route === "tailscale" || setup.sourceNetwork !== null))))
  );
}
function SetupProgress({ setup }: { readonly setup: RemoteSetup }) {
  const { t } = useTranslation();
  if (hideSetupProgress(setup)) {
    return null;
  }
  const vnc = setup.protocol === "vnc";
  const active = vnc
    ? setup.step === "service"
      ? 1
      : setup.vncStep === "profile" || setup.vncStep === "connection"
        ? 2
        : 3
    : setup.step === "login" || setup.step === "prepare"
      ? 3
      : ["tag", "rule", "oauth", "cf-access", "cf-credentials"].includes(
            setup.step,
          )
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
        : $.remoteControlSetup.accessProgress;
    }),
    t(($) => {
      return $.remoteControlSetup.loginProgress;
    }),
  ];
  const existingVnc = vnc && setup.entryMode === "existing";
  const savedNetwork = !vnc && setup.sourceNetwork !== null;
  const visibleLabels = existingVnc
    ? labels.slice(1)
    : savedNetwork
      ? labels.filter((_, index) => {
          return index !== 1;
        })
      : labels;
  const activeStep = existingVnc
    ? active - 1
    : savedNetwork && active === 3
      ? 2
      : active;
  return (
    <ol className="order-3 grid w-full auto-cols-fr grid-flow-col gap-2 text-center text-sm text-muted-foreground sm:order-none sm:flex sm:w-auto sm:flex-1 sm:items-center sm:justify-center">
      {visibleLabels.map((label, index) => {
        return (
          <li
            key={label}
            aria-current={activeStep === index + 1 ? "step" : undefined}
            className="flex min-w-0 flex-col items-center gap-2 sm:flex-row"
          >
            {index > 0 && (
              <span
                className="mr-1 hidden h-px w-5 bg-divider sm:block"
                aria-hidden
              />
            )}
            <span
              className={cn(
                "flex size-[22px] shrink-0 items-center justify-center rounded-full border border-divider",
                activeStep === index + 1 &&
                  "border-foreground bg-foreground text-background",
              )}
            >
              {activeStep > index + 1 ? (
                <Check size={12} aria-hidden />
              ) : (
                index + 1
              )}
            </span>
            <span className={cn(activeStep === index + 1 && "text-foreground")}>
              {label}
            </span>
          </li>
        );
      })}
    </ol>
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
  const tailscale = useGet(tailscaleEnabled$);
  const options = [
    ...(setup.sourceNetwork?.route !== "tailscale" || tailscale
      ? [
          {
            value: "ssh",
            label: t(($) => {
              return $.ssh.label;
            }),
            description: t(($) => {
              return $.remoteControlSetup.sshDescription;
            }),
            icon: <Terminal size={20} aria-hidden />,
          },
        ]
      : []),
    ...(vncEnabled
      ? [
          {
            value: "vnc",
            label: t(($) => {
              return $.vnc.label;
            }),
            description: t(($) => {
              return $.remoteControlSetup.vncDescription;
            }),
            icon: <Monitor size={20} aria-hidden />,
          },
        ]
      : []),
  ];
  return (
    <RadioGroup
      value={setup.protocol}
      onValueChange={(value) => {
        choose(value === "vnc" && vncEnabled ? "vnc" : "ssh");
      }}
      aria-label={t(($) => {
        return $.remoteControlSetup.entryTitle;
      })}
      className={cn("grid gap-3", vncEnabled && "sm:grid-cols-2")}
    >
      {options.map((option) => {
        return (
          <label
            key={option.value}
            className="flex min-h-[84px] cursor-pointer items-center gap-3 rounded-xl border border-divider bg-background p-4 hover:bg-gray-50 has-data-checked:border-foreground has-data-checked:bg-gray-50 has-focus-visible:ring-2 has-focus-visible:ring-ring"
          >
            <span className="flex size-8 shrink-0 items-center justify-center">
              {option.icon}
            </span>
            <span className="grid min-w-0 flex-1 gap-1 text-left">
              <span className="text-sm font-medium">{option.label}</span>
              <span className="text-sm leading-5 text-muted-foreground">
                {option.description}
              </span>
            </span>
            <Radio
              aria-label={option.label}
              value={option.value}
              className="data-checked:border-foreground data-checked:bg-foreground"
            />
          </label>
        );
      })}
    </RadioGroup>
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
  const [starting, start] = useLoadableSet(beginRemoteGuide$);
  const [opening, openExisting] = useLoadableSet(openExistingRemoteSetup$);
  const signal = useGet(pageSignal$);
  const tailscale = useGet(tailscaleEnabled$);
  const canGuide =
    setup.protocol === "vnc" || tailscale || setup.sourceNetwork !== null;
  const busy = starting.state === "loading" || opening.state === "loading";
  return (
    <div>
      <header className="mb-6 grid gap-1">
        <h2 className="text-xl font-semibold tracking-tight">
          {t(($) => {
            return $.remoteControlSetup.entryTitle;
          })}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.remoteControlSetup.entryDescription;
          })}
        </p>
      </header>
      <ProtocolChoice setup={setup} vncEnabled={vncEnabled} />
      {setup.sourceNetwork && (
        <p className="mt-4 break-words rounded-lg bg-gray-50 px-4 py-3 text-sm text-muted-foreground">
          {t(
            ($) => {
              return $.remoteControlSetup.usingNetwork;
            },
            { name: setup.sourceNetwork.name },
          )}
        </p>
      )}
      <Card surface="composer" className="mt-4 grid gap-6 p-5 sm:p-6">
        <div className="grid gap-1">
          <h2 className="text-lg font-semibold tracking-tight">
            {t(($) => {
              return canGuide
                ? $.remoteControlSetup.setupTitle
                : $.remoteControlSetup.existingTitle;
            })}
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t(($) => {
              return canGuide
                ? $.remoteControlSetup.setupDescription
                : $.remoteControlSetup.existingDescription;
            })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:gap-5">
          {canGuide && (
            <Button
              className={REMOTE_PAGE_ACTION}
              disabled={busy}
              onClick={() => {
                detach(start(signal), Reason.DomCallback);
              }}
            >
              {t(($) => {
                return setup.sourceNetwork
                  ? $.remoteControlSetup.next
                  : $.remoteControlSetup.start;
              })}
            </Button>
          )}
          <Button
            variant={canGuide ? "quiet" : "default"}
            className={
              canGuide
                ? "h-auto whitespace-normal px-0 text-left text-sm"
                : REMOTE_PAGE_ACTION
            }
            disabled={busy}
            onClick={() => {
              detach(openExisting(signal), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return $.remoteControlSetup.existing;
            })}
            <ChevronRight size={14} aria-hidden />
          </Button>
        </div>
        <OperationError
          failed={starting.state === "hasError" || opening.state === "hasError"}
        />
      </Card>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <LockKeyhole size={14} aria-hidden />
          {t(($) => {
            return $.remoteControlSetup.entryPermission;
          })}
        </span>
      </div>
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
  const items = configs.data.map((network) => {
    return { value: network.id, label: network.name };
  });
  if (setup.formStarted && setup.networkId === "new") {
    items.push({
      value: "new",
      label: t(($) => {
        return $.remoteControlSetup.newNetwork;
      }),
    });
  }
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
            const network =
              tailscale.state === "hasData" && setup.route === "tailscale"
                ? tailscale.data?.find((item) => {
                    return item.id === value;
                  })
                : undefined;
            update({
              networkId: value,
              ...(network ? { tailscaleTags: network.tags.join(", ") } : {}),
            });
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
      description={t(($) => {
        return $.remoteControlSetup.installDescription;
      })}
    >
      <div className="flex items-center gap-4 rounded-xl border border-divider bg-gray-50 p-5">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-divider bg-background">
          <Laptop size={24} aria-hidden />
        </span>
        <div className="grid gap-1.5">
          <h3 className="text-sm font-medium">
            {t(($) => {
              return $.remoteControlSetup.installTarget;
            })}
          </h3>
          <p className="text-sm leading-5 text-muted-foreground">
            {t(($) => {
              return $.remoteControlSetup.installHelp;
            })}
          </p>
        </div>
      </div>
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
  const [opening, openLogin] = useLoadableSet(openRemoteLogin$);
  const signal = useGet(pageSignal$);
  const cloudflare = setup.step === "cf-address";
  return (
    <StepCard
      title={t(($) => {
        return cloudflare
          ? $.remoteControlSetup.cfAddressTitle
          : $.remoteControlSetup.addressTitle;
      })}
      description={t(($) => {
        return cloudflare
          ? $.remoteControlSetup.cfAddressHelp
          : $.remoteControlSetup.addressHelp;
      })}
    >
      <form
        className="grid gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (cloudflare && setup.sourceNetwork) {
            detach(openLogin(signal), Reason.DomCallback);
            return;
          }
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
            return cloudflare
              ? $.remoteControlSetup.cfAddressLabel
              : $.remoteControlSetup.address;
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
        {cloudflare && (
          <details className="border-t border-divider pt-4">
            <summary className="cursor-pointer rounded-md py-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {t(($) => {
                return $.remoteControlSetup.cfAddressWhere;
              })}
            </summary>
            <div className="grid gap-3 pt-4 text-sm">
              <ExternalGuide href="https://dash.cloudflare.com/">
                {t(($) => {
                  return $.remoteControlSetup.openCloudflare;
                })}
              </ExternalGuide>
              <p>
                {t(($) => {
                  return $.remoteControlSetup.cfAddressActions;
                })}
              </p>
              <p className="text-muted-foreground">
                {t(($) => {
                  return $.remoteControlSetup.cfAddressMissing;
                })}
              </p>
            </div>
          </details>
        )}
        {!cloudflare && (
          <details className="border-t border-divider pt-4">
            <summary className="cursor-pointer text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {t(($) => {
                return $.remoteControlSetup.addressWhere;
              })}
            </summary>
            <div className="grid gap-4 pt-4">
              <OsChoice setup={setup} />
              <p className="text-sm text-muted-foreground">
                {t(($) => {
                  return setup.os === "mac"
                    ? $.remoteControlSetup.addressMac
                    : setup.os === "windows"
                      ? $.remoteControlSetup.addressWindows
                      : $.remoteControlSetup.addressLinux;
                })}
              </p>
            </div>
          </details>
        )}
        <OperationError failed={opening.state === "hasError"} />
        <div className="flex justify-end border-t border-divider pt-5">
          <Button
            type="submit"
            className={REMOTE_PAGE_ACTION}
            disabled={opening.state === "loading"}
          >
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
  help,
}: {
  readonly label: string;
  readonly value: string;
  readonly help?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] items-center gap-3 border-b border-divider p-4 last:border-b-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="grid gap-1.5 break-all">
        <span className="font-mono">{value}</span>
        {help && <span className="text-sm text-muted-foreground">{help}</span>}
      </dd>
      <CopyButton
        text={value}
        aria-label={`${t(($) => {
          return $.remoteControlSetup.copy;
        })} ${label}`}
      />
    </div>
  );
}
function InstructionStep({
  number,
  title,
  action,
  children,
}: {
  readonly number: number;
  readonly title: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-divider bg-gray-50 text-sm">
          {number}
        </span>
        <h3 className="flex-1 text-sm font-semibold">{title}</h3>
        {action}
      </div>
      <div className="grid gap-3 sm:ml-9">{children}</div>
    </section>
  );
}
function TagStep() {
  const { t } = useTranslation();
  const update = useSet(updateRemoteSetup$);
  const tags = useGet(remoteSetupTailscaleTags$);
  return (
    <StepCard
      title={t(($) => {
        return $.remoteControlSetup.tagTitle;
      })}
      description={t(($) => {
        return $.remoteControlSetup.tagDescription;
      })}
    >
      <InstructionStep
        number={1}
        title={t(($) => {
          return $.remoteControlSetup.openTags;
        })}
        action={
          <ExternalGuide href="https://console.tailscale.com/admin/acls">
            {t(($) => {
              return $.remoteControlSetup.openTailscale;
            })}
          </ExternalGuide>
        }
      >
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.remoteControlSetup.tagPath;
          })}
        </p>
      </InstructionStep>
      <InstructionStep
        number={2}
        title={t(($) => {
          return $.remoteControlSetup.fillTag;
        })}
      >
        <dl className="overflow-hidden rounded-lg border border-divider bg-gray-50 text-sm">
          {tags.map((tag) => {
            return (
              <CopyValue
                key={tag}
                label={t(($) => {
                  return $.remoteControlSetup.tagName;
                })}
                value={tag.replace(/^tag:/u, "")}
                help={t(($) => {
                  return $.remoteControlSetup.tagValueHelp;
                })}
              />
            );
          })}
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3 p-4">
            <dt className="text-muted-foreground">
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
            return $.remoteControlSetup.tagSave;
          })}
        </p>
      </InstructionStep>
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
  const tags = useGet(remoteSetupTailscaleTags$);
  const [opening, open] = useLoadableSet(openRemoteNetwork$);
  const signal = useGet(pageSignal$);
  const grant = JSON.stringify(
    {
      src: tags,
      dst: [setup.address],
      ip: ["tcp:22"],
    },
    null,
    2,
  );
  return (
    <StepCard
      title={t(($) => {
        return $.remoteControlSetup.ruleTitle;
      })}
      description={t(($) => {
        return $.remoteControlSetup.ruleDescription;
      })}
    >
      <InstructionStep
        number={1}
        title={t(($) => {
          return $.remoteControlSetup.openRules;
        })}
        action={
          <ExternalGuide href="https://console.tailscale.com/admin/acls">
            {t(($) => {
              return $.remoteControlSetup.openTailscale;
            })}
          </ExternalGuide>
        }
      >
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.remoteControlSetup.rulePath;
          })}
        </p>
      </InstructionStep>
      <InstructionStep
        number={2}
        title={t(($) => {
          return $.remoteControlSetup.fillRules;
        })}
      >
        <dl className="rounded-xl border border-divider bg-gray-50 text-sm">
          <CopyValue
            label={t(($) => {
              return $.remoteControlSetup.source;
            })}
            value={tags.join(", ")}
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
            value="tcp:22"
          />
        </dl>
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.remoteControlSetup.ruleSave;
          })}
        </p>
      </InstructionStep>
      <details>
        <summary className="cursor-pointer rounded-md p-2 text-sm hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {t(($) => {
            return $.remoteControlSetup.ruleExample;
          })}
        </summary>
        <div className="relative mt-3 rounded-xl bg-gray-50 p-4">
          <pre className="overflow-auto text-sm">{grant}</pre>
          <CopyButton
            text={grant}
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
        disabled={opening.state === "loading"}
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
    <SegmentControl
      className="w-fit"
      value={setup.os}
      onValueChange={(value) => {
        if (value === "mac" || value === "windows" || value === "linux") {
          update({ os: value });
        }
      }}
      aria-label={t(($) => {
        return $.remoteControlSetup.os;
      })}
    >
      {items.map((item) => {
        return (
          <SegmentControlItem key={item.value} value={item.value}>
            {item.label}
          </SegmentControlItem>
        );
      })}
    </SegmentControl>
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
  const [opening, open] = useLoadableSet(openRemoteLogin$);
  const signal = useGet(pageSignal$);
  const vnc = setup.protocol === "vnc";
  return (
    <StepCard
      title={t(($) => {
        return vnc
          ? $.remoteControlSetup.serviceTitle
          : $.remoteControlSetup.prepareTitle;
      })}
    >
      <OsChoice setup={setup} />
      <RemoteServiceInstructions os={setup.os} vnc={vnc} />
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
      <OperationError failed={opening.state === "hasError"} />
      <ContinueButton
        disabled={
          opening.state === "loading" ||
          (!vnc && setup.route === "tailscale" && !setup.networkId)
        }
        onClick={() => {
          detach(open(signal), Reason.DomCallback);
        }}
      >
        {t(($) => {
          return $.remoteControlSetup.ready;
        })}
      </ContinueButton>
    </StepCard>
  );
}
function ExistingConnectionMethod({
  icon,
  title,
  description,
  disabled,
  onClick,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  return (
    <Button
      variant="outline"
      className="h-auto min-h-16 justify-start gap-4 whitespace-normal rounded-xl border-divider p-4 text-left"
      disabled={disabled}
      onClick={onClick}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-gray-50">
        {icon}
      </span>
      <span className="grid min-w-0 flex-1 gap-1">
        <strong>{title}</strong>
        <span className="text-sm font-normal text-muted-foreground">
          {description}
        </span>
      </span>
      <ChevronRight size={16} aria-hidden />
    </Button>
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
  const busy = opening.state === "loading" || starting.state === "loading";
  return (
    <div className="grid gap-3">
      <header className="mb-2 grid gap-1.5">
        <h2 className="text-lg font-semibold tracking-tight">
          {t(($) => {
            return $.remoteControlSetup.existingTitle;
          })}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.remoteControlSetup.existingDescription;
          })}
        </p>
      </header>
      <ExistingConnectionMethod
        icon={<Link2 size={20} aria-hidden />}
        title={t(($) => {
          return $.remoteControlSetup.direct;
        })}
        description={t(($) => {
          return $.remoteControlSetup.directHelp;
        })}
        disabled={busy}
        onClick={() => {
          if (setup?.route !== "direct") {
            update({ route: "direct", address: "", formStarted: false });
          }
          detach(open(signal), Reason.DomCallback);
        }}
      />
      {tailscale && (
        <ExistingConnectionMethod
          icon={<Network size={20} aria-hidden />}
          title={t(($) => {
            return $.tailscale.title;
          })}
          description={t(($) => {
            return $.remoteControlSetup.tailscaleHelp;
          })}
          disabled={busy}
          onClick={() => {
            if (setup?.route !== "tailscale") {
              update({
                route: "tailscale",
                formStarted: false,
                address: "",
                networkId: "",
              });
            }
            detach(open(signal), Reason.DomCallback);
          }}
        />
      )}
      <ExistingConnectionMethod
        icon={<Cloud size={20} aria-hidden />}
        title={t(($) => {
          return $.cloudflareAccess.title;
        })}
        description={t(($) => {
          return $.remoteControlSetup.cloudflareHelp;
        })}
        disabled={busy}
        onClick={() => {
          update({
            route: "cloudflare_access",
            step: "cf-address",
            address: "",
            networkId: "",
            formStarted: false,
          });
        }}
      />
      {tailscale && (
        <Button
          variant="quiet"
          className="justify-self-start"
          disabled={busy}
          onClick={() => {
            detach(start(signal), Reason.DomCallback);
          }}
        >
          <ArrowLeft size={16} aria-hidden />
          {t(($) => {
            return $.remoteControlSetup.firstTimeSetup;
          })}
        </Button>
      )}
      <OperationError
        failed={opening.state === "hasError" || starting.state === "hasError"}
      />
    </div>
  );
}
function CloudflareStep({ setup }: { readonly setup: RemoteSetup }) {
  const { t } = useTranslation();
  const [opening, open] = useLoadableSet(openRemoteNetwork$);
  const [loggingIn, login] = useLoadableSet(openRemoteLogin$);
  const signal = useGet(pageSignal$);
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
        <ContinueButton
          disabled={!setup.networkId || loggingIn.state === "loading"}
          onClick={() => {
            detach(login(signal), Reason.DomCallback);
          }}
        />
      </StepCard>
    </div>
  );
}
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
        <div hidden={setup.step !== "cf-credentials"}>
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
  const params = useGet(searchParams$);
  const leave = useSet(leaveRemoteSetup$);
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
      <p className="font-medium">{setup.savedName}</p>
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
  const steps =
    setup.route === "tailscale"
      ? ["address", "prepare", "login"]
      : ["cf-address", "login"];
  const stepIndex = steps.indexOf(setup.step);
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
      <Button variant="quiet" onClick={goBack}>
        <ArrowLeft size={16} aria-hidden />
        {t(($) => {
          return $.remoteControlSetup.back;
        })}
      </Button>
      <SetupProgress setup={setup} />
      {setup.protocol === "ssh" &&
        setup.sourceNetwork &&
        setup.entryMode === "guided" &&
        stepIndex !== -1 && (
          <span className="text-sm text-muted-foreground">
            {stepIndex + 1} / {steps.length}
          </span>
        )}
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
    <div
      className={cn(
        "mx-auto grid w-full gap-6",
        setup.step !== "entry" && "max-w-[760px]",
      )}
    >
      <RemoteSetupHeader setup={setup} />
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
      {setup.step === "oauth" &&
        !(networkDialog.state === "hasData" && networkDialog.data) && (
          <StepCard
            title={t(($) => {
              return $.remoteControlSetup.oauthTitle;
            })}
          >
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
      {(setup.step === "prepare" || setup.step === "service") && (
        <ServiceStep setup={setup} />
      )}
      {setup.step === "cf-access" && <CloudflareStep setup={setup} />}
      <RemoteSetupForms setup={setup} />
      {setup.step === "saved" && <RemoteSetupSaved setup={setup} />}
    </div>
  );
}
