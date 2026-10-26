import { useTranslation } from "react-i18next";
import { useLoadable } from "ccstate-react";
import type { z } from "zod";
import type { vncTransportMetadataSchema } from "@okouai/api-contracts/contracts/vnc-transport";
import { cloudflareAccessConfigs$ } from "../../signals/cloudflare-access.ts";
import { tailscaleConfigs$ } from "../../signals/tailscale.ts";

/** Read only; never infers a Direct route or inner VNC trust from a provider. */
export function VncNativeRoute({
  transport,
}: {
  readonly transport: z.infer<typeof vncTransportMetadataSchema> | undefined;
}) {
  const { t } = useTranslation();
  const cloudflare = useLoadable(cloudflareAccessConfigs$);
  const tailscale = useLoadable(tailscaleConfigs$);
  if (
    !transport ||
    (transport.type !== "cloudflare_access" && transport.type !== "tailscale")
  ) {
    return null;
  }
  const networks =
    transport.type === "cloudflare_access" ? cloudflare : tailscale;
  const networkName =
    "configId" in transport && networks.state === "hasData"
      ? networks.data?.find((network) => {
          return network.id === transport.configId;
        })?.name
      : undefined;
  return (
    <span className="grid gap-1 text-sm text-muted-foreground">
      <span>
        {transport.type === "cloudflare_access"
          ? t(($) => {
              return $.cloudflareAccess.title;
            })
          : t(($) => {
              return $.tailscale.title;
            })}
      </span>
      {"configId" in transport && (
        <span className="break-words">
          {networkName ??
            t(($) => {
              return networks.state === "loading"
                ? $.remoteControlSetup.loading
                : networks.state === "hasError"
                  ? $.remoteControlSetup.failedLoad
                  : $.remoteControlSetup.resourceUnavailable;
            })}
        </span>
      )}
      {"needsRebind" in transport && (
        <span role="status">
          {t(($) => {
            return $.vnc.native.needsRebind;
          })}
        </span>
      )}
      {transport.type === "cloudflare_access" && transport.originTls && (
        <span className="break-all">
          {t(($) => {
            return $.vnc.native.originTls;
          })}
          : {transport.originTls.serverName} ·{" "}
          {transport.originTls.trust.mode === "system"
            ? t(($) => {
                return $.vnc.security.system;
              })
            : t(($) => {
                return $.vnc.security.custom;
              })}
        </span>
      )}
    </span>
  );
}
