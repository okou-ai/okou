import { RemoteNetworkAccessSummary } from "./remote-network-scope.tsx";
import { useTranslation } from "react-i18next";
import type { ScopedCloudflareAccessConfig } from "@okouai/api-contracts/contracts/cloudflare-access";
import {
  Button,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@okouai/ui";
import { Info } from "lucide-react";
export function RemoteNetworkSummary({
  config,
  kind,
  tags,
}: {
  readonly config: ScopedCloudflareAccessConfig;
  readonly kind: "tailscale" | "cloudflare";
  readonly tags?: readonly string[];
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <h2 className="break-words text-lg font-semibold">{config.name}</h2>
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return kind === "tailscale"
              ? $.tailscale.title
              : $.cloudflareAccess.title;
          })}
        </p>
      </header>
      <dl className="grid grid-cols-[7.25rem_minmax(0,1fr)] gap-x-6 gap-y-4 text-sm">
        <RemoteNetworkAccessSummary scope={config.scope} />
        <dt className="text-muted-foreground">
          {t(($) => {
            return $.remoteControlSetup.networkCredentials;
          })}
        </dt>
        <dd>
          {t(($) => {
            return $.remoteControlSetup.securelySaved;
          })}
        </dd>
        {tags && (
          <>
            <dt className="text-muted-foreground">
              {t(($) => {
                return $.remoteControlSetup.allowedTags;
              })}
            </dt>
            <dd className="break-all">{tags.join(", ")}</dd>
          </>
        )}
      </dl>
      <RemoteNetworkConnections config={config} />
    </div>
  );
}
export function RemoteNetworkConnections({
  config,
  showHeading = true,
}: {
  readonly config: ScopedCloudflareAccessConfig;
  readonly showHeading?: boolean;
}) {
  const { t } = useTranslation();
  const hosts = [
    ...config.sshHosts.map((host) => {
      return { ...host, protocol: "ssh" as const };
    }),
    ...config.vncHosts.map((host) => {
      return { ...host, protocol: "vnc" as const };
    }),
  ];
  return (
    <section
      className={
        showHeading ? "grid gap-3 border-y border-divider py-5" : "grid gap-3"
      }
    >
      {showHeading && (
        <h3 className="text-base font-semibold">
          {t(($) => {
            return $.remoteControlSetup.linkedConnections;
          })}
        </h3>
      )}
      {hosts.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.cloudflareAccess.unused;
          })}
        </p>
      )}
      {hosts.length > 0 && (
        <ul
          aria-label={t(($) => {
            return $.remoteControlSetup.linkedConnections;
          })}
          className="grid list-disc gap-2 pl-5 text-sm leading-6 marker:text-muted-foreground"
        >
          {hosts.map((host) => {
            return (
              <li key={`${host.protocol}:${host.id}`} className="break-words">
                {host.displayName}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function RemoteNetworkDeleteAction({
  label,
  disabled,
  compact,
  onClick,
}: {
  readonly label: string;
  readonly disabled: boolean;
  readonly compact: boolean;
  readonly onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant={compact ? "neutral" : "outline"}
        disabled={disabled}
        onClick={onClick}
      >
        {label}
      </Button>
      {disabled && (
        <Popover>
          <PopoverTrigger
            render={
              <IconButton
                type="button"
                aria-label={t(($) => {
                  return $.remoteControlSetup.networkDeleteInfo;
                })}
                className="size-7 text-muted-foreground"
              />
            }
          >
            <Info size={16} aria-hidden />
          </PopoverTrigger>
          <PopoverContent
            aria-label={label}
            className="w-80 max-w-[calc(100vw-2rem)] text-sm leading-6"
          >
            {t(($) => {
              return $.vnc.native.inUse;
            })}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
