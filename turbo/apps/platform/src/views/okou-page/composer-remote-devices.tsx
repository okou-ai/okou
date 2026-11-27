import type { ConnectorAccountPolicyChoice } from "@okouai/api-contracts/contracts/chat-connector-access";
import type {
  RemoteDeviceAccess,
  RemoteDeviceDirectoryItem,
} from "@okouai/api-contracts/contracts/remote-devices";
import { Button, cn, Input, PopoverClose, Skeleton } from "@okouai/ui";
import { buttonVariants } from "@okouai/ui/components/ui/button";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  ArrowLeft,
  ChevronRight,
  Monitor,
  Search,
  Settings2,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { now } from "../../lib/time.ts";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  composerRemoteDeviceClock$,
  focusDeviceMenuControl$,
  mountComposerRemoteDeviceExpiry$,
  mountRemoteDeviceDirectory$,
  remoteDeviceDirectory$,
  updateRemoteDeviceAccess$,
  remoteDeviceAccessPending$,
} from "../../signals/remote-devices.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { ChatConnectorMenu } from "./chat-connector-menu.tsx";
import { AccessPolicyDropdown } from "./components/settings/connector-account-policy-control.tsx";
import {
  channelKindLabel,
  channelIcons,
  deviceAccessAllowed,
  deviceLink,
  directoryParams,
  RemoteDeviceLoadError,
} from "./remote-device-directory.tsx";

const devicePolicies: Record<ConnectorAccountPolicyChoice, RemoteDeviceAccess> =
  Object.freeze({
    "allow-always": { mode: "always" },
    "allow-1h": { mode: "for", hours: 1 },
    "allow-24h": { mode: "for", hours: 24 },
    "allow-7d": { mode: "for", hours: 168 },
    deny: { mode: "denied" },
  });

function ComposerDevicePolicy({
  device,
  enabled,
}: {
  readonly device: RemoteDeviceDirectoryItem;
  readonly enabled: boolean;
}) {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const [saving, save] = useLoadableSet(updateRemoteDeviceAccess$);
  const pending = useGet(remoteDeviceAccessPending$).has(device.id);
  return (
    <AccessPolicyDropdown
      policy={{ enabled, expiresAt: enabled ? device.accessExpiresAt : null }}
      accessLabel={t(
        ($) => {
          return $.connectorChatAccess.accountAccess;
        },
        { account: device.displayName },
      )}
      pending={pending}
      error={
        saving.state === "hasError"
          ? t(($) => {
              return $.remoteDevices.saveFailed;
            })
          : undefined
      }
      onChange={(choice) => {
        detach(
          save(device.id, devicePolicies[choice], signal),
          Reason.DomCallback,
        );
      }}
    />
  );
}

function ComposerDeviceRow({
  device,
  time,
}: {
  readonly device: RemoteDeviceDirectoryItem;
  readonly time: number;
}) {
  const { t } = useTranslation();
  const kinds = [
    ...new Set(
      device.channels.map(({ kind }) => {
        return kind;
      }),
    ),
  ];
  const Icon = channelIcons[kinds[0] ?? "desktop"];
  return (
    <li className="grid min-h-12 grid-cols-[1.125rem_minmax(0,1fr)_minmax(0,44%)] items-center gap-2 rounded-md px-2 py-1 hover:bg-state-hover">
      <Icon size={16} aria-hidden className="text-muted-foreground" />
      <div className="grid min-w-0">
        <PopoverClose
          nativeButton={false}
          role="link"
          render={
            <Link
              pathname="/connectors"
              options={deviceLink(device.id)}
              title={device.displayName}
              className="truncate text-sm hover:underline"
            />
          }
        >
          {device.displayName}
        </PopoverClose>
        <span className="truncate text-xs text-muted-foreground">
          {kinds.length === 0
            ? t(($) => {
                return $.remoteDevices.noChannels;
              })
            : kinds.map((kind, index) => {
                return (
                  <span key={kind}>
                    {index > 0 && " · "}
                    {channelKindLabel(kind)}
                  </span>
                );
              })}
        </span>
      </div>
      <ComposerDevicePolicy
        device={device}
        enabled={deviceAccessAllowed(device, time)}
      />
    </li>
  );
}

function ComposerDeviceList({
  devices,
  failed,
  time,
  search,
  onSearchChange,
}: {
  readonly devices: readonly RemoteDeviceDirectoryItem[] | undefined;
  readonly failed: boolean;
  readonly time: number;
  readonly search: string;
  readonly onSearchChange: (search: string) => void;
}) {
  const { t } = useTranslation();
  const term = search.trim().toLocaleLowerCase();
  const visible = devices?.filter(({ displayName, channels }) => {
    return (
      displayName.toLocaleLowerCase().includes(term) ||
      channels.some(({ kind, displayName: name }) => {
        return (
          kind.includes(term) ||
          name.toLocaleLowerCase().includes(term) ||
          channelKindLabel(kind).toLocaleLowerCase().includes(term)
        );
      })
    );
  });
  return (
    <>
      <div className="shrink-0 px-2.5 pb-2">
        <div className="relative">
          <Search
            size={16}
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            className="pl-8"
            aria-label={t(($) => {
              return $.remoteDevices.find;
            })}
            placeholder={t(($) => {
              return $.remoteDevices.find;
            })}
            value={search}
            onChange={(event) => {
              return onSearchChange(event.currentTarget.value);
            }}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-divider px-1 py-1">
        {failed && <RemoteDeviceLoadError />}
        {!devices && !failed && (
          <div role="status" aria-busy="true" className="grid gap-2 px-2 py-1">
            {Array.from({ length: 4 }, (_, index) => {
              return <Skeleton key={index} className="h-10 w-full" />;
            })}
          </div>
        )}
        {visible && visible.length > 0 && (
          <ul
            aria-label={t(($) => {
              return $.remoteDevices.title;
            })}
          >
            {visible.map((device) => {
              return (
                <ComposerDeviceRow
                  key={device.id}
                  device={device}
                  time={time}
                />
              );
            })}
          </ul>
        )}
        {visible?.length === 0 && (
          <div className="grid justify-items-center gap-2 px-2 py-5 text-center text-sm text-muted-foreground">
            <p>
              {devices?.length
                ? t(($) => {
                    return $.remoteDevices.noMatches;
                  })
                : t(($) => {
                    return $.remoteDevices.empty;
                  })}
            </p>
            {devices?.length === 0 && (
              <PopoverClose
                nativeButton={false}
                role="link"
                render={
                  <Link
                    pathname="/connectors"
                    options={{
                      searchParams: new URLSearchParams({
                        ...directoryParams,
                        setup: "add",
                      }),
                    }}
                    className={buttonVariants({
                      size: "sm",
                      variant: "outline",
                    })}
                  />
                }
              >
                {t(($) => {
                  return $.remoteDevices.add;
                })}
              </PopoverClose>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function ComposerDeviceFooter() {
  const { t } = useTranslation();
  return (
    <footer className="shrink-0 border-t border-divider p-1">
      <PopoverClose
        nativeButton={false}
        role="link"
        render={
          <Link
            pathname="/connectors"
            options={deviceLink()}
            className="flex items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-state-hover"
          />
        }
      >
        <Settings2
          size={16}
          aria-hidden
          className="shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate">
          {t(($) => {
            return $.remoteDevices.manage;
          })}
        </span>
        <ChevronRight
          size={14}
          aria-hidden
          className="shrink-0 text-muted-foreground"
        />
      </PopoverClose>
    </footer>
  );
}

function ComposerDeviceHeader({
  title,
  onBack,
}: {
  readonly title: string;
  readonly onBack: () => void;
}) {
  const { t } = useTranslation();
  const focusControl = useSet(focusDeviceMenuControl$);
  return (
    <header className="flex shrink-0 items-center gap-1 px-1 py-1">
      <Button
        ref={focusControl}
        type="button"
        variant="quiet"
        size="icon-sm"
        aria-label={t(($) => {
          return $.remoteControlSetup.back;
        })}
        onClick={onBack}
      >
        <ArrowLeft size={16} aria-hidden />
      </Button>
      <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h3>
      <PopoverClose
        render={
          <Button
            variant="quiet"
            size="icon-sm"
            className="sm:hidden"
            aria-label={t(($) => {
              return $.workflows.common.close;
            })}
          />
        }
      >
        <X size={16} aria-hidden />
      </PopoverClose>
    </header>
  );
}

export function ComposerRemoteDevicesMenu({
  signals,
  cloudBrowser,
  onOpenAddDialog,
}: {
  readonly signals: ComposerSignals;
  readonly cloudBrowser: ReactNode;
  readonly onOpenAddDialog: () => void;
}) {
  const { t } = useTranslation();
  const mount = useSet(mountRemoteDeviceDirectory$);
  const mountExpiry = useSet(mountComposerRemoteDeviceExpiry$);
  const focusControl = useSet(focusDeviceMenuControl$);
  const ui = useGet(signals.connector.connectorUiState$);
  const setUi = useSet(signals.connector.updateConnectorUiState$);
  const closeTarget = useSet(signals.connector.chatAccess.closeTarget$);
  const load = useLoadable(remoteDeviceDirectory$);
  const devices = useLastResolved(remoteDeviceDirectory$);
  useGet(composerRemoteDeviceClock$);
  const time = now();
  const showingDevices = ui.popoverPane === "devices";
  const allowed = devices?.filter((device) => {
    return deviceAccessAllowed(device, time);
  });
  const nextExpiry = allowed?.reduce<string | null>((earliest, device) => {
    const expiresAt = device.accessExpiresAt;
    return expiresAt &&
      (!earliest || Date.parse(expiresAt) < Date.parse(earliest))
      ? expiresAt
      : earliest;
  }, null);
  const title = t(($) => {
    return $.remoteDevices.title;
  });
  return (
    <div ref={mount} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {nextExpiry && (
        <time hidden dateTime={nextExpiry} key={nextExpiry} ref={mountExpiry} />
      )}
      <div
        className={cn(
          "min-h-0 flex-1 flex-col",
          showingDevices ? "hidden" : "flex",
        )}
      >
        <ChatConnectorMenu
          bounded
          signals={signals}
          onOpenAddDialog={onOpenAddDialog}
          footer={
            <div className="shrink-0 border-t border-divider p-1">
              {cloudBrowser}
              <button
                ref={ui.popoverPane === "returned" ? focusControl : undefined}
                type="button"
                className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-state-hover"
                onClick={() => {
                  closeTarget();
                  setUi({ popoverPane: "devices" });
                }}
              >
                <Monitor
                  size={16}
                  aria-hidden
                  className="shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 flex-1 truncate">{title}</span>
                {allowed && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {t(
                      ($) => {
                        return $.remoteDevices.authorizedCount;
                      },
                      {
                        value: allowed.length,
                      },
                    )}
                  </span>
                )}
                <ChevronRight
                  size={14}
                  aria-hidden
                  className="shrink-0 text-muted-foreground"
                />
              </button>
            </div>
          }
        />
      </div>
      {showingDevices && (
        <section aria-label={title} className="flex min-h-38 flex-1 flex-col">
          <ComposerDeviceHeader
            title={title}
            onBack={() => {
              setUi({ popoverPane: "returned" });
            }}
          />
          <ComposerDeviceList
            devices={devices}
            failed={load.state === "hasError"}
            time={time}
            search={ui.deviceSearch}
            onSearchChange={(deviceSearch) => {
              return setUi({ deviceSearch });
            }}
          />
          <ComposerDeviceFooter />
        </section>
      )}
    </div>
  );
}
