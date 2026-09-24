import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ROUTES } from "../../../../signals/route-paths.ts";
import { Link } from "../../../router/link.tsx";
import { CloudflareAccessIcon } from "../cloudflare-access-icon.tsx";
import {
  ConnectorEntryCard,
  ConnectorEntryStatus,
} from "./connector-entry-card.tsx";

export function CloudflareAccessConnectorCard({
  configuredCount,
}: {
  readonly configuredCount: number;
}) {
  const { t } = useTranslation();
  const label = t(($) => {
    return $.cloudflareAccess.title;
  });
  return (
    <ConnectorEntryCard
      icon={<CloudflareAccessIcon size={20} />}
      label={label}
      description={t(($) => {
        return $.cloudflareAccess.description;
      })}
      showDescription={configuredCount === 0}
      interactive
      action={
        <Link
          pathname={ROUTES.connectors}
          options={{
            searchParams: new URLSearchParams({ scope: "private-network" }),
          }}
          aria-label={t(($) => {
            return $.cloudflareAccess.manage;
          })}
          className="absolute inset-0 z-10 cursor-pointer rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
      }
      indicator={
        configuredCount === 0 ? (
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/60 text-muted-foreground"
            aria-hidden="true"
          >
            <Plus size={14} />
          </span>
        ) : null
      }
      status={
        <ConnectorEntryStatus
          tone={configuredCount > 0 ? "success" : "neutral"}
          className="min-w-0 flex-1 text-xs text-muted-foreground"
          label={t(
            ($) => {
              return $.cloudflareAccess.summary;
            },
            { count: configuredCount },
          )}
        />
      }
    />
  );
}
