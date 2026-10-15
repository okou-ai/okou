import { useTranslation } from "react-i18next";
import type { z } from "zod";
import type { vncTransportMetadataSchema } from "@okouai/api-contracts/contracts/vnc-transport";

/** Read only; never infers a Direct route or inner VNC trust from a provider. */
export function VncNativeRoute({
  transport,
}: {
  readonly transport: z.infer<typeof vncTransportMetadataSchema> | undefined;
}) {
  const { t } = useTranslation();
  if (
    !transport ||
    (transport.type !== "cloudflare_access" && transport.type !== "tailscale")
  ) {
    return null;
  }
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
        <span className="break-all">{transport.configId}</span>
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
