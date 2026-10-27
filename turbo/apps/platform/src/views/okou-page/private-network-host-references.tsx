import { useTranslation } from "react-i18next";
import { useGet } from "ccstate-react";
import { locale$ } from "../../signals/locale.ts";
import { sortRemoteHosts } from "../../lib/remote-resource-order.ts";
import type { CloudflareAccessConfig } from "@okouai/api-contracts/contracts/cloudflare-access";
import { privateNetworkHostCount } from "../../lib/private-network-references.ts";

export function PrivateNetworkHostReferences({
  config,
}: {
  readonly config: Pick<CloudflareAccessConfig, "sshHosts" | "vncHosts">;
}) {
  const { t } = useTranslation();
  const locale = useGet(locale$);
  const count = privateNetworkHostCount(config);
  return (
    <div className="grid gap-1 text-sm text-muted-foreground">
      <p>
        {count
          ? t(
              ($) => {
                return $.cloudflareAccess.usedBy;
              },
              { count },
            )
          : t(($) => {
              return $.cloudflareAccess.unused;
            })}
      </p>
      {count > 0 && (
        <ul className="list-inside list-disc">
          {sortRemoteHosts(config.sshHosts, locale).map((host) => {
            return (
              <li key={`ssh:${host.id}`}>
                <span>{host.displayName}</span> ·{" "}
                {t(($) => {
                  return $.ssh.label;
                })}
              </li>
            );
          })}
          {sortRemoteHosts(config.vncHosts, locale).map((host) => {
            return (
              <li key={`vnc:${host.id}`}>
                <span>{host.displayName}</span> ·{" "}
                {t(($) => {
                  return $.vnc.label;
                })}{" "}
                ·{" "}
                {host.roles
                  .map((role) => {
                    return role === "rfb"
                      ? t(($) => {
                          return $.vnc.native.rfbRole;
                        })
                      : t(($) => {
                          return $.vnc.native.kdcRole;
                        });
                  })
                  .join(", ")}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
