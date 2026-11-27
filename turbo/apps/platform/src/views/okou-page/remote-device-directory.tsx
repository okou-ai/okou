import type {
  RemoteDeviceAccess,
  RemoteDeviceChannel,
  RemoteDeviceChannelKind,
  RemoteDeviceDirectoryItem,
} from "@okouai/api-contracts/contracts/remote-devices";
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Skeleton,
  cn,
  surfaceVariants,
} from "@okouai/ui";
import { buttonVariants } from "@okouai/ui/components/ui/button";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  ArrowLeft,
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  KeyRound,
  Laptop,
  Monitor,
  Pencil,
  Plus,
  Smartphone,
  Terminal,
  Trash2,
} from "lucide-react";
import type { FormEvent } from "react";
import { i18n } from "../../i18n/index.ts";
import { useTranslation } from "react-i18next";
import { formatRelativeTimestamp } from "../../i18n/format.ts";
import { now } from "../../lib/time.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { permissionGrantExpiryText } from "../../signals/permission-allow/permission-grant-expiration.ts";
import { enterRemoteSetup$ } from "../../signals/remote-control-setup.ts";
import {
  closeRemoteDeviceRename$,
  createRemoteDevice$,
  deleteRemoteDevice$,
  finishRemoteDeviceRenameClose$,
  invalidateRemoteDeviceDirectory$,
  mountRemoteDeviceCreation$,
  mountRemoteDeviceRename$,
  moveRemoteDeviceChannel$,
  openRemoteDeviceRename$,
  remoteDeviceCreation$,
  remoteDeviceDirectory$,
  remoteDeviceRenameDraft$,
  remoteDeviceRenameRequest$,
  renameRemoteDevice$,
  selectedRemoteDeviceId$,
  setRemoteDeviceCreationOpen$,
  updateRemoteDeviceAccess$,
  remoteDeviceAccessPending$,
  updateRemoteDeviceName$,
  updateRemoteDeviceRename$,
} from "../../signals/remote-devices.ts";
import { remoteResourceSearchParams } from "../../signals/remote-resource-detail.ts";
import { searchParams$ } from "../../signals/route.ts";
import { detach, onDomEventFn, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";

export const directoryParams = Object.freeze({ scope: "remote-control" });

export function deviceLink(deviceId?: string) {
  return {
    searchParams: new URLSearchParams(
      deviceId
        ? { ...directoryParams, remoteDevice: deviceId }
        : directoryParams,
    ),
  };
}

export function channelKindLabel(kind: RemoteDeviceChannelKind) {
  switch (kind) {
    case "desktop": {
      return i18n.t(($) => {
        return $.remoteControlSetup.computerUse;
      });
    }
    case "ios": {
      return i18n.t(($) => {
        return $.remoteDevices.ios;
      });
    }
    case "ssh": {
      return i18n.t(($) => {
        return $.ssh.label;
      });
    }
    case "vnc": {
      return i18n.t(($) => {
        return $.vnc.label;
      });
    }
  }
}

export const channelIcons = {
  desktop: Laptop,
  ios: Smartphone,
  ssh: Terminal,
  vnc: Monitor,
} as const;

function DeviceChannels({
  device,
}: {
  readonly device: RemoteDeviceDirectoryItem;
}) {
  const { t } = useTranslation();
  const kinds = new Set(
    device.channels.map(({ kind }) => {
      return kind;
    }),
  );
  if (kinds.size === 0) {
    return (
      <span className="text-xs text-muted-foreground">
        {t(($) => {
          return $.remoteDevices.noChannels;
        })}
      </span>
    );
  }
  return (
    <ul className="flex flex-wrap items-center gap-1.5">
      {[...kinds].map((kind) => {
        return (
          <li key={kind} className="leading-none">
            <Badge className="text-xs text-muted-foreground">
              {channelKindLabel(kind)}
            </Badge>
          </li>
        );
      })}
    </ul>
  );
}

export function deviceAccessAllowed(
  device: RemoteDeviceDirectoryItem,
  time: number,
) {
  return (
    device.accessAllowed &&
    (device.accessExpiresAt === null ||
      Date.parse(device.accessExpiresAt) > time)
  );
}

function RemoteDeviceAllowMenu({
  duration,
  pending,
  update,
}: {
  readonly duration: string | null;
  readonly pending: boolean;
  readonly update: (policy: RemoteDeviceAccess) => void;
}) {
  const { t } = useTranslation();
  const choices: readonly (readonly [RemoteDeviceAccess, string])[] = [
    [
      { mode: "always" },
      t(($) => {
        return $.connectors.permissions.allowDuration.always;
      }),
    ],
    [
      { mode: "for", hours: 1 },
      t(($) => {
        return $.connectors.permissions.allowDuration.oneHour;
      }),
    ],
    [
      { mode: "for", hours: 24 },
      t(($) => {
        return $.connectors.permissions.allowDuration.twentyFourHours;
      }),
    ],
    [
      { mode: "for", hours: 168 },
      t(($) => {
        return $.connectors.permissions.allowDuration.sevenDays;
      }),
    ],
  ];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={pending}
        render={
          <Button
            type="button"
            size="xs"
            variant="quiet"
            pending={pending}
            className={cn(
              "min-w-0 gap-1.5 rounded-r-none text-xs focus-visible:ring-inset [&_svg]:size-3",
              duration &&
                "bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-400",
            )}
          />
        }
      >
        {duration && <Check size={12} aria-hidden />}
        <span className="truncate">
          {t(($) => {
            return $.connectors.permissions.actions.allow;
          })}
        </span>
        {duration && <span className="truncate text-[11px]">{duration}</span>}
        <ChevronDown size={12} aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {choices.map(([choice, label]) => {
          return (
            <DropdownMenuItem
              key={label}
              onClick={() => {
                update(choice);
              }}
            >
              {label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RemoteDevicePolicyControl({
  device,
}: {
  readonly device: RemoteDeviceDirectoryItem;
}) {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const [saving, save] = useLoadableSet(updateRemoteDeviceAccess$);
  const pending = useGet(remoteDeviceAccessPending$).has(device.id);
  const time = now();
  const allowed = deviceAccessAllowed(device, time);
  const duration = allowed
    ? (permissionGrantExpiryText(device.accessExpiresAt, time, "compact") ??
      t(($) => {
        return $.connectors.permissions.always;
      }))
    : null;
  const status =
    duration ??
    t(($) => {
      return $.remoteDevices.off;
    });
  const accessLabel = t(
    ($) => {
      return $.remoteDevices.policy;
    },
    { device: device.displayName, status },
  );
  const update = (policy: RemoteDeviceAccess) => {
    detach(save(device.id, policy, signal), Reason.DomCallback);
  };
  return (
    <div className="flex min-w-0 flex-col items-end gap-1">
      <div
        role="group"
        aria-label={accessLabel}
        className="flex max-w-full items-center rounded-md border border-surface-border"
      >
        <RemoteDeviceAllowMenu
          duration={duration}
          pending={pending}
          update={update}
        />
        <Button
          type="button"
          size="xs"
          variant="quiet"
          aria-pressed={!allowed}
          disabled={pending}
          onClick={() => {
            if (allowed) {
              update({ mode: "denied" });
            }
          }}
          className={cn(
            "shrink-0 gap-1.5 rounded-l-none border-l border-surface-border text-xs focus-visible:ring-inset [&_svg]:size-3",
            !allowed &&
              "bg-rose-500/10 text-rose-700 hover:bg-rose-500/15 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-400",
          )}
        >
          <Ban size={12} aria-hidden />
          {t(($) => {
            return $.connectors.permissions.actions.deny;
          })}
        </Button>
      </div>
      {saving.state === "hasError" && (
        <span role="alert" className="text-xs text-destructive">
          {t(($) => {
            return $.remoteDevices.saveFailed;
          })}
        </span>
      )}
    </div>
  );
}

export function RemoteDeviceLoadError() {
  const { t } = useTranslation();
  const retry = useSet(invalidateRemoteDeviceDirectory$);
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 py-2 text-sm"
    >
      <span>
        {t(($) => {
          return $.remoteDevices.loadFailed;
        })}
      </span>
      <Button size="sm" variant="outline" onClick={retry}>
        {t(($) => {
          return $.remoteDevices.retry;
        })}
      </Button>
    </div>
  );
}

const deviceNameLimit = 120;

function RemoteDeviceNameField({
  name,
  onChange,
  readOnly,
}: {
  readonly name: string;
  readonly onChange: (name: string) => void;
  readonly readOnly?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <label className="grid gap-2 text-sm font-medium">
      {t(($) => {
        return $.remoteDevices.name;
      })}
      <Input
        value={name}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
          ) {
            event.preventDefault();
          }
        }}
        readOnly={readOnly}
        required
        maxLength={deviceNameLimit}
      />
    </label>
  );
}

function AddRemoteDeviceForm() {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const draft = useGet(remoteDeviceCreation$);
  const setName = useSet(updateRemoteDeviceName$);
  const setOpen = useSet(setRemoteDeviceCreationOpen$);
  const [saving, save] = useLoadableSet(createRemoteDevice$);
  return (
    <form
      className="grid gap-4"
      onSubmit={onDomEventFn(async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        await save(signal);
      })}
    >
      <RemoteDeviceNameField name={draft?.name ?? ""} onChange={setName} />
      {saving.state === "hasError" && (
        <p role="alert" className="text-sm text-destructive">
          {t(($) => {
            return $.remoteDevices.saveFailed;
          })}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setOpen(false);
          }}
          disabled={saving.state === "loading"}
        >
          {t(($) => {
            return $.remoteDevices.cancel;
          })}
        </Button>
        <Button
          type="submit"
          disabled={!draft?.name.trim()}
          pending={saving.state === "loading"}
        >
          {t(($) => {
            return $.remoteDevices.create;
          })}
        </Button>
      </div>
    </form>
  );
}

export function AddEmptyRemoteDeviceDialog() {
  const { t } = useTranslation();
  const draft = useGet(remoteDeviceCreation$);
  const setOpen = useSet(setRemoteDeviceCreationOpen$);
  const mount = useSet(mountRemoteDeviceCreation$);
  return (
    <Dialog open={draft !== null} onOpenChange={setOpen}>
      <DialogTrigger
        ref={mount}
        render={<Button size="sm" variant="neutral" />}
      >
        {t(($) => {
          return $.remoteDevices.createEmpty;
        })}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.remoteDevices.createEmpty;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.remoteDevices.addDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <AddRemoteDeviceForm />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

export function AddRemoteDeviceButton() {
  const { t } = useTranslation();
  const startSetup = useSet(enterRemoteSetup$);
  return (
    <Button
      size="sm"
      variant="outline"
      className="ml-auto shrink-0"
      onClick={() => {
        startSetup();
      }}
    >
      <Plus size={14} aria-hidden />
      {t(($) => {
        return $.remoteDevices.add;
      })}
    </Button>
  );
}

function RemoteDeviceMoveMenu({
  channel,
  destinations,
}: {
  readonly channel: RemoteDeviceChannel;
  readonly destinations: readonly RemoteDeviceDirectoryItem[];
}) {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const [moving, move] = useLoadableSet(moveRemoteDeviceChannel$);
  const time = now();
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              size="sm"
              variant="neutral"
              pending={moving.state === "loading"}
            />
          }
          aria-label={t(
            ($) => {
              return $.remoteDevices.moveChannel;
            },
            { channel: channel.displayName },
          )}
        >
          {t(($) => {
            return $.remoteDevices.move;
          })}
          <ChevronDown size={14} aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          {destinations.map((device) => {
            const allowed = deviceAccessAllowed(device, time);
            return (
              <DropdownMenuItem
                key={device.id}
                className="flex justify-between gap-3"
                onClick={() => {
                  detach(move(channel, device.id, signal), Reason.DomCallback);
                }}
              >
                <span className="min-w-0 truncate" title={device.displayName}>
                  {device.displayName}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {allowed
                    ? (permissionGrantExpiryText(
                        device.accessExpiresAt,
                        time,
                        "compact",
                      ) ??
                      t(($) => {
                        return $.connectors.permissions.always;
                      }))
                    : t(($) => {
                        return $.remoteDevices.off;
                      })}
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      {moving.state === "hasError" && (
        <p role="alert" className="text-sm text-destructive">
          {t(($) => {
            return $.remoteDevices.saveFailed;
          })}
        </p>
      )}
    </>
  );
}

function RemoteDeviceChannelRow({
  channel,
  destinations,
}: {
  readonly channel: RemoteDeviceChannel;
  readonly destinations: readonly RemoteDeviceDirectoryItem[];
}) {
  const { t } = useTranslation();
  const parameters = useGet(searchParams$);
  const Icon = channelIcons[channel.kind];
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="flex min-w-0 flex-[1_1_10rem] items-center gap-3">
        <Icon
          size={18}
          aria-hidden
          className="shrink-0 text-muted-foreground"
        />
        <div className="min-w-0">
          <div className="break-words text-sm font-medium">
            {channel.displayName}
          </div>
          <div className="text-xs text-muted-foreground">
            {channelKindLabel(channel.kind)}
            {channel.lastSeenAt && (
              <>
                {" · "}
                {t(
                  ($) => {
                    return $.remoteDevices.lastSeen;
                  },
                  { time: formatRelativeTimestamp(channel.lastSeenAt) },
                )}
              </>
            )}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {(channel.kind === "ssh" || channel.kind === "vnc") && (
          <Link
            pathname="/connectors"
            options={{
              searchParams: remoteResourceSearchParams(
                parameters,
                channel.kind,
                channel.id,
              ),
            }}
            className={buttonVariants({ size: "sm", variant: "neutral" })}
          >
            {t(($) => {
              return $.remoteNetworkScope.manage;
            })}
          </Link>
        )}
        {destinations.length > 0 && (
          <RemoteDeviceMoveMenu channel={channel} destinations={destinations} />
        )}
      </div>
    </li>
  );
}

function RenameRemoteDevice({
  device,
}: {
  readonly device: RemoteDeviceDirectoryItem;
}) {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const draft = useGet(remoteDeviceRenameDraft$);
  const saving = useLoadable(remoteDeviceRenameRequest$);
  const openRename = useSet(openRemoteDeviceRename$);
  const closeRename = useSet(closeRemoteDeviceRename$);
  const finishClose = useSet(finishRemoteDeviceRenameClose$);
  const mount = useSet(mountRemoteDeviceRename$);
  const setName = useSet(updateRemoteDeviceRename$);
  const rename = useSet(renameRemoteDevice$);
  const pending = saving.state === "loading";
  const name = draft?.name?.trim() ?? "";
  const canSave =
    name.length > 0 &&
    name.length <= deviceNameLimit &&
    name !== device.displayName;
  return (
    <Dialog
      open={draft?.deviceId === device.id && draft.open}
      onOpenChange={(open, details) => {
        if (open) {
          openRename(device.id);
        } else if (pending) {
          details.cancel();
        } else {
          closeRename();
        }
      }}
      onOpenChangeComplete={(open) => {
        if (!open) {
          finishClose();
        }
      }}
    >
      <DialogTrigger
        ref={mount}
        render={<Button variant="outline" size="xs" />}
      >
        <Pencil size={14} aria-hidden />
        {t(($) => {
          return $.remoteDevices.rename;
        })}
      </DialogTrigger>
      <DialogContent maxWidth="md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.remoteDevices.renameDevice;
            })}
          </DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4"
          aria-busy={pending}
          onSubmit={onDomEventFn(async (event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (canSave && !pending) {
              await rename(signal);
            }
          })}
        >
          <RemoteDeviceNameField
            name={draft?.name ?? device.displayName}
            onChange={setName}
            readOnly={pending}
          />
          {saving.state === "hasError" && (
            <p role="alert" className="text-sm text-destructive">
              {t(($) => {
                return $.remoteDevices.saveFailed;
              })}
            </p>
          )}
          <DialogFooter>
            <DialogClose
              render={<Button variant="outline" disabled={pending} />}
            >
              {t(($) => {
                return $.remoteDevices.cancel;
              })}
            </DialogClose>
            <Button type="submit" disabled={!canSave} pending={pending}>
              {t(($) => {
                return $.remoteDevices.save;
              })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteRemoteDevice({
  device,
}: {
  readonly device: RemoteDeviceDirectoryItem;
}) {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const [deleting, remove] = useLoadableSet(deleteRemoteDevice$);
  const pending = deleting.state === "loading";
  const label = t(($) => {
    return $.remoteDevices.deleteDevice;
  });
  return (
    <Dialog
      onOpenChange={(open, details) => {
        if (!open && pending) {
          details.cancel();
        }
      }}
    >
      <DialogTrigger render={<Button variant="outline" size="xs" />}>
        <Trash2 size={14} aria-hidden />
        {label}
      </DialogTrigger>
      <DialogContent maxWidth="md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {t(
              ($) => {
                return $.remoteDevices.deleteTitle;
              },
              {
                device: device.displayName,
              },
            )}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.remoteDevices.deleteDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={pending} />}>
            {t(($) => {
              return $.remoteDevices.cancel;
            })}
          </DialogClose>
          <Button
            variant="destructive"
            pending={pending}
            onClick={() => {
              detach(remove(device.id, signal), Reason.DomCallback);
            }}
          >
            {label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RemoteDeviceDetails({
  device,
  devices,
}: {
  readonly device: RemoteDeviceDirectoryItem;
  readonly devices: readonly RemoteDeviceDirectoryItem[];
}) {
  const { t } = useTranslation();
  const startSetup = useSet(enterRemoteSetup$);
  const destinations = devices.filter(({ id }) => {
    return id !== device.id;
  });
  return (
    <section className="grid gap-5">
      <Link
        pathname="/connectors"
        options={deviceLink()}
        className="inline-flex items-center gap-1.5 justify-self-start text-sm text-muted-foreground hover:text-foreground hover:underline"
      >
        <ArrowLeft size={14} aria-hidden />
        {t(($) => {
          return $.remoteDevices.title;
        })}
      </Link>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-divider pb-4">
        <h2 className="min-w-0 wrap-anywhere text-lg font-semibold">
          {device.displayName}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <RemoteDevicePolicyControl device={device} />
          <RenameRemoteDevice key={`rename:${device.id}`} device={device} />
          <DeleteRemoteDevice key={device.id} device={device} />
        </div>
      </header>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">
          {t(($) => {
            return $.remoteDevices.channels;
          })}
        </h3>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            startSetup();
          }}
        >
          <Plus size={14} aria-hidden />
          {t(($) => {
            return $.remoteDevices.addChannel;
          })}
        </Button>
      </div>
      {device.channels.length > 0 ? (
        <Card className="overflow-hidden border-divider">
          <ul className="divide-y divide-divider">
            {device.channels.map((channel) => {
              return (
                <RemoteDeviceChannelRow
                  key={`${channel.kind}:${channel.id}`}
                  channel={channel}
                  destinations={destinations}
                />
              );
            })}
          </ul>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.remoteDevices.noChannels;
          })}
        </p>
      )}
    </section>
  );
}

export function RemoteDeviceDirectory() {
  const { t } = useTranslation();
  const activeId = useGet(selectedRemoteDeviceId$);
  const load = useLoadable(remoteDeviceDirectory$);
  const devices = useLastResolved(remoteDeviceDirectory$);
  const activeDevice = activeId
    ? devices?.find(({ id }) => {
        return id === activeId;
      })
    : undefined;
  if (load.state === "loading" && (!devices || (activeId && !activeDevice))) {
    return <Skeleton className="h-32 w-full" />;
  }
  if (!devices || load.state === "hasError") {
    return <RemoteDeviceLoadError />;
  }
  if (activeId) {
    return activeDevice ? (
      <RemoteDeviceDetails device={activeDevice} devices={devices} />
    ) : (
      <div className="grid gap-2">
        <Link
          pathname="/connectors"
          options={deviceLink()}
          className="justify-self-start text-sm hover:underline"
        >
          {t(($) => {
            return $.remoteDevices.title;
          })}
        </Link>
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.remoteDevices.unavailable;
          })}
        </p>
      </div>
    );
  }
  return <RemoteDeviceOverview devices={devices} />;
}

function RemoteDeviceOverview({
  devices,
}: {
  readonly devices: readonly RemoteDeviceDirectoryItem[];
}) {
  const { t } = useTranslation();
  return (
    <section
      className="grid gap-4"
      aria-label={t(($) => {
        return $.remoteDevices.title;
      })}
    >
      {devices.length > 0 ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))] gap-3">
          {devices.map((device) => {
            const Icon = channelIcons[device.channels[0]?.kind ?? "desktop"];
            const lastSeenAt = device.channels.reduce<string | null>(
              (latest, channel) => {
                const seen = channel.lastSeenAt;
                return seen && (latest === null || seen > latest)
                  ? seen
                  : latest;
              },
              null,
            );
            return (
              <article
                key={device.id}
                className={cn(surfaceVariants(), "flex min-w-0 flex-col")}
              >
                <Link
                  pathname="/connectors"
                  options={deviceLink(device.id)}
                  aria-label={device.displayName}
                  className="flex min-w-0 flex-1 flex-col gap-3 rounded-t-[inherit] px-4 py-3.5 hover:bg-state-hover"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Icon
                      size={18}
                      aria-hidden
                      className="shrink-0 text-muted-foreground"
                    />
                    <h2
                      className="min-w-0 flex-1 truncate text-sm font-semibold"
                      title={device.displayName}
                    >
                      {device.displayName}
                    </h2>
                    <ChevronRight
                      size={16}
                      aria-hidden
                      className="shrink-0 text-muted-foreground"
                    />
                  </div>
                  <DeviceChannels device={device} />
                </Link>
                <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 border-t border-divider px-3 py-2.5">
                  {lastSeenAt && (
                    <span className="mr-auto text-xs text-muted-foreground">
                      {t(
                        ($) => {
                          return $.remoteDevices.lastSeen;
                        },
                        { time: formatRelativeTimestamp(lastSeenAt) },
                      )}
                    </span>
                  )}
                  <RemoteDevicePolicyControl device={device} />
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.remoteDevices.empty;
          })}
        </p>
      )}
      <Link
        pathname="/connectors"
        options={{
          searchParams: new URLSearchParams({
            ...directoryParams,
            remoteView: "credentials",
          }),
        }}
        className="inline-flex items-center gap-2 justify-self-start text-sm text-muted-foreground hover:underline"
      >
        <KeyRound size={16} aria-hidden />
        {t(($) => {
          return $.remoteControlSetup.manageCredentials;
        })}
      </Link>
    </section>
  );
}
