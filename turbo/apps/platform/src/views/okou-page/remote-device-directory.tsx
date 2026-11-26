import type {
  RemoteDeviceAccess,
  RemoteDeviceChannel,
  RemoteDeviceChannelKind,
  RemoteDeviceDirectoryItem,
} from "@okouai/api-contracts/contracts/remote-devices";
import {
  Button,
  Card,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Skeleton,
} from "@okouai/ui";
import { buttonVariants } from "@okouai/ui/components/ui/button";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { ChevronDown, KeyRound, Laptop, Plus } from "lucide-react";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { now } from "../../lib/time.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { permissionGrantExpiryText } from "../../signals/permission-allow/permission-grant-expiration.ts";
import { enterRemoteSetup$ } from "../../signals/remote-control-setup.ts";
import {
  createRemoteDevice$,
  invalidateRemoteDeviceDirectory$,
  mountRemoteDeviceCreation$,
  mountRemoteDeviceDirectory$,
  moveRemoteDeviceChannel$,
  remoteDeviceCreation$,
  remoteDeviceDirectory$,
  selectedRemoteDeviceId$,
  setRemoteDeviceCreationOpen$,
  updateRemoteDeviceAccess$,
  updateRemoteDeviceName$,
} from "../../signals/remote-devices.ts";
import { remoteResourceSearchParams } from "../../signals/remote-resource-detail.ts";
import { searchParams$ } from "../../signals/route.ts";
import { detach, onDomEventFn, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";

const directoryParams = Object.freeze({ scope: "remote-control" });

function deviceLink(deviceId?: string) {
  return {
    searchParams: new URLSearchParams(
      deviceId
        ? { ...directoryParams, remoteDevice: deviceId }
        : directoryParams,
    ),
  };
}

function ChannelKind({ kind }: { readonly kind: RemoteDeviceChannelKind }) {
  const { t } = useTranslation();
  switch (kind) {
    case "desktop": {
      return t(($) => {
        return $.remoteControlSetup.computerUse;
      });
    }
    case "ios": {
      return t(($) => {
        return $.remoteDevices.ios;
      });
    }
    case "ssh": {
      return t(($) => {
        return $.ssh.label;
      });
    }
    case "vnc": {
      return t(($) => {
        return $.vnc.label;
      });
    }
  }
}

function RemoteDevicePolicyControl({
  device,
}: {
  readonly device: RemoteDeviceDirectoryItem;
}) {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const [saving, save] = useLoadableSet(updateRemoteDeviceAccess$);
  const expiresAt = device.accessExpiresAt;
  const time = now();
  const allowed =
    device.accessAllowed &&
    (expiresAt === null || Date.parse(expiresAt) > time);
  const status = !allowed
    ? t(($) => {
        return $.remoteDevices.off;
      })
    : expiresAt === null
      ? t(($) => {
          return $.connectors.permissions.always;
        })
      : permissionGrantExpiryText(expiresAt, time, "compact");
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
  const update = (policy: RemoteDeviceAccess) => {
    detach(save(device.id, policy, signal), Reason.DomCallback);
  };
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t(
            ($) => {
              return $.remoteDevices.policy;
            },
            { device: device.displayName, status },
          )}
          disabled={saving.state === "loading"}
          render={
            <Button
              type="button"
              size="xs"
              variant="neutral"
              pending={saving.state === "loading"}
            />
          }
        >
          {status}
          <ChevronDown size={14} aria-hidden />
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
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              update({ mode: "denied" });
            }}
          >
            {t(($) => {
              return $.connectors.permissions.actions.deny;
            })}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
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

function RemoteDeviceLoadError() {
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

export function ComposerRemoteDevices() {
  const { t } = useTranslation();
  const mount = useSet(mountRemoteDeviceDirectory$);
  const load = useLoadable(remoteDeviceDirectory$);
  const devices = useLastResolved(remoteDeviceDirectory$);
  return (
    <section
      ref={mount}
      className="shrink-0 border-t border-border/50 bg-gray-50 p-2 dark:bg-gray-100"
      aria-label={t(($) => {
        return $.remoteDevices.title;
      })}
    >
      <h3 className="mb-1 px-1 text-xs text-muted-foreground">
        {t(($) => {
          return $.remoteDevices.title;
        })}
      </h3>
      {load.state === "hasError" && <RemoteDeviceLoadError />}
      {!devices && load.state === "loading" && (
        <Skeleton className="h-8 w-full" />
      )}
      {devices?.map((device) => {
        return (
          <div
            key={device.id}
            className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1"
          >
            <Laptop
              size={16}
              aria-hidden
              className="shrink-0 text-muted-foreground"
            />
            <Link
              pathname="/connectors"
              options={deviceLink(device.id)}
              className="min-w-0 flex-1 truncate text-sm hover:underline"
            >
              {device.displayName}
            </Link>
            <RemoteDevicePolicyControl device={device} />
          </div>
        );
      })}
      {devices?.length === 0 && (
        <Link
          pathname="/connectors"
          options={deviceLink()}
          className="px-1 text-sm hover:underline"
        >
          {t(($) => {
            return $.remoteDevices.add;
          })}
        </Link>
      )}
    </section>
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
      <label className="grid gap-2 text-sm font-medium">
        {t(($) => {
          return $.remoteDevices.name;
        })}
        <Input
          value={draft?.name ?? ""}
          onChange={(event) => {
            setName(event.target.value);
          }}
          required
          maxLength={120}
        />
      </label>
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

function AddRemoteDeviceDialog() {
  const { t } = useTranslation();
  const draft = useGet(remoteDeviceCreation$);
  const setOpen = useSet(setRemoteDeviceCreationOpen$);
  const mount = useSet(mountRemoteDeviceCreation$);
  return (
    <Dialog open={draft !== null} onOpenChange={setOpen}>
      <DialogTrigger
        ref={mount}
        render={<Button size="sm" variant="outline" />}
      >
        <Plus size={16} aria-hidden />
        {t(($) => {
          return $.remoteDevices.add;
        })}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.remoteDevices.add;
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

function RemoteDeviceChannelRow({
  channel,
  destinations,
}: {
  readonly channel: RemoteDeviceChannel;
  readonly destinations: readonly RemoteDeviceDirectoryItem[];
}) {
  const { t, i18n } = useTranslation();
  const parameters = useGet(searchParams$);
  const signal = useGet(pageSignal$);
  const [moving, move] = useLoadableSet(moveRemoteDeviceChannel$);
  const lastSeen =
    channel.lastSeenAt === null
      ? null
      : new Intl.DateTimeFormat(i18n.language, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(channel.lastSeenAt));
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <div className="break-words text-sm font-medium">
          {channel.displayName}
        </div>
        <div className="text-xs text-muted-foreground">
          <ChannelKind kind={channel.kind} />
          {lastSeen && (
            <>
              {" "}
              ·{" "}
              {t(
                ($) => {
                  return $.remoteDevices.lastSeen;
                },
                { time: lastSeen },
              )}
            </>
          )}
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
            className={buttonVariants({ size: "sm", variant: "outline" })}
          >
            {t(($) => {
              return $.remoteNetworkScope.manage;
            })}
          </Link>
        )}
        {destinations.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  size="sm"
                  variant="outline"
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
            <DropdownMenuContent align="end">
              {destinations.map((device) => {
                return (
                  <DropdownMenuItem
                    key={device.id}
                    onClick={() => {
                      detach(
                        move(channel, device.id, signal),
                        Reason.DomCallback,
                      );
                    }}
                  >
                    {device.displayName}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {moving.state === "hasError" && (
          <p role="alert" className="text-sm text-destructive">
            {t(($) => {
              return $.remoteDevices.saveFailed;
            })}
          </p>
        )}
      </div>
    </li>
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
    <section className="grid gap-4">
      <Link
        pathname="/connectors"
        options={deviceLink()}
        className="justify-self-start text-sm text-muted-foreground hover:underline"
      >
        {t(($) => {
          return $.remoteDevices.title;
        })}
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{device.displayName}</h2>
        <RemoteDevicePolicyControl device={device} />
      </div>
      <div className="flex justify-between gap-3">
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
          <Plus size={16} aria-hidden />
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
  if (!devices && load.state === "loading") {
    return <Skeleton className="h-32 w-full" />;
  }
  if (!devices || load.state === "hasError") {
    return <RemoteDeviceLoadError />;
  }
  if (activeId) {
    const device = devices.find(({ id }) => {
      return id === activeId;
    });
    return device ? (
      <RemoteDeviceDetails device={device} devices={devices} />
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
  const startSetup = useSet(enterRemoteSetup$);
  return (
    <section
      className="grid gap-4"
      aria-label={t(($) => {
        return $.remoteDevices.title;
      })}
    >
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            startSetup();
          }}
        >
          {t(($) => {
            return $.remoteDevices.addChannel;
          })}
        </Button>
        <AddRemoteDeviceDialog />
      </div>
      {devices.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {devices.map((device) => {
            return (
              <Card
                key={device.id}
                className="min-w-0 gap-4 border-divider p-4"
              >
                <Link
                  pathname="/connectors"
                  options={deviceLink(device.id)}
                  className="flex min-w-0 items-center gap-3 text-sm font-semibold hover:underline"
                >
                  <Laptop
                    size={20}
                    aria-hidden
                    className="shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 truncate">{device.displayName}</span>
                </Link>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <ul className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    {[
                      ...new Set(
                        device.channels.map(({ kind }) => {
                          return kind;
                        }),
                      ),
                    ].map((kind) => {
                      return (
                        <li key={kind}>
                          <ChannelKind kind={kind} />
                        </li>
                      );
                    })}
                    {device.channels.length === 0 && (
                      <li>
                        {t(($) => {
                          return $.remoteDevices.noChannels;
                        })}
                      </li>
                    )}
                  </ul>
                  <RemoteDevicePolicyControl device={device} />
                </div>
              </Card>
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
