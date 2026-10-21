import type { ReactNode } from "react";
import { useGet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@okouai/ui";
import { CircleHelp } from "lucide-react";
import { remoteControlGuidedEnabled$ } from "../../signals/remote-control-setup.ts";

export function RemoteFieldHelp({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  const enabled = useGet(remoteControlGuidedEnabled$);
  if (!enabled) {
    return null;
  }
  return (
    <Popover>
      <PopoverTrigger
        render={
          <IconButton
            type="button"
            aria-label={title}
            className="size-7 text-muted-foreground"
          />
        }
      >
        <CircleHelp size={16} aria-hidden />
      </PopoverTrigger>
      <PopoverContent className="grid max-h-96 w-80 max-w-[calc(100vw-2rem)] gap-3 overflow-y-auto text-sm leading-6">
        {children}
      </PopoverContent>
    </Popover>
  );
}

export function RemoteAddressHelp({
  route,
}: {
  readonly route:
    "direct" | "tailscale" | "tailscale_ssh" | "cloudflare_access" | "ssh";
}) {
  const { t } = useTranslation();
  return (
    <RemoteFieldHelp
      title={t(($) => {
        return $.remoteConnectionHelp.addressWhere;
      })}
    >
      {route === "tailscale" || route === "tailscale_ssh" ? (
        <>
          <p>
            {t(($) => {
              return $.remoteControlSetup.addressHelp;
            })}
          </p>
          <ul className="grid list-disc gap-3 pl-4">
            <li>
              {t(($) => {
                return $.remoteControlSetup.addressMac;
              })}
            </li>
            <li>
              {t(($) => {
                return $.remoteControlSetup.addressWindows;
              })}
            </li>
            <li>
              {t(($) => {
                return $.remoteControlSetup.addressLinux;
              })}
            </li>
          </ul>
        </>
      ) : route === "cloudflare_access" ? (
        <ul className="grid list-disc gap-3 pl-5 marker:text-muted-foreground">
          <li>
            {t(($) => {
              return $.remoteControlSetup.cfAddressActions;
            })}
          </li>
          <li>
            {t(($) => {
              return $.remoteControlSetup.cfAddressHelp;
            })}
          </li>
          <li className="text-muted-foreground">
            {t(($) => {
              return $.remoteControlSetup.cfAddressMissing;
            })}
          </li>
        </ul>
      ) : route === "ssh" ? (
        <p>
          {t(($) => {
            return $.remoteConnectionHelp.sshAddress;
          })}
        </p>
      ) : (
        <ul className="grid list-disc gap-3 pl-5 marker:text-muted-foreground">
          <li>
            {t(($) => {
              return $.remoteConnectionHelp.directAddress;
            })}
          </li>
          <li className="text-muted-foreground">
            {t(($) => {
              return $.remoteConnectionHelp.homeAddress;
            })}
          </li>
        </ul>
      )}
    </RemoteFieldHelp>
  );
}

export function SshPrivateKeyHelp() {
  const { t } = useTranslation();
  return (
    <RemoteFieldHelp
      title={t(($) => {
        return $.remoteConnectionHelp.privateKeyWhere;
      })}
    >
      <ul className="grid list-disc gap-3 pl-5 marker:text-muted-foreground">
        <li>
          {t(($) => {
            return $.remoteConnectionHelp.privateKeyLocal;
          })}
        </li>
        <li>
          {t(($) => {
            return $.remoteConnectionHelp.privateKeyCloud;
          })}
        </li>
        <li className="text-muted-foreground">
          {t(($) => {
            return $.remoteConnectionHelp.privateKeyMissing;
          })}
        </li>
      </ul>
    </RemoteFieldHelp>
  );
}

export function RemoteConnectionMethodHelp() {
  const { t } = useTranslation();
  const items = [
    [
      t(($) => {
        return $.remoteControlSetup.direct;
      }),
      t(($) => {
        return $.remoteConnectionHelp.directRoute;
      }),
    ],
    [
      t(($) => {
        return $.vnc.transport.ssh;
      }),
      t(($) => {
        return $.remoteConnectionHelp.sshRoute;
      }),
    ],
    [
      t(($) => {
        return $.tailscale.title;
      }),
      t(($) => {
        return $.remoteConnectionHelp.tailscaleRoute;
      }),
    ],
    [
      t(($) => {
        return $.cloudflareAccess.title;
      }),
      t(($) => {
        return $.remoteConnectionHelp.cloudflareRoute;
      }),
    ],
  ];
  return (
    <RemoteFieldHelp
      title={t(($) => {
        return $.remoteConnectionHelp.methodWhere;
      })}
    >
      <dl className="grid gap-3">
        {items.map(([title, description]) => {
          return (
            <div key={title}>
              <dt className="font-medium">{title}</dt>
              <dd className="text-muted-foreground">{description}</dd>
            </div>
          );
        })}
      </dl>
    </RemoteFieldHelp>
  );
}

export function VncPasswordHelp({ apple }: { readonly apple: boolean }) {
  const { t } = useTranslation();
  return (
    <RemoteFieldHelp
      title={t(($) => {
        return $.remoteConnectionHelp.passwordWhere;
      })}
    >
      <ul className="grid list-disc gap-3 pl-5 marker:text-muted-foreground">
        <li>
          {t(($) => {
            return $.remoteConnectionHelp.passwordSource;
          })}
        </li>
        <li>
          {t(($) => {
            return apple
              ? $.remoteConnectionHelp.passwordMac
              : $.remoteConnectionHelp.passwordSoftware;
          })}
        </li>
        <li className="text-muted-foreground">
          {t(($) => {
            return $.remoteConnectionHelp.passwordMissing;
          })}
        </li>
      </ul>
    </RemoteFieldHelp>
  );
}
