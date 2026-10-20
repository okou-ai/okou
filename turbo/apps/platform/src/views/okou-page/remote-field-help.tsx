import type { ReactNode } from "react";
import { useGet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@okouai/ui";
import { remoteControlGuidedEnabled$ } from "../../signals/remote-control-setup.ts";

function FieldHelp({
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
        render={<Button type="button" variant="quiet" size="sm" />}
      >
        {title}
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
    <FieldHelp
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
        <>
          <p>
            {t(($) => {
              return $.remoteControlSetup.cfAddressActions;
            })}
          </p>
          <p>
            {t(($) => {
              return $.remoteControlSetup.cfAddressHelp;
            })}
          </p>
          <p className="text-muted-foreground">
            {t(($) => {
              return $.remoteControlSetup.cfAddressMissing;
            })}
          </p>
        </>
      ) : route === "ssh" ? (
        <p>
          {t(($) => {
            return $.remoteConnectionHelp.sshAddress;
          })}
        </p>
      ) : (
        <>
          <p>
            {t(($) => {
              return $.remoteConnectionHelp.directAddress;
            })}
          </p>
          <p className="text-muted-foreground">
            {t(($) => {
              return $.remoteConnectionHelp.homeAddress;
            })}
          </p>
        </>
      )}
    </FieldHelp>
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
    <FieldHelp
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
    </FieldHelp>
  );
}

export function VncPasswordHelp({ apple }: { readonly apple: boolean }) {
  const { t } = useTranslation();
  return (
    <FieldHelp
      title={t(($) => {
        return $.remoteConnectionHelp.passwordWhere;
      })}
    >
      <p>
        {t(($) => {
          return $.remoteConnectionHelp.passwordSource;
        })}
      </p>
      <p>
        {t(($) => {
          return apple
            ? $.remoteConnectionHelp.passwordMac
            : $.remoteConnectionHelp.passwordSoftware;
        })}
      </p>
      <p className="text-muted-foreground">
        {t(($) => {
          return $.remoteConnectionHelp.passwordMissing;
        })}
      </p>
    </FieldHelp>
  );
}

export function VncCertificateHelp() {
  const { t } = useTranslation();
  return (
    <FieldHelp
      title={t(($) => {
        return $.remoteConnectionHelp.certificateWhere;
      })}
    >
      <p>
        {t(($) => {
          return $.remoteConnectionHelp.certificateSource;
        })}
      </p>
      <ol className="grid list-decimal gap-3 pl-4">
        <li>
          {t(($) => {
            return $.remoteConnectionHelp.certificateOpen;
          })}
        </li>
        <li>
          {t(($) => {
            return $.remoteConnectionHelp.certificateName;
          })}
        </li>
        <li>
          {t(($) => {
            return $.remoteConnectionHelp.certificateAsk;
          })}
        </li>
      </ol>
      <p className="text-muted-foreground">
        {t(($) => {
          return $.remoteConnectionHelp.certificateCloudflare;
        })}
      </p>
    </FieldHelp>
  );
}
