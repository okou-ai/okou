import { RemoteNetworkAccessSummary } from "./remote-network-scope.tsx";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Laptop, ChevronRight, Plus } from "lucide-react";
import { Button } from "@okouai/ui";
import type { ScopedCloudflareAccessConfig } from "@okouai/api-contracts/contracts/cloudflare-access";
import { searchParams$, updateSearchParams$ } from "../../signals/route.ts";
import { remoteResourceSearchParams } from "../../signals/remote-resource-detail.ts";
import { Link } from "../router/link.tsx";
import {
  enterRemoteSetup$,
  updateRemoteSetup$,
} from "../../signals/remote-control-setup.ts";
import { REMOTE_PAGE_ACTION } from "./remote-editor-frame.tsx";
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
      <header className="flex items-start justify-between gap-4">
        <div className="grid gap-2">
          <h2 className="text-lg font-semibold">{config.name}</h2>
          <p className="text-sm text-muted-foreground">
            {t(($) => {
              return kind === "tailscale"
                ? $.tailscale.title
                : $.cloudflareAccess.title;
            })}
          </p>
        </div>
        <span className="rounded-md border border-divider px-2 py-1 text-xs text-muted-foreground">
          {t(($) => {
            return config.scope === "personal"
              ? $.cloudflareAccess.personal
              : $.cloudflareAccess.organization;
          })}
        </span>
      </header>
      <RemoteNetworkAccessSummary scope={config.scope} />
      <dl className="grid grid-cols-[7.25rem_minmax(0,1fr)] gap-x-6 gap-y-4 text-sm">
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
  const params = useGet(searchParams$);
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
      {hosts.map((host) => {
        return (
          <Link
            key={`${host.protocol}:${host.id}`}
            pathname="/connectors"
            options={{
              searchParams: remoteResourceSearchParams(
                params,
                host.protocol,
                host.id,
              ),
            }}
            className="flex items-center gap-3 rounded-lg py-3 hover:bg-gray-50"
          >
            <span className="rounded-lg bg-gray-50 p-2">
              <Laptop size={20} aria-hidden />
            </span>
            <span className="grid min-w-0 flex-1 gap-1">
              <span className="truncate text-sm">{host.displayName}</span>
              <span className="text-xs text-muted-foreground">
                {host.protocol.toUpperCase()}
              </span>
            </span>
            <ChevronRight size={16} aria-hidden />
          </Link>
        );
      })}
    </section>
  );
}
export function RemoteNetworkFooter({
  id,
  kind,
}: {
  readonly id: string;
  readonly kind: "tailscale" | "cloudflare";
}) {
  const { t } = useTranslation();
  const params = useGet(searchParams$);
  const navigate = useSet(updateSearchParams$);
  const enter = useSet(enterRemoteSetup$);
  const update = useSet(updateRemoteSetup$);
  return (
    <footer className="flex flex-wrap items-center justify-end gap-4 border-t border-divider pt-5">
      <Button
        className={REMOTE_PAGE_ACTION}
        onClick={() => {
          const next = new URLSearchParams(params);
          next.delete("remoteResource");
          next.set("scope", "remote-control");
          navigate(next);
          enter("ssh");
          update({
            networkId: id,
            route: kind === "tailscale" ? "tailscale" : "cloudflare_access",
            step: kind === "tailscale" ? "address" : "cf-address",
          });
        }}
      >
        <Plus size={16} aria-hidden />
        {t(($) => {
          return $.remoteControlSetup.add;
        })}
      </Button>
    </footer>
  );
}
